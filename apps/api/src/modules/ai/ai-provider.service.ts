/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements ai provider service business logic for the service layer.
 */
import { BadRequestException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  aiProviderConfigResponseSchema,
  aiProviderModelsResponseSchema,
  type AiProviderConfigUpdate,
  type AiProviderModelsDiscoverRequest,
} from '@homelab/shared';
import { AuditService } from '../audit/audit.service';
import { SecurityService } from '../common/security.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LOCAL_ADMIN_EMAIL } from '../auth/admin-account';
import { createAiRuntimeClient, normalizeOllamaBaseUrl, type AiClient } from './runtime';

const AI_PROVIDER_V1_MEMORY_KEY = 'ai_provider_v1';
const AI_PROVIDER_V2_MEMORY_KEY = 'ai_provider_v2';
const OLLAMA_DISCOVERY_MODEL_ID = '__ollama_model_discovery__';

type ConfigOwner = {
  id: string;
};

type ResolvedProviderState =
  | {
      provider: null;
      updatedAt: Date | null;
      source: 'missing' | 'v2';
    }
  | {
      provider: 'openai';
      updatedAt: Date | null;
      source: 'v1' | 'v2';
      apiKeyEncrypted: string;
    }
  | {
      provider: 'ollama';
      updatedAt: Date | null;
      source: 'v2';
      baseUrl: string;
      model: string;
      apiKeyEncrypted: string | null;
    };

export type AiRuntimeHandle = {
  provider: 'openai' | 'ollama';
  model: string;
  client: AiClient;
};

@Injectable()
/**
 * Implements the ai provider service class.
 */
