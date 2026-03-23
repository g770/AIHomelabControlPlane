/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module defines provider-neutral AI runtime contracts.
 */

export type AiProviderId = 'openai' | 'ollama';

export type AiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AiGenerateRequest = {
  messages: AiMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningSummary?: 'none' | 'auto';
};

export type AiUsageSnapshot = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type AiGenerateResult = {
  provider: AiProviderId;
  model: string;
  outputText: string;
  status: 'completed' | 'incomplete' | 'failed';
  finishReason: 'stop' | 'length' | 'error' | 'unknown';
  requestId: string | null;
  reasoningSummary: string[];
  usage: AiUsageSnapshot | null;
  debug: {
    providerStatus: string | null;
    providerError: string | null;
  } | null;
};

export type AiCapabilities = {
  textGeneration: true;
  modelDiscovery: boolean;
  configValidation: true;
  reasoningSummary: boolean;
  usageMetrics: boolean;
};

export type OpenAiRuntimeConfig = {
  provider: 'openai';
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type OllamaRuntimeConfig = {
  provider: 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  timeoutMs?: number;
  minVersion?: string;
};

export type AiRuntimeConfig = OpenAiRuntimeConfig | OllamaRuntimeConfig;

export type AiValidationResult =
  | {
      ok: true;
      provider: AiProviderId;
      normalizedBaseUrl?: string;
      providerVersion?: string | null;
      availableModelIds?: string[] | null;
    }
  | {
      ok: false;
      provider: AiProviderId;
      code:
        | 'invalid_config'
        | 'auth_failed'
        | 'provider_unreachable'
        | 'unsupported_version'
        | 'model_not_found'
        | 'provider_error';
      message: string;
    };

export type AiModelInfo = {
  id: string;
  modifiedAt: string | null;
  sizeBytes: number | null;
  family: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
};

export type AiModelDiscoveryResult =
  | {
      supported: true;
      provider: AiProviderId;
      fetchedAt: string;
      models: AiModelInfo[];
    }
  | {
      supported: false;
      provider: AiProviderId;
      fetchedAt: string;
      models: AiModelInfo[];
    };

export interface AiClient {
  readonly provider: AiProviderId;
  readonly model: string;
  readonly capabilities: AiCapabilities;

  validateConfig(): Promise<AiValidationResult>;
  listModels(): Promise<AiModelDiscoveryResult>;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}

export type AiHttpTransport = {
  getJson(url: string, init?: RequestInit): Promise<{ status: number; json: unknown }>;
  postJson(
    url: string,
    body: unknown,
    init?: RequestInit,
  ): Promise<{ status: number; json: unknown }>;
};

export type OpenAiClientFactory = (config: {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
}) => {
  responses: {
    create(input: Record<string, unknown>): Promise<unknown>;
  };
  models?: {
    retrieve(model: string): Promise<unknown>;
  };
};
