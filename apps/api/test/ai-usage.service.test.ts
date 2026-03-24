/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies OpenAI usage telemetry storage and refresh behavior.
 */
import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageService } from '../src/modules/ai/ai-usage.service';

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  };
}

describe('AiUsageService', () => {
  const prisma = {
    user: {
      findUnique: vi.fn(),
    },
    opsMemory: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const configService = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === 'OPENAI_ADMIN_BASE_URL') {
        return 'https://api.openai.com';
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

  let service: AiUsageService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T12:00:00.000Z'));
    prisma.user.findUnique.mockResolvedValue({
      id: 'local-admin-id',
    });
    service = new AiUsageService(
      prisma as never,
      configService as never,
      securityService as never,
      auditService as never,
    );
    fetchMock = vi.fn();
    (service as any).fetchImpl = fetchMock;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores telemetry config, clears cached snapshots, and audits without leaking the admin key', async () => {
    securityService.encryptJson.mockReturnValueOnce('encrypted-admin-key');
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'telemetry-1',
      updatedAt: new Date('2026-03-23T12:00:00.000Z'),
    });
    prisma.opsMemory.deleteMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      service.setUsageConfig('user-1', {
        confirm: true,
        adminApiKey: 'sk-admin-live',
        projectIds: [' proj_123 ', 'proj_456', 'proj_123'],
      }),
    ).resolves.toEqual({
      configured: true,
      projectIds: ['proj_123', 'proj_456'],
      updatedAt: '2026-03-23T12:00:00.000Z',
      lastRefreshAttemptAt: null,
      lastRefreshSucceededAt: null,
      lastRefreshError: null,
    });

    expect(prisma.opsMemory.upsert).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'local-admin-id',
          key: 'ai_usage_telemetry_v1',
        },
      },
      update: {
        value: {
          adminKeyEncrypted: 'encrypted-admin-key',
          projectIds: ['proj_123', 'proj_456'],
          lastRefreshAttemptAt: null,
          lastRefreshSucceededAt: null,
          lastRefreshError: null,
        },
      },
      create: {
        userId: 'local-admin-id',
        key: 'ai_usage_telemetry_v1',
        value: {
          adminKeyEncrypted: 'encrypted-admin-key',
          projectIds: ['proj_123', 'proj_456'],
          lastRefreshAttemptAt: null,
          lastRefreshSucceededAt: null,
          lastRefreshError: null,
        },
      },
    });
    expect(prisma.opsMemory.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'local-admin-id',
        key: 'ai_usage_snapshot_v1',
      },
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.usage.config.update',
      targetType: 'ops_memory',
      targetId: 'telemetry-1',
      paramsJson: {
        configured: true,
        projectIdCount: 2,
      },
      success: true,
    });
    expect(JSON.stringify(auditService.write.mock.calls[0]?.[0])).not.toContain('sk-admin-live');
  });

  it('trims the cached summary to the requested window without mutating stored scope metadata', async () => {
    prisma.opsMemory.findUnique
      .mockResolvedValueOnce({
        id: 'telemetry-1',
        updatedAt: new Date('2026-03-23T12:00:00.000Z'),
        value: {
          adminKeyEncrypted: 'encrypted-admin-key',
          projectIds: ['proj_123'],
          lastRefreshAttemptAt: '2026-03-23T11:59:00.000Z',
          lastRefreshSucceededAt: '2026-03-23T11:58:00.000Z',
          lastRefreshError: null,
        },
      })
      .mockResolvedValueOnce({
        value: {
          source: 'openai_admin_api',
          coverage: {
            spendSource: 'organization.costs',
            usageSources: ['organization.usage.completions'],
            usageScope: 'text_generation',
          },
          windowDays: 90,
          scope: {
            projectIds: ['proj_123'],
          },
          syncedAt: '2026-03-23T11:58:00.000Z',
          currency: 'usd',
          totals: {
            spendTotal: 36,
            spendToday: 8,
            spendMonthToDate: 36,
            requests: 36,
            inputTokens: 360,
            outputTokens: 180,
            cachedInputTokens: 72,
          },
          series: {
            dailySpend: [
              { date: '2026-03-16', amount: 1 },
              { date: '2026-03-17', amount: 2 },
              { date: '2026-03-18', amount: 3 },
              { date: '2026-03-19', amount: 4 },
              { date: '2026-03-20', amount: 5 },
              { date: '2026-03-21', amount: 6 },
              { date: '2026-03-22', amount: 7 },
              { date: '2026-03-23', amount: 8 },
            ],
            dailyUsage: [
              { date: '2026-03-16', requests: 1, inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
              { date: '2026-03-17', requests: 2, inputTokens: 20, outputTokens: 10, cachedInputTokens: 4 },
              { date: '2026-03-18', requests: 3, inputTokens: 30, outputTokens: 15, cachedInputTokens: 6 },
              { date: '2026-03-19', requests: 4, inputTokens: 40, outputTokens: 20, cachedInputTokens: 8 },
              { date: '2026-03-20', requests: 5, inputTokens: 50, outputTokens: 25, cachedInputTokens: 10 },
              { date: '2026-03-21', requests: 6, inputTokens: 60, outputTokens: 30, cachedInputTokens: 12 },
              { date: '2026-03-22', requests: 7, inputTokens: 70, outputTokens: 35, cachedInputTokens: 14 },
              { date: '2026-03-23', requests: 8, inputTokens: 80, outputTokens: 40, cachedInputTokens: 16 },
            ],
          },
          breakdowns: {
            byModel: [],
            byProject: [],
            byLineItem: [],
          },
        },
      });

    const summary = await service.getUsageSummary(7);

    expect(summary.projectIds).toEqual(['proj_123']);
    expect(summary.snapshot?.windowDays).toBe(7);
    expect(summary.snapshot?.scope.projectIds).toEqual(['proj_123']);
    expect(summary.snapshot?.series.dailySpend).toHaveLength(7);
    expect(summary.snapshot?.series.dailyUsage).toHaveLength(7);
    expect(summary.snapshot?.totals.spendTotal).toBe(35);
    expect(summary.snapshot?.totals.requests).toBe(35);
    expect(summary.snapshot?.totals.inputTokens).toBe(350);
    expect(summary.snapshot?.totals.outputTokens).toBe(175);
    expect(summary.snapshot?.totals.cachedInputTokens).toBe(70);
  });

  it('refreshes usage data through paginated admin endpoints and stores a normalized snapshot', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'telemetry-1',
      updatedAt: new Date('2026-03-23T11:55:00.000Z'),
      value: {
        adminKeyEncrypted: 'encrypted-admin-key',
        projectIds: ['proj_123'],
        lastRefreshAttemptAt: null,
        lastRefreshSucceededAt: null,
        lastRefreshError: null,
      },
    });
    securityService.decryptJson.mockReturnValueOnce({
      apiKey: 'sk-admin-live',
    });
    prisma.opsMemory.upsert
      .mockResolvedValueOnce({
        id: 'telemetry-attempt-1',
      })
      .mockResolvedValueOnce({
        id: 'snapshot-1',
      });
    prisma.opsMemory.update.mockResolvedValueOnce({
      value: {
        adminKeyEncrypted: 'encrypted-admin-key',
        projectIds: ['proj_123'],
        lastRefreshAttemptAt: '2026-03-23T12:00:00.000Z',
        lastRefreshSucceededAt: '2026-03-23T12:00:00.000Z',
        lastRefreshError: null,
      },
    });
    const requestLog: Array<{
      pathname: string;
      groupBy: string[];
      page: string | null;
      limit: string | null;
    }> = [];

    fetchMock.mockImplementation(async (input: URL | string) => {
      const url = new URL(String(input));
      const pathname = url.pathname;
      const groupBy = url.searchParams.getAll('group_by');
      const page = url.searchParams.get('page');
      const limit = url.searchParams.get('limit');
      requestLog.push({
        pathname,
        groupBy,
        page,
        limit,
      });

      if (pathname === '/v1/organization/costs' && groupBy.length === 0 && page === null) {
        return jsonResponse({
          data: [
            {
              start_time: Math.floor(Date.parse('2026-03-22T00:00:00.000Z') / 1000),
              results: [{ amount: { value: 1.5, currency: 'usd' } }],
            },
          ],
          next_page: 'costs-page-2',
        });
      }
      if (pathname === '/v1/organization/costs' && groupBy.length === 0 && page === 'costs-page-2') {
        return jsonResponse({
          data: [
            {
              start_time: Math.floor(Date.parse('2026-03-23T00:00:00.000Z') / 1000),
              results: [{ amount: { value: 2, currency: 'usd' } }],
            },
          ],
          next_page: null,
        });
      }
      if (pathname === '/v1/organization/costs' && groupBy[0] === 'project_id') {
        return jsonResponse({
          data: [
            {
              start_time: Math.floor(Date.parse('2026-03-23T00:00:00.000Z') / 1000),
              results: [{ project_id: 'proj_123', amount: { value: 3, currency: 'usd' } }],
            },
          ],
          next_page: null,
        });
      }
      if (pathname === '/v1/organization/costs' && groupBy[0] === 'line_item') {
        return jsonResponse({
          data: [
            {
              start_time: Math.floor(Date.parse('2026-03-23T00:00:00.000Z') / 1000),
              results: [{ line_item: 'input', amount: { value: 1, currency: 'usd' } }],
            },
          ],
          next_page: null,
        });
      }
      if (pathname === '/v1/organization/usage/completions' && groupBy.length === 0) {
        if (page === null) {
          return jsonResponse({
            data: [
              {
                start_time: Math.floor(Date.parse('2026-03-22T00:00:00.000Z') / 1000),
                results: [
                  {
                    num_model_requests: 2,
                    input_tokens: 100,
                    output_tokens: 40,
                    input_cached_tokens: 10,
                  },
                ],
              },
            ],
            next_page: 'usage-page-2',
          });
        }
        if (page === 'usage-page-2') {
          return jsonResponse({
            data: [
              {
                start_time: Math.floor(Date.parse('2026-03-23T00:00:00.000Z') / 1000),
                results: [
                  {
                    num_model_requests: 1,
                    input_tokens: 60,
                    output_tokens: 20,
                    input_cached_tokens: 0,
                  },
                ],
              },
            ],
            next_page: null,
          });
        }
        return jsonResponse({
          data: [],
          next_page: null,
        });
      }
      if (pathname === '/v1/organization/usage/completions' && groupBy[0] === 'model') {
        return jsonResponse({
          data: [
            {
              start_time: Math.floor(Date.parse('2026-03-23T00:00:00.000Z') / 1000),
              results: [
                {
                  model: 'gpt-5-mini',
                  num_model_requests: 3,
                  input_tokens: 160,
                  output_tokens: 60,
                  input_cached_tokens: 10,
                },
              ],
            },
          ],
          next_page: null,
        });
      }
      if (pathname === '/v1/organization/usage/completions' && groupBy[0] === 'project_id') {
        return jsonResponse({
          data: [
            {
              start_time: Math.floor(Date.parse('2026-03-23T00:00:00.000Z') / 1000),
              results: [
                {
                  project_id: 'proj_123',
                  num_model_requests: 3,
                  input_tokens: 160,
                  output_tokens: 60,
                  input_cached_tokens: 10,
                },
              ],
            },
          ],
          next_page: null,
        });
      }

      throw new Error(`Unexpected fetch: ${url.toString()}`);
    });

    await expect(service.refreshUsage('user-1')).resolves.toEqual({
      ok: true,
      syncedAt: '2026-03-23T12:00:00.000Z',
      lastRefreshAttemptAt: '2026-03-23T12:00:00.000Z',
      lastRefreshSucceededAt: '2026-03-23T12:00:00.000Z',
      lastRefreshError: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    const costRequests = requestLog.filter((request) => request.pathname === '/v1/organization/costs');
    const usageRequests = requestLog.filter(
      (request) => request.pathname === '/v1/organization/usage/completions',
    );
    expect(costRequests).toHaveLength(4);
    expect(usageRequests).toHaveLength(4);
    expect(costRequests.every((request) => request.limit === '90')).toBe(true);
    expect(usageRequests.every((request) => request.limit === '31')).toBe(true);
    expect(prisma.opsMemory.upsert.mock.calls[1]?.[0]).toMatchObject({
      where: {
        userId_key: {
          userId: 'local-admin-id',
          key: 'ai_usage_snapshot_v1',
        },
      },
      update: {
        value: {
          source: 'openai_admin_api',
          windowDays: 90,
          currency: 'usd',
          totals: {
            spendTotal: 3.5,
            spendToday: 2,
            spendMonthToDate: 3.5,
            requests: 3,
            inputTokens: 160,
            outputTokens: 60,
            cachedInputTokens: 10,
          },
          breakdowns: {
            byModel: [
              {
                label: 'gpt-5-mini',
                requests: 3,
                inputTokens: 160,
                outputTokens: 60,
                cachedInputTokens: 10,
              },
            ],
            byProject: [
              {
                label: 'proj_123',
                spend: 3,
                requests: 3,
                inputTokens: 160,
                outputTokens: 60,
                cachedInputTokens: 10,
              },
            ],
            byLineItem: [
              {
                label: 'input',
                amount: 1,
              },
            ],
          },
        },
      },
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.usage.refresh',
      targetType: 'ops_memory',
      targetId: 'snapshot-1',
      paramsJson: {
        projectIdCount: 1,
        success: true,
      },
      success: true,
    });
  });

  it('records safe request-validation failures when OpenAI rejects telemetry parameters', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'telemetry-1',
      updatedAt: new Date('2026-03-23T11:55:00.000Z'),
      value: {
        adminKeyEncrypted: 'encrypted-admin-key',
        projectIds: ['proj_123'],
        lastRefreshAttemptAt: null,
        lastRefreshSucceededAt: '2026-03-22T12:00:00.000Z',
        lastRefreshError: null,
      },
    });
    securityService.decryptJson.mockReturnValueOnce({
      apiKey: 'sk-admin-live',
    });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'telemetry-attempt-1',
    });
    prisma.opsMemory.update.mockResolvedValueOnce({
      value: {
        adminKeyEncrypted: 'encrypted-admin-key',
        projectIds: ['proj_123'],
        lastRefreshAttemptAt: '2026-03-23T12:00:00.000Z',
        lastRefreshSucceededAt: '2026-03-22T12:00:00.000Z',
        lastRefreshError: {
          message: 'OpenAI rejected the telemetry request.',
          occurredAt: '2026-03-23T12:00:00.000Z',
        },
      },
    });
    fetchMock.mockImplementation(async () => jsonResponse({ error: { message: 'bad request' } }, 400));

    await expect(service.refreshUsage('user-1')).rejects.toEqual(
      new BadRequestException('OpenAI rejected the telemetry request.'),
    );

    expect(prisma.opsMemory.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.opsMemory.update).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'local-admin-id',
          key: 'ai_usage_telemetry_v1',
        },
      },
      data: {
        value: {
          adminKeyEncrypted: 'encrypted-admin-key',
          projectIds: ['proj_123'],
          lastRefreshAttemptAt: '2026-03-23T12:00:00.000Z',
          lastRefreshSucceededAt: '2026-03-22T12:00:00.000Z',
          lastRefreshError: {
            message: 'OpenAI rejected the telemetry request.',
            occurredAt: '2026-03-23T12:00:00.000Z',
          },
        },
      },
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.usage.refresh',
      targetType: 'ops_memory',
      targetId: 'telemetry-attempt-1',
      paramsJson: {
        projectIdCount: 1,
        success: false,
      },
      success: false,
    });
  });

  it('records safe refresh failures without overwriting the last successful snapshot', async () => {
    prisma.opsMemory.findUnique.mockResolvedValueOnce({
      id: 'telemetry-1',
      updatedAt: new Date('2026-03-23T11:55:00.000Z'),
      value: {
        adminKeyEncrypted: 'encrypted-admin-key',
        projectIds: [],
        lastRefreshAttemptAt: null,
        lastRefreshSucceededAt: '2026-03-22T12:00:00.000Z',
        lastRefreshError: null,
      },
    });
    securityService.decryptJson.mockReturnValueOnce({
      apiKey: 'sk-admin-live',
    });
    prisma.opsMemory.upsert.mockResolvedValueOnce({
      id: 'telemetry-attempt-1',
    });
    prisma.opsMemory.update.mockResolvedValueOnce({
      value: {
        adminKeyEncrypted: 'encrypted-admin-key',
        projectIds: [],
        lastRefreshAttemptAt: '2026-03-23T12:00:00.000Z',
        lastRefreshSucceededAt: '2026-03-22T12:00:00.000Z',
        lastRefreshError: {
          message: 'OpenAI rejected the admin credential.',
          occurredAt: '2026-03-23T12:00:00.000Z',
        },
      },
    });
    fetchMock.mockImplementation(async () => jsonResponse({ error: { message: 'unauthorized' } }, 401));

    await expect(service.refreshUsage('user-1')).rejects.toEqual(
      new BadRequestException('OpenAI rejected the admin credential.'),
    );

    expect(prisma.opsMemory.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.opsMemory.update).toHaveBeenCalledWith({
      where: {
        userId_key: {
          userId: 'local-admin-id',
          key: 'ai_usage_telemetry_v1',
        },
      },
      data: {
        value: {
          adminKeyEncrypted: 'encrypted-admin-key',
          projectIds: [],
          lastRefreshAttemptAt: '2026-03-23T12:00:00.000Z',
          lastRefreshSucceededAt: '2026-03-22T12:00:00.000Z',
          lastRefreshError: {
            message: 'OpenAI rejected the admin credential.',
            occurredAt: '2026-03-23T12:00:00.000Z',
          },
        },
      },
    });
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'ai.usage.refresh',
      targetType: 'ops_memory',
      targetId: 'telemetry-attempt-1',
      paramsJson: {
        projectIdCount: 0,
        success: false,
      },
      success: false,
    });
  });
});