export class AiProviderService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    private readonly securityService: SecurityService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Gets provider config.
   */
  async getProviderConfig() {
    const stored = await this.readStoredProviderState();

    if (stored.provider === 'openai') {
      return aiProviderConfigResponseSchema.parse({
        configured: true,
        provider: 'openai',
        model: this.getOpenAiModel(),
        updatedAt: stored.updatedAt?.toISOString() ?? null,
        openai: {
          apiKeyConfigured: true,
        },
        ollama: null,
      });
    }

    if (stored.provider === 'ollama') {
      return aiProviderConfigResponseSchema.parse({
        configured: true,
        provider: 'ollama',
        model: stored.model,
        updatedAt: stored.updatedAt?.toISOString() ?? null,
        openai: null,
        ollama: {
          baseUrl: stored.baseUrl,
          apiKeyConfigured: Boolean(stored.apiKeyEncrypted),
        },
      });
    }

    return aiProviderConfigResponseSchema.parse({
      configured: false,
      provider: null,
      model: null,
      updatedAt: stored.updatedAt?.toISOString() ?? null,
      openai: null,
      ollama: null,
    });
  }

  /**
   * Checks whether configured.
   */
  async isConfigured() {
    const record = await this.readStoredProviderState();
    return record.provider !== null;
  }

  /**
   * Returns neutral runtime handle for the active provider.
   */
  async getRuntime(): Promise<AiRuntimeHandle | null> {
    const stored = await this.readStoredProviderState();
    if (stored.provider === null) {
      return null;
    }

    if (stored.provider === 'openai') {
      const apiKey = this.decryptApiKey(stored.apiKeyEncrypted);
      if (!apiKey) {
        return null;
      }

      return {
        provider: 'openai',
        model: this.getOpenAiModel(),
        client: createAiRuntimeClient({
          provider: 'openai',
          apiKey,
          model: this.getOpenAiModel(),
          baseUrl: this.getOpenAiBaseUrl(),
        }),
      };
    }

    return {
      provider: 'ollama',
      model: stored.model,
      client: createAiRuntimeClient({
        provider: 'ollama',
        baseUrl: stored.baseUrl,
        model: stored.model,
        apiKey: stored.apiKeyEncrypted ? this.decryptApiKey(stored.apiKeyEncrypted) : null,
      }),
    };
  }

  /**
   * Lists available models for the active provider.
   */
  async listAvailableModels() {
    const runtime = await this.getRuntime();
    if (!runtime) {
      throw new BadRequestException('AI provider is not configured.');
    }

    if (runtime.provider === 'openai') {
      return aiProviderModelsResponseSchema.parse({
        provider: 'openai',
        supported: false,
        fetchedAt: new Date().toISOString(),
        models: [],
      });
    }

    return aiProviderModelsResponseSchema.parse(await runtime.client.listModels());
  }

  /**
   * Discovers available models for a draft provider configuration without saving it.
   */
  async discoverAvailableModels(input: AiProviderModelsDiscoverRequest) {
    const baseUrl = normalizeOllamaBaseUrl(input.baseUrl);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const client = createAiRuntimeClient({
      provider: 'ollama',
      baseUrl,
      model: OLLAMA_DISCOVERY_MODEL_ID,
      apiKey: apiKey || null,
    });

    return aiProviderModelsResponseSchema.parse(await client.listModels());
  }

  /**
   * Sets provider config.
   */
  async setProviderConfig(userId: string, update: AiProviderConfigUpdate) {
    if (update.provider === 'none') {
      return this.clearProviderConfig(userId);
    }

    if (update.provider === 'openai') {
      const apiKey = update.apiKey.trim();
      if (!apiKey) {
        throw new BadRequestException('OpenAI API key is required.');
      }

      return this.persistProviderState(userId, {
        provider: 'openai',
        config: {
          apiKeyEncrypted: this.securityService.encryptJson({ apiKey }),
        },
      });
    }

    const baseUrl = normalizeOllamaBaseUrl(update.baseUrl);
    const model = update.model.trim();
    if (!model) {
      throw new BadRequestException('Ollama model is required.');
    }

    const apiKey = typeof update.apiKey === 'string' ? update.apiKey.trim() : '';
    const validationClient = createAiRuntimeClient({
      provider: 'ollama',
      baseUrl,
      model,
      apiKey: apiKey || null,
    });
    const validation = await validationClient.validateConfig();
    if (!validation.ok) {
      throw new BadRequestException(validation.message);
    }

    return this.persistProviderState(userId, {
      provider: 'ollama',
      config: {
        baseUrl,
        model,
        apiKeyEncrypted: apiKey ? this.securityService.encryptJson({ apiKey }) : null,
      },
    });
  }

  /**
   * Clears provider config.
   */
  async clearProviderConfig(userId: string) {
    return this.persistProviderState(userId, {
      provider: null,
      config: null,
    });
  }

  /**
   * Gets configured OpenAI model.
   */
  private getOpenAiModel() {
    return this.configService.get<string>('OPENAI_MODEL', 'gpt-5-mini');
  }

  /**
   * Gets configured OpenAI base URL if one exists.
   */
  private getOpenAiBaseUrl() {
    const value = this.configService.get<string>('OPENAI_BASE_URL');
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  /**
   * Persists ai_provider_v2 and removes any legacy ai_provider_v1 state.
   */
  private async persistProviderState(
    actorUserId: string,
    nextState:
      | {
          provider: 'openai';
          config: {
            apiKeyEncrypted: string;
          };
        }
      | {
          provider: 'ollama';
          config: {
            baseUrl: string;
            model: string;
            apiKeyEncrypted: string | null;
          };
        }
      | {
          provider: null;
          config: null;
        },
  ) {
    const owner = await this.findConfigOwner();
    if (!owner) {
      throw new InternalServerErrorException('Local admin account not initialized');
    }

    const previous = await this.readStoredProviderState(owner);
    const saved = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId: owner.id,
          key: AI_PROVIDER_V2_MEMORY_KEY,
        },
      },
      update: {
        value: {
          schemaVersion: 2,
          provider: nextState.provider,
          config: nextState.config,
        } as Prisma.InputJsonValue,
      },
      create: {
        userId: owner.id,
        key: AI_PROVIDER_V2_MEMORY_KEY,
        value: {
          schemaVersion: 2,
          provider: nextState.provider,
          config: nextState.config,
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.opsMemory.deleteMany({
      where: {
        userId: owner.id,
        key: AI_PROVIDER_V1_MEMORY_KEY,
      },
    });

    await this.auditService.write({
      actorUserId,
      action: 'ai.provider.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        configured: nextState.provider !== null,
        provider: nextState.provider,
        model:
          nextState.provider === 'openai'
            ? this.getOpenAiModel()
            : nextState.provider === 'ollama'
              ? nextState.config.model
              : null,
        replacedPreviousProvider: previous.provider !== nextState.provider,
        ollamaBaseUrl: nextState.provider === 'ollama' ? nextState.config.baseUrl : undefined,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return this.getProviderConfig();
  }

  /**
   * Reads the current provider state with legacy fallback.
   */
  private async readStoredProviderState(ownerOverride?: ConfigOwner | null): Promise<ResolvedProviderState> {
    const owner = ownerOverride ?? (await this.findConfigOwner());
    if (!owner) {
      return {
        provider: null,
        updatedAt: null,
        source: 'missing',
      };
    }

    const v2Record = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId: owner.id,
          key: AI_PROVIDER_V2_MEMORY_KEY,
        },
      },
      select: {
        value: true,
        updatedAt: true,
      },
    });
    const parsedV2 = readProviderV2Value(v2Record?.value);
    if (parsedV2) {
      if (parsedV2.provider === 'openai') {
        return {
          provider: 'openai',
          updatedAt: v2Record?.updatedAt ?? null,
          source: 'v2',
          apiKeyEncrypted: parsedV2.config.apiKeyEncrypted,
        };
      }

      if (parsedV2.provider === 'ollama') {
        return {
          provider: 'ollama',
          updatedAt: v2Record?.updatedAt ?? null,
          source: 'v2',
          baseUrl: parsedV2.config.baseUrl,
          model: parsedV2.config.model,
          apiKeyEncrypted: parsedV2.config.apiKeyEncrypted,
        };
      }

      return {
        provider: null,
        updatedAt: v2Record?.updatedAt ?? null,
        source: 'v2',
      };
    }

    const legacyRecord = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId: owner.id,
          key: AI_PROVIDER_V1_MEMORY_KEY,
        },
      },
      select: {
        value: true,
        updatedAt: true,
      },
    });
    const legacyKey = readLegacyApiKeyEncrypted(legacyRecord?.value);
    if (legacyKey) {
      return {
        provider: 'openai',
        updatedAt: legacyRecord?.updatedAt ?? null,
        source: 'v1',
        apiKeyEncrypted: legacyKey,
      };
    }

    return {
      provider: null,
      updatedAt: null,
      source: 'missing',
    };
  }

  /**
   * Decrypts a stored API key.
   */
  private decryptApiKey(apiKeyEncrypted: string) {
    const decrypted = this.securityService.decryptJson<{ apiKey?: string }>(apiKeyEncrypted);
    const apiKey = typeof decrypted.apiKey === 'string' ? decrypted.apiKey.trim() : '';
    return apiKey.length > 0 ? apiKey : null;
  }

  /**
   * Finds the local admin owner record for installation-wide settings.
   */
  private findConfigOwner() {
    return this.prisma.user.findUnique({
      where: { email: LOCAL_ADMIN_EMAIL },
      select: {
        id: true,
      },
    });
  }
}

