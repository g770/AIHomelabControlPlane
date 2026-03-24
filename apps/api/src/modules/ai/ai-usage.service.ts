/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements OpenAI usage telemetry settings and snapshot caching.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  aiUsageRefreshResponseSchema,
  aiUsageSummarySnapshotSchema,
  aiUsageSummaryResponseSchema,
  aiUsageTelemetryConfigResponseSchema,
  type AiUsageSummaryResponse,
  type AiUsageTelemetryConfigUpdate,
  type AiUsageWindowDays,
} from '@homelab/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { LOCAL_ADMIN_EMAIL } from '../auth/admin-account';
import { AuditService } from '../audit/audit.service';
import { SecurityService } from '../common/security.service';

const AI_USAGE_TELEMETRY_MEMORY_KEY = 'ai_usage_telemetry_v1';
const AI_USAGE_SNAPSHOT_MEMORY_KEY = 'ai_usage_snapshot_v1';
const DEFAULT_USAGE_WINDOW_DAYS = 30;
const SNAPSHOT_FETCH_DAYS = 90;
const COSTS_BUCKET_LIMIT = SNAPSHOT_FETCH_DAYS;
const COMPLETIONS_USAGE_DAILY_BUCKET_LIMIT = 31;

type TelemetryRecord = {
  adminKeyEncrypted: string | null;
  projectIds: string[];
  lastRefreshAttemptAt: string | null;
  lastRefreshSucceededAt: string | null;
  lastRefreshError: {
    message: string;
    occurredAt: string;
  } | null;
};

type UsageSnapshot = NonNullable<AiUsageSummaryResponse['snapshot']>;

@Injectable()
/**
 * Implements the ai usage service class.
 */
export class AiUsageService {
  private readonly fetchImpl = fetch;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    private readonly securityService: SecurityService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Gets safe telemetry config metadata.
   */
  async getUsageConfig() {
    const owner = await this.findConfigOwner();
    if (!owner) {
      return buildEmptyConfigResponse();
    }

    const telemetry = await this.readTelemetryRecord(owner.id);
    return aiUsageTelemetryConfigResponseSchema.parse({
      configured: Boolean(telemetry?.value.adminKeyEncrypted),
      projectIds: telemetry?.value.projectIds ?? [],
      updatedAt: telemetry?.updatedAt?.toISOString() ?? null,
      lastRefreshAttemptAt: telemetry?.value.lastRefreshAttemptAt ?? null,
      lastRefreshSucceededAt: telemetry?.value.lastRefreshSucceededAt ?? null,
      lastRefreshError: telemetry?.value.lastRefreshError ?? null,
    });
  }

