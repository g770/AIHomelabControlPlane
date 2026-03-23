/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the Ollama-backed neutral AI client.
 */

import { AiRuntimeError } from './ai-runtime.errors';
import { validateGenerateRequest } from './ai-runtime.client';
import { createFetchAiHttpTransport } from './ai-runtime.http';
import {
  extractOllamaErrorSummary,
  mapOllamaModels,
  mapOllamaOutputText,
  mapOllamaUsage,
} from './ollama-ai-client.mappers';
import {
  MIN_OLLAMA_VERSION,
  isOllamaVersionSupported,
  normalizeOllamaBaseUrl,
} from './ollama-ai-client.version';
import type {
  AiCapabilities,
  AiClient,
  AiValidationResult,
  OllamaRuntimeConfig,
} from './ai-runtime.types';

const ollamaCapabilities: AiCapabilities = {
  textGeneration: true,
  modelDiscovery: true,
  configValidation: true,
  reasoningSummary: false,
  usageMetrics: false,
};

export class OllamaAiClient implements AiClient {
  readonly provider = 'ollama' as const;
  readonly model: string;
  readonly capabilities = ollamaCapabilities;

  private readonly baseUrl: string;
  private readonly transport;

  constructor(
    private readonly config: OllamaRuntimeConfig,
    transport = createFetchAiHttpTransport(),
  ) {
    this.model = config.model;
    this.baseUrl = normalizeOllamaBaseUrl(config.baseUrl);
    this.transport = transport;
  }

  async validateConfig(): Promise<AiValidationResult> {
    try {
      const versionResult = await this.transport.getJson(`${this.baseUrl}/api/version`, {
        headers: this.buildHeaders(),
      });
      const version = readVersion(versionResult.json);
      if (versionResult.status >= 400) {
        throw this.createHttpError(versionResult.status);
      }
      if (!version || !isOllamaVersionSupported(version, this.config.minVersion ?? MIN_OLLAMA_VERSION)) {
        return {
          ok: false as const,
          provider: this.provider,
          code: 'unsupported_version',
          message: `Configured Ollama instance is older than ${this.config.minVersion ?? MIN_OLLAMA_VERSION}.`,
        };
      }

      const models = await this.listModelsSafe();
      const availableModelIds = models.map((model) => model.id);
      if (!availableModelIds.includes(this.model)) {
        return {
          ok: false as const,
          provider: this.provider,
          code: 'model_not_found',
          message: 'Selected Ollama model is not available on the configured instance.',
        };
      }

      return {
        ok: true as const,
        provider: this.provider,
        normalizedBaseUrl: this.baseUrl,
        providerVersion: version,
        availableModelIds,
      };
    } catch (error) {
      const runtimeError = toOllamaRuntimeError(error);
      const code: Extract<AiValidationResult, { ok: false }>['code'] =
        runtimeError.code === 'unsupported_capability' ? 'provider_error' : runtimeError.code;
      return {
        ok: false as const,
        provider: this.provider,
        code,
        message: runtimeError.message,
      };
    }
  }

  async listModels() {
    const models = await this.listModelsSafe();
    return {
      supported: true as const,
      provider: this.provider,
      fetchedAt: new Date().toISOString(),
      models,
    };
  }

  async generate(request: Parameters<AiClient['generate']>[0]) {
    const normalizedRequest = validateGenerateRequest(request);

    try {
      const response = await this.transport.postJson(
        `${this.baseUrl}/v1/responses`,
        {
          model: this.model,
          input: normalizedRequest.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(normalizedRequest.maxOutputTokens !== undefined
            ? { max_output_tokens: normalizedRequest.maxOutputTokens }
            : {}),
          ...(normalizedRequest.temperature !== undefined
            ? { temperature: normalizedRequest.temperature }
            : {}),
          ...(normalizedRequest.topP !== undefined ? { top_p: normalizedRequest.topP } : {}),
        },
        {
          headers: this.buildHeaders(),
        },
      );

      if (response.status >= 400) {
        throw this.createHttpError(response.status, extractOllamaErrorSummary(response.json));
      }

      const envelope =
        response.json && typeof response.json === 'object' && !Array.isArray(response.json)
          ? (response.json as Record<string, unknown>)
          : {};
      const status: 'completed' | 'incomplete' | 'failed' =
        envelope.status === 'failed'
          ? 'failed'
          : envelope.status === 'incomplete'
            ? 'incomplete'
            : 'completed';
      const finishReason: 'stop' | 'length' | 'error' =
        status === 'failed' ? 'error' : status === 'incomplete' ? 'length' : 'stop';
      const providerStatus = typeof envelope.status === 'string' ? envelope.status : null;
      const providerError = extractOllamaErrorSummary(response.json);
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
        outputText: mapOllamaOutputText(response.json),
        status,
        finishReason,
        requestId: typeof envelope.id === 'string' ? envelope.id : null,
        reasoningSummary: [],
        usage: mapOllamaUsage(envelope.usage),
        debug,
      };
    } catch (error) {
      throw toOllamaRuntimeError(error);
    }
  }

  private async listModelsSafe() {
    const response = await this.transport.getJson(`${this.baseUrl}/api/tags`, {
      headers: this.buildHeaders(),
    });
    if (response.status >= 400) {
      throw this.createHttpError(response.status);
    }
    return mapOllamaModels(response.json);
  }

  private buildHeaders() {
    return this.config.apiKey
      ? {
          Authorization: `Bearer ${this.config.apiKey}`,
        }
      : undefined;
  }

  private createHttpError(status: number, message?: string | null) {
    if (status === 401 || status === 403) {
      return new AiRuntimeError('auth_failed', 'Ollama rejected the configured token.');
    }
    if (status >= 500) {
      return new AiRuntimeError(
        'provider_unreachable',
        'Failed to reach Ollama at the configured URL.',
      );
    }

    return new AiRuntimeError(
      'provider_error',
      message?.trim() || 'Failed to reach Ollama at the configured URL.',
    );
  }
}

function readVersion(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return typeof record.version === 'string' ? record.version : null;
}

function toOllamaRuntimeError(error: unknown) {
  if (error instanceof AiRuntimeError) {
    return error;
  }

  if (error instanceof Error && /(fetch|network|timeout|connect|ENOTFOUND|ECONNREFUSED)/i.test(error.message)) {
    return new AiRuntimeError(
      'provider_unreachable',
      'Failed to reach Ollama at the configured URL.',
    );
  }

  return new AiRuntimeError('provider_error', 'Failed to reach Ollama at the configured URL.');
}