function readProviderV2Value(value: Prisma.JsonValue | null | undefined) {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    return null;
  }

  if (value.provider === null) {
    return {
      provider: null,
      config: null,
    };
  }

  if (value.provider === 'openai' && isRecord(value.config)) {
    const apiKeyEncrypted = toNonEmptyString(value.config.apiKeyEncrypted);
    if (!apiKeyEncrypted) {
      return null;
    }

    return {
      provider: 'openai' as const,
      config: {
        apiKeyEncrypted,
      },
    };
  }

  if (value.provider === 'ollama' && isRecord(value.config)) {
    const baseUrl = toNonEmptyString(value.config.baseUrl);
    const model = toNonEmptyString(value.config.model);
    const apiKeyEncrypted = toOptionalString(value.config.apiKeyEncrypted);
    if (!baseUrl || !model) {
      return null;
    }

    return {
      provider: 'ollama' as const,
      config: {
        baseUrl,
        model,
        apiKeyEncrypted,
      },
    };
  }

  return null;
}

function readLegacyApiKeyEncrypted(value: Prisma.JsonValue | null | undefined) {
  if (!isRecord(value)) {
    return null;
  }

  return toNonEmptyString(value.apiKeyEncrypted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toOptionalString(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  return toNonEmptyString(value);
}
