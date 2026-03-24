/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ai personality controller int test behavior.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiController } from '../src/modules/ai/ai.controller';
import { AiProviderService } from '../src/modules/ai/ai-provider.service';
import { AiUsageService } from '../src/modules/ai/ai-usage.service';
import { AiService } from '../src/modules/ai/ai.service';

describe('AiController personality endpoints (integration)', () => {
  let app: NestFastifyApplication;
  let currentUser: { sub: string; email: string; displayName: string };

  const aiServiceMock = {
    status: vi.fn(),
    getPersonality: vi.fn(),
    setPersonality: vi.fn(),
  };
  const aiProviderServiceMock = {
    getProviderConfig: vi.fn(),
    setProviderConfig: vi.fn(),
    listAvailableModels: vi.fn(),
    discoverAvailableModels: vi.fn(),
  };
  const aiUsageServiceMock = {
    getUsageConfig: vi.fn(),
    setUsageConfig: vi.fn(),
    getUsageSummary: vi.fn(),
    refreshUsage: vi.fn(),
  };

  @Module({
    controllers: [AiController],
    providers: [
      {
        provide: AiService,
        useValue: aiServiceMock,
      },
      {
        provide: AiProviderService,
        useValue: aiProviderServiceMock,
      },
      {
        provide: AiUsageService,
        useValue: aiUsageServiceMock,
      },
    ],
  })
  class TestAiPersonalityModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAiPersonalityModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', (request: any, _reply: any, done: () => void) => {
        request.user = currentUser;
        done();
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = {
      sub: 'user-456',
      email: 'admin@local',
      displayName: 'Admin',
    };
  });

  it('GET /api/ai/personality returns the active personality for the authenticated admin', async () => {
    aiServiceMock.getPersonality.mockResolvedValueOnce({
      personality: 'Be concise and operational.',
      isCustom: true,
      updatedAt: '2026-02-20T16:30:00.000Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/personality',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiServiceMock.getPersonality).toHaveBeenCalledWith('user-456');
    expect(body).toMatchObject({
      personality: 'Be concise and operational.',
      isCustom: true,
    });
  });

  it('GET /api/ai/provider returns safe provider metadata', async () => {
    aiProviderServiceMock.getProviderConfig.mockResolvedValueOnce({
      configured: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T02:30:00.000Z',
      openai: {
        apiKeyConfigured: true,
      },
      ollama: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/provider',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiProviderServiceMock.getProviderConfig).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      configured: true,
      model: 'gpt-5-mini',
    });
    expect(body).not.toHaveProperty('apiKey');
  });

  it('PUT /api/ai/provider validates confirmation and forwards the requested key update', async () => {
    aiProviderServiceMock.setProviderConfig.mockResolvedValueOnce({
      configured: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T02:40:00.000Z',
      openai: {
        apiKeyConfigured: true,
      },
      ollama: null,
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/provider',
      payload: {
        confirm: true,
        provider: 'openai',
        apiKey: 'sk-live-123',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(aiProviderServiceMock.setProviderConfig).toHaveBeenCalledWith('user-456', {
      confirm: true,
      provider: 'openai',
      apiKey: 'sk-live-123',
    });
  });

  it('GET /api/ai/provider/models returns provider discovery metadata', async () => {
    aiProviderServiceMock.listAvailableModels.mockResolvedValueOnce({
      provider: 'ollama',
      supported: true,
      fetchedAt: '2026-03-23T12:00:00.000Z',
      models: [
        {
          id: 'qwen3:8b',
          modifiedAt: '2026-03-23T11:55:00.000Z',
          sizeBytes: 5234567890,
          family: 'qwen3',
          parameterSize: '8B',
          quantizationLevel: 'Q4_K_M',
        },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/provider/models',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiProviderServiceMock.listAvailableModels).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      provider: 'ollama',
      supported: true,
    });
  });

  it('POST /api/ai/provider/models/discover forwards draft Ollama discovery input', async () => {
    aiProviderServiceMock.discoverAvailableModels.mockResolvedValueOnce({
      provider: 'ollama',
      supported: true,
      fetchedAt: '2026-03-23T12:05:00.000Z',
      models: [
        {
          id: 'qwen3.5:latest',
          modifiedAt: '2026-03-23T12:00:00.000Z',
          sizeBytes: 6594474711,
          family: 'qwen35',
          parameterSize: '9.7B',
          quantizationLevel: 'Q4_K_M',
        },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/provider/models/discover',
      payload: {
        provider: 'ollama',
        baseUrl: 'http://192.168.3.120:11434',
        apiKey: null,
      },
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiProviderServiceMock.discoverAvailableModels).toHaveBeenCalledWith({
      provider: 'ollama',
      baseUrl: 'http://192.168.3.120:11434',
      apiKey: null,
    });
    expect(body).toMatchObject({
      provider: 'ollama',
      supported: true,
    });
  });

  it('GET /api/ai/usage-config returns safe telemetry metadata', async () => {
    aiUsageServiceMock.getUsageConfig.mockResolvedValueOnce({
      configured: true,
      projectIds: ['proj_123'],
      updatedAt: '2026-03-23T12:00:00.000Z',
      lastRefreshAttemptAt: '2026-03-23T12:10:00.000Z',
      lastRefreshSucceededAt: '2026-03-23T12:09:00.000Z',
      lastRefreshError: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/usage-config',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiUsageServiceMock.getUsageConfig).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      configured: true,
      projectIds: ['proj_123'],
    });
    expect(body).not.toHaveProperty('adminApiKey');
  });

  it('PUT /api/ai/usage-config validates confirmation and forwards payload', async () => {
    aiUsageServiceMock.setUsageConfig.mockResolvedValueOnce({
      configured: true,
      projectIds: ['proj_123'],
      updatedAt: '2026-03-23T12:00:00.000Z',
      lastRefreshAttemptAt: null,
      lastRefreshSucceededAt: null,
      lastRefreshError: null,
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/usage-config',
      payload: {
        confirm: true,
        adminApiKey: 'sk-admin-123',
        projectIds: ['proj_123'],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(aiUsageServiceMock.setUsageConfig).toHaveBeenCalledWith('user-456', {
      confirm: true,
      adminApiKey: 'sk-admin-123',
      projectIds: ['proj_123'],
    });
  });

  it('GET /api/ai/usage-summary validates the window and forwards it as a number', async () => {
    aiUsageServiceMock.getUsageSummary.mockResolvedValueOnce({
      configured: true,
      projectIds: [],
      windowDays: 7,
      lastRefreshAttemptAt: '2026-03-23T12:10:00.000Z',
      lastRefreshSucceededAt: '2026-03-23T12:09:00.000Z',
      lastRefreshError: null,
      snapshot: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/usage-summary?windowDays=7',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(aiUsageServiceMock.getUsageSummary).toHaveBeenCalledWith(7);
  });

  it('POST /api/ai/usage-refresh validates confirmation and forwards the refresh request', async () => {
    aiUsageServiceMock.refreshUsage.mockResolvedValueOnce({
      ok: true,
      syncedAt: '2026-03-23T12:11:00.000Z',
      lastRefreshAttemptAt: '2026-03-23T12:10:00.000Z',
      lastRefreshSucceededAt: '2026-03-23T12:11:00.000Z',
      lastRefreshError: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/usage-refresh',
      payload: {
        confirm: true,
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(aiUsageServiceMock.refreshUsage).toHaveBeenCalledWith('user-456');
  });

  it('PUT /api/ai/personality validates confirmation and forwards payload', async () => {
    aiServiceMock.setPersonality.mockResolvedValueOnce({
      personality: 'Focus on alerts first.',
      isCustom: true,
      updatedAt: '2026-02-20T16:40:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/personality',
      payload: {
        confirm: true,
        personality: 'Focus on alerts first.',
      },
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode, response.body).toBe(200);
    expect(aiServiceMock.setPersonality).toHaveBeenCalledWith('user-456', 'Focus on alerts first.');
    expect(body).toMatchObject({
      personality: 'Focus on alerts first.',
      isCustom: true,
    });
  });

  it('PUT /api/ai/personality rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/personality',
      payload: {
        personality: 'missing confirm should fail',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(aiServiceMock.setPersonality).not.toHaveBeenCalled();
  });

  it('PUT /api/ai/provider rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/provider',
      payload: {
        apiKey: 'missing confirm should fail',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(aiProviderServiceMock.setProviderConfig).not.toHaveBeenCalled();
  });

  it('GET /api/ai/usage-summary rejects unsupported windows', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ai/usage-summary?windowDays=14',
    });

    expect(response.statusCode).toBe(400);
    expect(aiUsageServiceMock.getUsageSummary).not.toHaveBeenCalled();
  });

  it('PUT /api/ai/usage-config rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/ai/usage-config',
      payload: {
        projectIds: ['proj_123'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(aiUsageServiceMock.setUsageConfig).not.toHaveBeenCalled();
  });

  it('POST /api/ai/usage-refresh rejects invalid payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/usage-refresh',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(aiUsageServiceMock.refreshUsage).not.toHaveBeenCalled();
  });
});