  /**
   * Saves or clears telemetry config.
   */
  async setUsageConfig(actorUserId: string, update: AiUsageTelemetryConfigUpdate) {
    const owner = await this.findConfigOwner();
    if (!owner) {
      throw new InternalServerErrorException('Local admin account not initialized');
    }

    const projectIds = normalizeProjectIds(update.projectIds);
    const adminApiKey = typeof update.adminApiKey === 'string' ? update.adminApiKey.trim() : '';
    const value: TelemetryRecord = {
      adminKeyEncrypted: adminApiKey
        ? this.securityService.encryptJson({ apiKey: adminApiKey })
        : null,
      projectIds: adminApiKey ? projectIds : [],
      lastRefreshAttemptAt: null,
      lastRefreshSucceededAt: null,
      lastRefreshError: null,
    };

    const saved = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId: owner.id,
          key: AI_USAGE_TELEMETRY_MEMORY_KEY,
        },
      },
      update: {
        value: value as Prisma.InputJsonValue,
      },
      create: {
        userId: owner.id,
        key: AI_USAGE_TELEMETRY_MEMORY_KEY,
        value: value as Prisma.InputJsonValue,
      },
    });

    await this.prisma.opsMemory.deleteMany({
      where: {
        userId: owner.id,
        key: AI_USAGE_SNAPSHOT_MEMORY_KEY,
      },
    });

    await this.auditService.write({
      actorUserId,
      action: 'ai.usage.config.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        configured: Boolean(adminApiKey),
        projectIdCount: adminApiKey ? projectIds.length : 0,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return aiUsageTelemetryConfigResponseSchema.parse({
      configured: Boolean(adminApiKey),
      projectIds: adminApiKey ? projectIds : [],
      updatedAt: saved.updatedAt.toISOString(),
      lastRefreshAttemptAt: null,
      lastRefreshSucceededAt: null,
      lastRefreshError: null,
    });
  }

  /**
   * Gets the cached usage summary for the requested window.
   */
  async getUsageSummary(windowDays: AiUsageWindowDays = DEFAULT_USAGE_WINDOW_DAYS) {
    const owner = await this.findConfigOwner();
    if (!owner) {
      return aiUsageSummaryResponseSchema.parse({
        configured: false,
        projectIds: [],
        windowDays,
        lastRefreshAttemptAt: null,
        lastRefreshSucceededAt: null,
        lastRefreshError: null,
        snapshot: null,
      });
    }

    const [telemetry, snapshotRecord] = await Promise.all([
      this.readTelemetryRecord(owner.id),
      this.readSnapshotRecord(owner.id),
    ]);

    return aiUsageSummaryResponseSchema.parse({
      configured: Boolean(telemetry?.value.adminKeyEncrypted),
      projectIds: telemetry?.value.projectIds ?? [],
      windowDays,
      lastRefreshAttemptAt: telemetry?.value.lastRefreshAttemptAt ?? null,
      lastRefreshSucceededAt: telemetry?.value.lastRefreshSucceededAt ?? null,
      lastRefreshError: telemetry?.value.lastRefreshError ?? null,
      snapshot: snapshotRecord ? trimSnapshotWindow(snapshotRecord.value, windowDays) : null,
    });
  }

  /**
   * Refreshes the cached usage snapshot from OpenAI administration endpoints.
   */
  async refreshUsage(actorUserId: string) {
    const owner = await this.findConfigOwner();
    if (!owner) {
      throw new InternalServerErrorException('Local admin account not initialized');
    }

    const telemetry = await this.readTelemetryRecord(owner.id);
    const value = telemetry?.value;
    if (!value?.adminKeyEncrypted) {
      throw new BadRequestException('OpenAI usage telemetry is not configured.');
    }

    const adminApiKey = this.decryptAdminApiKey(value.adminKeyEncrypted);
    if (!adminApiKey) {
      throw new BadRequestException('OpenAI usage telemetry is not configured.');
    }

    const attemptedAt = new Date().toISOString();
    const baseValue: TelemetryRecord = {
      adminKeyEncrypted: value.adminKeyEncrypted,
      projectIds: value.projectIds,
      lastRefreshAttemptAt: attemptedAt,
      lastRefreshSucceededAt: value.lastRefreshSucceededAt,
      lastRefreshError: null,
    };

    const attemptRecord = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId: owner.id,
          key: AI_USAGE_TELEMETRY_MEMORY_KEY,
        },
      },
      update: {
        value: baseValue as Prisma.InputJsonValue,
      },
      create: {
        userId: owner.id,
        key: AI_USAGE_TELEMETRY_MEMORY_KEY,
        value: baseValue as Prisma.InputJsonValue,
      },
    });

    try {
      const snapshot = await this.fetchUsageSnapshot(adminApiKey, value.projectIds);
      const snapshotRecord = await this.prisma.opsMemory.upsert({
        where: {
          userId_key: {
            userId: owner.id,
            key: AI_USAGE_SNAPSHOT_MEMORY_KEY,
          },
        },
        update: {
          value: snapshot as Prisma.InputJsonValue,
        },
        create: {
          userId: owner.id,
          key: AI_USAGE_SNAPSHOT_MEMORY_KEY,
          value: snapshot as Prisma.InputJsonValue,
        },
      });

      const updatedTelemetry = await this.prisma.opsMemory.update({
        where: {
          userId_key: {
            userId: owner.id,
            key: AI_USAGE_TELEMETRY_MEMORY_KEY,
          },
        },
        data: {
          value: {
            ...baseValue,
            lastRefreshSucceededAt: snapshot.syncedAt,
            lastRefreshError: null,
          } as Prisma.InputJsonValue,
        },
      });

      await this.auditService.write({
        actorUserId,
        action: 'ai.usage.refresh',
        targetType: 'ops_memory',
        targetId: snapshotRecord.id,
        paramsJson: {
          projectIdCount: value.projectIds.length,
          success: true,
        } as Prisma.InputJsonValue,
        success: true,
      });

      return aiUsageRefreshResponseSchema.parse({
        ok: true,
        syncedAt: snapshot.syncedAt,
        lastRefreshAttemptAt: attemptedAt,
        lastRefreshSucceededAt:
          readTelemetryValue(updatedTelemetry.value)?.lastRefreshSucceededAt ?? null,
        lastRefreshError: null,
      });
    } catch (error) {
      const safeMessage = toSafeTelemetryError(error);
      const updatedTelemetry = await this.prisma.opsMemory.update({
        where: {
          userId_key: {
            userId: owner.id,
            key: AI_USAGE_TELEMETRY_MEMORY_KEY,
          },
        },
        data: {
          value: {
            ...baseValue,
            lastRefreshError: {
              message: safeMessage,
              occurredAt: attemptedAt,
            },
          } as Prisma.InputJsonValue,
        },
      });

      await this.auditService.write({
        actorUserId,
        action: 'ai.usage.refresh',
        targetType: 'ops_memory',
        targetId: attemptRecord.id,
        paramsJson: {
          projectIdCount: value.projectIds.length,
          success: false,
        } as Prisma.InputJsonValue,
        success: false,
      });

      void updatedTelemetry;
      throw new BadRequestException(safeMessage);
    }
  }

  private async fetchUsageSnapshot(adminApiKey: string, projectIds: string[]): Promise<UsageSnapshot> {
    const now = new Date();
    const startTime = Math.floor(now.getTime() / 1000) - SNAPSHOT_FETCH_DAYS * 24 * 60 * 60;
    const sharedParams = {
      start_time: String(startTime),
      bucket_width: '1d',
      project_ids: projectIds,
    };
    const costParams = {
      ...sharedParams,
      limit: String(COSTS_BUCKET_LIMIT),
    };
    const usageParams = {
      ...sharedParams,
      // OpenAI caps 1d usage buckets to 31 rows per page; the cursor loop collects the full window.
      limit: String(COMPLETIONS_USAGE_DAILY_BUCKET_LIMIT),
    };

    const [
      dailyCosts,
      projectCosts,
      lineItemCosts,
      dailyUsage,
      modelUsage,
      projectUsage,
    ] = await Promise.all([
      this.fetchBucketPages('/v1/organization/costs', costParams, adminApiKey),
      this.fetchBucketPages(
        '/v1/organization/costs',
        {
          ...costParams,
          group_by: ['project_id'],
        },
        adminApiKey,
      ),
      this.fetchBucketPages(
        '/v1/organization/costs',
        {
          ...costParams,
          group_by: ['line_item'],
        },
        adminApiKey,
      ),
      this.fetchBucketPages('/v1/organization/usage/completions', usageParams, adminApiKey),
      this.fetchBucketPages(
        '/v1/organization/usage/completions',
        {
          ...usageParams,
          group_by: ['model'],
        },
        adminApiKey,
      ),
      this.fetchBucketPages(
        '/v1/organization/usage/completions',
        {
          ...usageParams,
          group_by: ['project_id'],
        },
        adminApiKey,
      ),
    ]);

    const spend = normalizeSpendBuckets(dailyCosts);
    const usage = normalizeUsageBuckets(dailyUsage);
    const spendByProject = normalizeGroupedSpend(projectCosts, 'project_id');
    const spendByLineItem = normalizeGroupedSpend(lineItemCosts, 'line_item');
    const usageByModel = normalizeGroupedUsage(modelUsage, 'model');
    const usageByProject = normalizeGroupedUsage(projectUsage, 'project_id');
    const projectBreakdowns = mergeProjectBreakdowns(spendByProject, usageByProject);

    return {
      source: 'openai_admin_api',
      coverage: {
        spendSource: 'organization.costs',
        usageSources: ['organization.usage.completions'],
        usageScope: 'text_generation',
      },
      windowDays: 90,
      scope: {
        projectIds,
      },
      syncedAt: now.toISOString(),
      currency: spend.currency,
      totals: {
        spendTotal: spend.total,
        spendToday: computeSpendToday(spend.dailySpend),
        spendMonthToDate: computeMonthToDateSpend(spend.dailySpend, now),
        requests: usage.total.requests,
        inputTokens: usage.total.inputTokens,
        outputTokens: usage.total.outputTokens,
        cachedInputTokens: usage.total.cachedInputTokens,
      },
      series: {
        dailySpend: spend.dailySpend,
        dailyUsage: usage.dailyUsage,
      },
      breakdowns: {
        byModel: usageByModel,
        byProject: projectBreakdowns,
        byLineItem: spendByLineItem,
      },
    };
  }

  private async fetchBucketPages(
    path: string,
    params: Record<string, string | string[]>,
    adminApiKey: string,
  ) {
    const baseUrl = this.configService.get<string>('OPENAI_ADMIN_BASE_URL', 'https://api.openai.com');
    const buckets: unknown[] = [];
    let nextPage: string | null = null;

    do {
      const url = new URL(path, baseUrl);
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item) {
              url.searchParams.append(key, item);
            }
          }
          continue;
        }
        if (value) {
          url.searchParams.set(key, value);
        }
      }
      if (nextPage) {
        url.searchParams.set('page', nextPage);
      }

      const response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${adminApiKey}`,
          'Content-Type': 'application/json',
        },
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw createTelemetryHttpError(response.status);
      }

      const data = readArrayField(payload, 'data');
      if (!data) {
        throw new Error('OpenAI telemetry returned an invalid response.');
      }
      buckets.push(...data);
      nextPage = readStringField(payload, 'next_page');
    } while (nextPage);

    return buckets;
  }

  private decryptAdminApiKey(adminKeyEncrypted: string) {
    const decrypted = this.securityService.decryptJson<{ apiKey?: string }>(adminKeyEncrypted);
    const apiKey = typeof decrypted.apiKey === 'string' ? decrypted.apiKey.trim() : '';
    return apiKey.length > 0 ? apiKey : null;
  }

  private async findConfigOwner() {
    return this.prisma.user.findUnique({
      where: { email: LOCAL_ADMIN_EMAIL },
      select: { id: true },
    });
  }

  private async readTelemetryRecord(userId: string) {
    const record = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: AI_USAGE_TELEMETRY_MEMORY_KEY,
        },
      },
      select: {
        id: true,
        value: true,
        updatedAt: true,
      },
    });
    const value = readTelemetryValue(record?.value);
    return value && record
      ? {
          id: record.id,
          updatedAt: record.updatedAt,
          value,
        }
      : null;
  }

  private async readSnapshotRecord(userId: string) {
    const record = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: AI_USAGE_SNAPSHOT_MEMORY_KEY,
        },
      },
      select: {
        value: true,
      },
    });
    const value = readSnapshotValue(record?.value);
    return value ? { value } : null;
  }
}

function buildEmptyConfigResponse() {
  return aiUsageTelemetryConfigResponseSchema.parse({
    configured: false,
    projectIds: [],
    updatedAt: null,
    lastRefreshAttemptAt: null,
    lastRefreshSucceededAt: null,
    lastRefreshError: null,
  });
}

function normalizeProjectIds(projectIds: string[]) {
  return [...new Set(projectIds.map((projectId) => projectId.trim()).filter(Boolean))].slice(0, 50);
}

function readTelemetryValue(value: Prisma.JsonValue | null | undefined): TelemetryRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    adminKeyEncrypted: toOptionalString(value.adminKeyEncrypted),
    projectIds: Array.isArray(value.projectIds)
      ? value.projectIds
          .map((projectId) => (typeof projectId === 'string' ? projectId.trim() : ''))
          .filter(Boolean)
      : [],
    lastRefreshAttemptAt: toOptionalString(value.lastRefreshAttemptAt),
    lastRefreshSucceededAt: toOptionalString(value.lastRefreshSucceededAt),
    lastRefreshError: isRecord(value.lastRefreshError)
      ? {
          message: toOptionalString(value.lastRefreshError.message) ?? 'Telemetry refresh failed.',
          occurredAt: toOptionalString(value.lastRefreshError.occurredAt) ?? new Date(0).toISOString(),
        }
      : null,
  };
}

function readSnapshotValue(value: Prisma.JsonValue | null | undefined): UsageSnapshot | null {
  try {
    return value ? aiUsageSummarySnapshotSchema.parse(value) : null;
  } catch {
    return null;
  }
}

function trimSnapshotWindow(snapshot: UsageSnapshot, windowDays: AiUsageWindowDays): UsageSnapshot {
  const dailySpend = snapshot.series.dailySpend.slice(-windowDays);
  const dailyUsage = snapshot.series.dailyUsage.slice(-windowDays);

  return {
    ...snapshot,
    windowDays,
    totals: {
      ...snapshot.totals,
      spendTotal: dailySpend.reduce((sum, row) => sum + row.amount, 0),
      requests: dailyUsage.reduce((sum, row) => sum + row.requests, 0),
      inputTokens: dailyUsage.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: dailyUsage.reduce((sum, row) => sum + row.outputTokens, 0),
      cachedInputTokens: dailyUsage.reduce((sum, row) => sum + row.cachedInputTokens, 0),
    },
    series: {
      dailySpend,
      dailyUsage,
    },
  };
}

function normalizeSpendBuckets(buckets: unknown[]) {
  const dailySpend: Array<{ date: string; amount: number }> = [];
  let currency = 'usd';

  for (const bucket of buckets) {
    const date = readBucketDate(bucket);
    if (!date) {
      continue;
    }

    const results = readBucketResults(bucket);
    let total = 0;
    for (const result of results) {
      const amount = readAmount(result);
      total += amount.value;
      if (amount.currency) {
        currency = amount.currency;
      }
    }

    if (results.length === 0) {
      const amount = readAmount(bucket);
      total += amount.value;
      if (amount.currency) {
        currency = amount.currency;
      }
    }

    dailySpend.push({ date, amount: roundCurrency(total) });
  }

  return {
    currency,
    dailySpend,
    total: roundCurrency(dailySpend.reduce((sum, row) => sum + row.amount, 0)),
  };
}

function normalizeGroupedSpend(buckets: unknown[], key: 'project_id' | 'line_item') {
  const totals = new Map<string | null, number>();
  for (const bucket of buckets) {
    for (const result of readBucketResults(bucket)) {
      const label = readGroupedLabel(result, key);
      const amount = readAmount(result).value;
      totals.set(label, roundCurrency((totals.get(label) ?? 0) + amount));
    }
  }

  return [...totals.entries()]
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => b.amount - a.amount);
}

function normalizeUsageBuckets(buckets: unknown[]) {
  const dailyUsage: Array<{
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  }> = [];

  for (const bucket of buckets) {
    const date = readBucketDate(bucket);
    if (!date) {
      continue;
    }

    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    for (const result of readBucketResults(bucket)) {
      requests += readInt(result, 'num_model_requests');
      inputTokens += readInt(result, 'input_tokens');
      outputTokens += readInt(result, 'output_tokens');
      cachedInputTokens += readInt(result, 'input_cached_tokens');
    }

    dailyUsage.push({
      date,
      requests,
      inputTokens,
      outputTokens,
      cachedInputTokens,
    });
  }

  return {
    dailyUsage,
    total: {
      requests: dailyUsage.reduce((sum, row) => sum + row.requests, 0),
      inputTokens: dailyUsage.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: dailyUsage.reduce((sum, row) => sum + row.outputTokens, 0),
      cachedInputTokens: dailyUsage.reduce((sum, row) => sum + row.cachedInputTokens, 0),
    },
  };
}

function normalizeGroupedUsage(buckets: unknown[], key: 'model' | 'project_id') {
  const totals = new Map<
    string | null,
    { requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  >();

  for (const bucket of buckets) {
    for (const result of readBucketResults(bucket)) {
      const label = readGroupedLabel(result, key);
      const current = totals.get(label) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      };
      current.requests += readInt(result, 'num_model_requests');
      current.inputTokens += readInt(result, 'input_tokens');
      current.outputTokens += readInt(result, 'output_tokens');
      current.cachedInputTokens += readInt(result, 'input_cached_tokens');
      totals.set(label, current);
    }
  }

  return [...totals.entries()]
    .map(([label, value]) => ({
      label,
      ...value,
    }))
    .sort((a, b) => b.requests - a.requests);
}

function mergeProjectBreakdowns(
  spendRows: Array<{ label: string | null; amount: number }>,
  usageRows: Array<{
    label: string | null;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  }>,
) {
  const merged = new Map<
    string | null,
    { spend: number; requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  >();

  for (const row of spendRows) {
    merged.set(row.label, {
      spend: row.amount,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  }
  for (const row of usageRows) {
    const current = merged.get(row.label) ?? {
      spend: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };
    merged.set(row.label, {
      spend: current.spend,
      requests: current.requests + row.requests,
      inputTokens: current.inputTokens + row.inputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      cachedInputTokens: current.cachedInputTokens + row.cachedInputTokens,
    });
  }

  return [...merged.entries()]
    .map(([label, value]) => ({
      label,
      ...value,
    }))
    .sort((a, b) => b.spend - a.spend || b.requests - a.requests);
}

function computeSpendToday(rows: Array<{ date: string; amount: number }>) {
  const today = new Date().toISOString().slice(0, 10);
  return roundCurrency(rows.find((row) => row.date === today)?.amount ?? 0);
}

function computeMonthToDateSpend(rows: Array<{ date: string; amount: number }>, now: Date) {
  const monthKey = now.toISOString().slice(0, 7);
  return roundCurrency(
    rows.filter((row) => row.date.startsWith(monthKey)).reduce((sum, row) => sum + row.amount, 0),
  );
}

function readBucketDate(bucket: unknown) {
  if (!isRecord(bucket)) {
    return null;
  }

  const startTime = typeof bucket.start_time === 'number' ? bucket.start_time : null;
  return startTime ? new Date(startTime * 1000).toISOString().slice(0, 10) : null;
}

function readBucketResults(bucket: unknown) {
  return readArrayField(bucket, 'results') ?? [];
}

function readAmount(value: unknown) {
  if (!isRecord(value)) {
    return { value: 0, currency: 'usd' };
  }

  const amount = isRecord(value.amount) ? value.amount : isRecord(value.cost) ? value.cost : null;
  if (!amount) {
    return { value: 0, currency: 'usd' };
  }

  return {
    value: typeof amount.value === 'number' && Number.isFinite(amount.value) ? amount.value : 0,
    currency: typeof amount.currency === 'string' ? amount.currency.toLowerCase() : 'usd',
  };
}

function readGroupedLabel(value: unknown, key: 'model' | 'project_id' | 'line_item') {
  if (!isRecord(value)) {
    return null;
  }

  return typeof value[key] === 'string' && value[key].trim().length > 0 ? value[key] : null;
}

function readInt(value: unknown, key: string) {
  if (!isRecord(value)) {
    return 0;
  }

  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(0, Math.round(candidate)) : 0;
}

function readArrayField(value: unknown, key: string) {
  return isRecord(value) && Array.isArray(value[key]) ? (value[key] as unknown[]) : null;
}

function readStringField(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === 'string' && value[key].trim().length > 0
    ? (value[key] as string)
    : null;
}

function createTelemetryHttpError(status: number) {
  if (status === 401 || status === 403) {
    return new Error('OpenAI rejected the admin credential.');
  }
  if (status === 400) {
    return new Error('OpenAI rejected the telemetry request.');
  }
  return new Error('OpenAI telemetry refresh failed.');
}

function toSafeTelemetryError(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'OpenAI telemetry refresh failed.';
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
