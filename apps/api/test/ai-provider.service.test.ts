/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ai provider service behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderService } from '../src/modules/ai/ai-provider.service';

describe('AiProviderService', () => {
  const prisma = {
    user: {
      findUnique: vi.fn(),
    },
    opsMemory: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const configService = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === 'OPENAI_MODEL') {
        return 'gpt-5-mini';
      }
      return fallback;
    }),
  };
  const securityService = {
    encryptJson: vi.fn(),
    decryptJson: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };

  let service: AiProviderService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      id: 'local-admin-id',
    });
    prisma.opsMemory.deleteMany.mockResolvedValue({ count: 0 });
    service = new AiProviderService(
      prisma as never,
      configService as never,
      securityService as never,
      auditService as never,
    );
  });

  it('falls back to legacy ai_provider_v1 metadata without exposing the key', async () => {
    prisma.opsMemory.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'memory-1',
        value: {
          apiKeyEncrypted: 'encrypted-key',
        },
        updatedAt: new Date('2026-03-14T03:00:00.000Z'),
      });

    await expect(service.getProviderConfig()).resolves.toEqual({
      configured: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T03:00:00.000Z',
      openai: {
        apiKeyConfigured: true,
      },
      ollama: null,
    });
  });

  it('builds a neutral runtime handle from legacy OpenAI credentials', async () => {
    prisma.opsMemory.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'memory-1',
        value: {
          apiKeyEncrypted: 'encrypted-key',
        },
        updatedAt: new Date('2026-03-14T03:00:00.000Z'),
      });
    securityService.decryptJson.mockReturnValueOnce({
      apiKey: 'sk-live-123',
    });

    const runtime = await service.getRuntime();

    expect(runtime?.provider).toBe('openai');
    expect(runtime?.model).toBe('gpt-5-mini');
    expect(typeof runtime?.client.generate).toBe('function');
    expect(securityService.decryptJson).toHaveBeenCalledWith('encrypted-key');
  });

  it('stores ai_provider_v2 OpenAI config and writes a secret-safe audit event', async () => {
    securityService.encryptJson.mockReturnValueOnce('encrypted-key');
    prisma.opsMemory.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'memory-1',
        value: {
          schemaVersion: 2,
          provider: 'openai',
          config: {
            apiKeyEncrypted: 'encrypted-key',
          },
        },
        updatedAt: new Date('2026-03-14T03:05:00.000Z'),
      });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'memory-1',
      updatedAt: new Date('2026-03-14T03:05:00.000Z'),
    });

    await expect(
      service.setProviderConfig('user-1', {
        confirm: true,
        provider: 'openai',
        apiKey: 'sk-live-123',
      }),
    ).resolves.toEqual({
      configured: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T03:05:00.000Z',
      openai: {
        apiKeyConfigured: true,
      },
      ollama: null,
    });
    expect(securityService.encryptJson).toHaveBeenCalledWith({ apiKey: 'sk-live-123' });
    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'local-admin-id',
          key: 'ai_provider_v2',
        },
      },
      update: {
        value: {
          schemaVersion: 2,
          provider: 'openai',
          config: {
            apiKeyEncrypted: 'encrypted-key',
          },
        },
      },
      create: {
        userId: 'local-admin-id',
        key: 'ai_provider_v2',
        value: {
          schemaVersion: 2,
          provider: 'openai',
          config: {
            apiKeyEncrypted: 'encrypted-key',
          },
        },
      },
    });
    expect(prisma.opsMemory.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'local-admin-id',
        key: 'ai_provider_v1',
      },
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.provider.update',
      targetType: 'ops_memory',
      targetId: 'memory-1',
      paramsJson: {
        configured: true,
        provider: 'openai',
        model: 'gpt-5-mini',
        replacedPreviousProvider: true,
        ollamaBaseUrl: undefined,
      },
      success: true,
    });
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain('sk-live-123');
  });

  it('writes the cleared sentinel when the provider is removed', async () => {
    prisma.opsMemory.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'memory-1',
        value: {
          schemaVersion: 2,
          provider: null,
          config: null,
        },
        updatedAt: new Date('2026-03-14T03:10:00.000Z'),
      });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'memory-1',
      updatedAt: new Date('2026-03-14T03:10:00.000Z'),
    });

    await expect(
      service.setProviderConfig('user-1', {
        confirm: true,
        provider: 'none',
      }),
    ).resolves.toEqual({
      configured: false,
      provider: null,
      model: null,
      updatedAt: '2026-03-14T03:10:00.000Z',
      openai: null,
      ollama: null,
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.provider.update',
      targetType: 'ops_memory',
      targetId: 'memory-1',
      paramsJson: {
        configured: false,
        provider: null,
        model: null,
        replacedPreviousProvider: false,
        ollamaBaseUrl: undefined,
      },
      success: true,
    });
  });

  it('reports unconfigured status when the installation admin is missing', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(service.getProviderConfig()).resolves.toEqual({
      configured: false,
      provider: null,
      model: null,
      updatedAt: null,
      openai: null,
      ollama: null,
    });
    await expect(service.isConfigured()).resolves.toBe(false);
  });
});
