/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the OpenAI-backed neutral AI client.
 */

import OpenAI from 'openai';
import { AiRuntimeError } from './ai-runtime.errors';
import {
  buildMessageInput,
  normalizeFinishReason,
  normalizeStatus,
  parseUsageSnapshot,
  validateGenerateRequest,
} from './ai-runtime.client';
import type {
  AiCapabilities,
  AiClient,
  AiGenerateRequest,
  OpenAiClientFactory,
  OpenAiRuntimeConfig,
} from './ai-runtime.types';

const openAiCapabilities: AiCapabilities = {
  textGeneration: true,
  modelDiscovery: false,
  configValidation: true,
  reasoningSummary: true,
  usageMetrics: true,
};

export class OpenAiClient implements AiClient {
  readonly provider = 'openai' as const;
  readonly model: string;
  readonly capabilities = openAiCapabilities;

  private readonly client: ReturnType<OpenAiClientFactory>;

  constructor(
    private readonly config: OpenAiRuntimeConfig,
    clientFactory: OpenAiClientFactory = defaultOpenAiClientFactory,
  ) {
    this.model = config.model;
    this.client = clientFactory({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
    });
  }

  async validateConfig() {
    try {
      if (!this.client.models?.retrieve) {
        return {
          ok: true as const,
          provider: this.provider,
        };
      }

      await this.client.models.retrieve(this.model);
      return {
        ok: true as const,
        provider: this.provider,
      };
    } catch (error) {
      const runtimeError = toOpenAiRuntimeError(error, true);
      return {
        ok: false as const,
        provider: this.provider,
        code: runtimeError.code === 'unsupported_capability' ? 'provider_error' : runtimeError.code,
        message: runtimeError.message,
      };
    }
  }

  async listModels() {
    return {
      supported: false as const,
      provider: this.provider,
      fetchedAt: new Date().toISOString(),
      models: [],
    };
  }

  async generate(request: AiGenerateRequest) {
    const normalizedRequest = validateGenerateRequest(request);

    try {
      const response = (await this.client.responses.create({
        model: this.model,
        input: buildMessageInput(normalizedRequest.messages),
        ...(normalizedRequest.maxOutputTokens !== undefined
          ? { max_output_tokens: normalizedRequest.maxOutputTokens }
          : {}),
        ...(normalizedRequest.temperature !== undefined
          ? { temperature: normalizedRequest.temperature }
          : {}),
        ...(normalizedRequest.topP !== undefined ? { top_p: normalizedRequest.topP } : {}),
        ...(normalizedRequest.reasoningSummary === 'auto'
          ? {
              reasoning: {
                summary: 'auto',
              },
            }
          : {}),
      })) as Record<string, unknown>;

      const providerStatus = typeof response.status === 'string' ? response.status : null;
      const providerError = extractProviderError(response.error);
      const debug =
        providerStatus || providerError
          ? {
              providerStatus,
              providerError,
            }
          : null;

      return {
        provider: this.provider,
        model: this.model,
        outputText: typeof response.output_text === 'string' ? response.output_text : '',
        status: normalizeStatus(response.status),
        finishReason: normalizeFinishReason(response.status, response.error),
        requestId: typeof response.id === 'string' ? response.id : null,
        reasoningSummary: extractReasoningSummary(response.output),
        usage: parseUsageSnapshot(response.usage),
        debug,
      };
    } catch (error) {
      throw toOpenAiRuntimeError(error, false);
    }
  }
}

function defaultOpenAiClientFactory(config: {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
}) {
  return new OpenAI(config) as unknown as ReturnType<OpenAiClientFactory>;
}

function extractReasoningSummary(output: unknown) {
  if (!Array.isArray(output)) {
    return [] as string[];
  }

  const lines: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (record.type !== 'reasoning' || !Array.isArray(record.summary)) {
      continue;
    }

    for (const part of record.summary) {
      if (
        part &&
        typeof part === 'object' &&
        !Array.isArray(part) &&
        typeof (part as Record<string, unknown>).text === 'string'
      ) {
        lines.push((part as Record<string, unknown>).text as string);
      }
    }
  }

  return lines;
}

function extractProviderError(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const error = value as Record<string, unknown>;
  return typeof error.message === 'string'
    ? error.message
    : typeof error.code === 'string'
      ? error.code
      : null;
}

function toOpenAiRuntimeError(error: unknown, validation: boolean) {
  if (error instanceof AiRuntimeError) {
    return error;
  }

  const status =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>).status
      : null;

  if (status === 401 || status === 403) {
    return new AiRuntimeError('auth_failed', 'Invalid OpenAI API key.');
  }
  if (validation && status === 404) {
    return new AiRuntimeError(
      'model_not_found',
      'Configured OpenAI model is not available to this credential.',
    );
  }
  if (error instanceof Error && /(fetch|network|timeout|connect|ENOTFOUND|ECONNREFUSED)/i.test(error.message)) {
    return new AiRuntimeError('provider_unreachable', 'OpenAI could not be reached.');
  }

  return new AiRuntimeError('provider_error', 'OpenAI request failed.');
}
