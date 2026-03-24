/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the settings page route view.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiUsageWindowDays, UiThemeSettings } from '@homelab/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api';
import {
  applyUiThemeSettings,
  buildUiThemePresetSettings,
  defaultUiThemeSettings,
  normalizeUiThemeSettings,
  persistUiThemeSettings,
  uiThemeModeOptions,
  uiThemePaletteOptions,
  uiThemePresetOptions,
  uiThemeStyleOptions,
} from '@/lib/ui-theme';
import { PageSkeleton } from '@/components/page-skeleton';
import type {
  AiProviderConfigResponse,
  AiProviderId,
  AiProviderModelsDiscoverRequest,
  AiProviderModelsResponse,
  AiUsageRefreshResponse,
  AiUsageSummaryResponse,
  AiUsageTelemetryConfigResponse,
  DashboardAgentConfigResponse,
  IntegrationDeleteResponse,
  NotificationRouteSummary,
  ProxmoxIntegrationSummary,
} from '@/types/api';

type ProxmoxIntegrationDraft = {
  name: string;
  baseUrl: string;
  apiTokenId: string;
  apiTokenSecret: string;
  allowInsecureTls: boolean;
  enabled: boolean;
};

type AiProviderSelection = AiProviderId;

const defaultOllamaBaseUrl = 'http://localhost:11434';

/**
 * Creates default proxmox integration draft.
 */
function createDefaultProxmoxIntegrationDraft(): ProxmoxIntegrationDraft {
  return {
    name: 'Proxmox Lab',
    baseUrl: 'https://proxmox.local:8006',
    apiTokenId: '',
    apiTokenSecret: '',
    allowInsecureTls: false,
    enabled: true,
  };
}

/**
 * Implements format count.
 */
function formatCount(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Builds integration delete status.
 */
function buildIntegrationDeleteStatus(name: string, result: IntegrationDeleteResponse) {
  return `Integration "${name}" deleted. Removed ${formatCount(result.deletedServiceCount, 'service')}, ${formatCount(result.deletedServiceInstanceCount, 'service instance')}, and ${formatCount(result.deletedHostCount, 'orphan host')}.`;
}

function parseProjectIdsInput(value: string) {
  return [...new Set(value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function formatCurrency(value: number, currency = 'usd') {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(value);
}

function formatWholeNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatUsageDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString();
}

// Administrative settings surface for auth, integrations, AI personality, and UI theme customization.
export function SettingsPage() {
  const queryClient = useQueryClient();

  const integrationsQuery = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiFetch<ProxmoxIntegrationSummary[]>('/api/integrations'),
  });
  const routesQuery = useQuery({
    queryKey: ['notification-routes'],
    queryFn: () => apiFetch<NotificationRouteSummary[]>('/api/notification-routes'),
  });
  const aiPersonalityQuery = useQuery({
    queryKey: ['ai-personality'],
    queryFn: () =>
      apiFetch<{ personality: string; isCustom: boolean; updatedAt: string | null }>(
        '/api/ai/personality',
      ),
  });
  const aiProviderQuery = useQuery({
    queryKey: ['ai-provider'],
    queryFn: () => apiFetch<AiProviderConfigResponse>('/api/ai/provider'),
  });
  const [aiUsageWindowDays, setAiUsageWindowDays] = useState<AiUsageWindowDays>(30);
  const aiUsageConfigQuery = useQuery({
    queryKey: ['ai-usage-config'],
    queryFn: () => apiFetch<AiUsageTelemetryConfigResponse>('/api/ai/usage-config'),
  });
  const aiUsageSummaryQuery = useQuery({
    queryKey: ['ai-usage-summary', aiUsageWindowDays],
    queryFn: () =>
      apiFetch<AiUsageSummaryResponse>(`/api/ai/usage-summary?windowDays=${aiUsageWindowDays}`),
  });
  const dashboardAgentConfigQuery = useQuery({
    queryKey: ['dashboard-agent-config'],
    queryFn: () => apiFetch<DashboardAgentConfigResponse>('/api/dashboard-agent/config'),
  });
  const uiThemeQuery = useQuery({
    queryKey: ['ui-theme'],
    queryFn: () =>
      apiFetch<{
        theme: UiThemeSettings;
        isCustom: boolean;
        updatedAt: string | null;
      }>('/api/account/theme'),
  });

  const [editingIntegrationId, setEditingIntegrationId] = useState<string | null>(null);
  const [integrationDraft, setIntegrationDraft] = useState<ProxmoxIntegrationDraft>(
    createDefaultProxmoxIntegrationDraft,
  );
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<string | null>(null);
  const [uiThemeDraft, setUiThemeDraft] = useState<UiThemeSettings>(defaultUiThemeSettings);
  const [uiThemeDirty, setUiThemeDirty] = useState(false);
  const [aiProviderSelection, setAiProviderSelection] = useState<AiProviderSelection>('openai');
  const [aiProviderOpenAiApiKey, setAiProviderOpenAiApiKey] = useState('');
  const [aiProviderOllamaBaseUrl, setAiProviderOllamaBaseUrl] = useState(defaultOllamaBaseUrl);
  const [aiProviderOllamaApiKey, setAiProviderOllamaApiKey] = useState('');
  const [aiProviderOllamaModel, setAiProviderOllamaModel] = useState('');
  const [aiProviderDiscoveredModels, setAiProviderDiscoveredModels] =
    useState<AiProviderModelsResponse | null>(null);
  const [aiProviderDiscoveryError, setAiProviderDiscoveryError] = useState<string | null>(null);
  const [aiProviderDiscoveryStatus, setAiProviderDiscoveryStatus] = useState<string | null>(null);
  const [aiProviderError, setAiProviderError] = useState<string | null>(null);
  const [aiProviderStatus, setAiProviderStatus] = useState<string | null>(null);
  const [aiUsageAdminApiKey, setAiUsageAdminApiKey] = useState('');
  const [aiUsageProjectIdsText, setAiUsageProjectIdsText] = useState('');
  const [aiUsageError, setAiUsageError] = useState<string | null>(null);
  const [aiUsageStatus, setAiUsageStatus] = useState<string | null>(null);
  const [aiPersonalityDraft, setAiPersonalityDraft] = useState('');
  const [aiPersonalityDirty, setAiPersonalityDirty] = useState(false);
  const [dashboardAgentEnabled, setDashboardAgentEnabled] = useState(true);
  const [dashboardAgentIntervalSec, setDashboardAgentIntervalSec] = useState('300');
  const [dashboardAgentEscalateCreateEvents, setDashboardAgentEscalateCreateEvents] =
    useState(true);
  const [dashboardAgentPersonality, setDashboardAgentPersonality] = useState('');
  const [dashboardAgentDirty, setDashboardAgentDirty] = useState(false);
  const [dashboardAgentError, setDashboardAgentError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!uiThemeQuery.data || uiThemeDirty) {
      return;
    }
    // Keep preview/theme persistence in sync with server state when not editing.
    const normalized = normalizeUiThemeSettings(uiThemeQuery.data.theme);
    setUiThemeDraft(normalized);
    applyUiThemeSettings(normalized);
    persistUiThemeSettings(normalized);
  }, [uiThemeDirty, uiThemeQuery.data]);

  useEffect(() => {
    if (!aiPersonalityQuery.data || aiPersonalityDirty) {
      return;
    }
    setAiPersonalityDraft(aiPersonalityQuery.data.personality);
  }, [aiPersonalityDirty, aiPersonalityQuery.data]);

  useEffect(() => {
    if (!aiProviderQuery.data) {
      return;
    }

    setAiProviderSelection(aiProviderQuery.data.provider === 'ollama' ? 'ollama' : 'openai');
    if (aiProviderQuery.data.provider === 'ollama') {
      setAiProviderOllamaBaseUrl(aiProviderQuery.data.ollama?.baseUrl ?? defaultOllamaBaseUrl);
      setAiProviderOllamaModel(aiProviderQuery.data.model ?? '');
    }
  }, [aiProviderQuery.data]);

  useEffect(() => {
    if (!aiUsageConfigQuery.data) {
      return;
    }

    setAiUsageProjectIdsText(aiUsageConfigQuery.data.projectIds.join('\n'));
  }, [aiUsageConfigQuery.data]);

  useEffect(() => {
    setAiProviderDiscoveredModels(null);
    setAiProviderDiscoveryError(null);
    setAiProviderDiscoveryStatus(null);
  }, [aiProviderSelection, aiProviderOllamaBaseUrl, aiProviderOllamaApiKey]);

  useEffect(() => {
    if (!dashboardAgentConfigQuery.data || dashboardAgentDirty) {
      return;
    }
    setDashboardAgentEnabled(dashboardAgentConfigQuery.data.config.enabled);
    setDashboardAgentIntervalSec(String(dashboardAgentConfigQuery.data.config.intervalSec));
    setDashboardAgentEscalateCreateEvents(
      dashboardAgentConfigQuery.data.config.escalateCreateEvents,
    );
    setDashboardAgentPersonality(dashboardAgentConfigQuery.data.config.personality);
    setDashboardAgentError(null);
  }, [dashboardAgentConfigQuery.data, dashboardAgentDirty]);

  const saveIntegrationMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch('/api/integrations', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          ...payload,
        }),
      }),
    onMutate: () => {
      setIntegrationError(null);
      setIntegrationStatus(null);
    },
    onSuccess: async (_result, variables) => {
      setEditingIntegrationId(null);
      setIntegrationDraft(createDefaultProxmoxIntegrationDraft());
      setIntegrationStatus(
        variables.id
          ? `Updated Proxmox integration "${variables.name}".`
          : `Saved Proxmox integration "${variables.name}".`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['integrations'] }),
      ]);
    },
    onError: (error) => {
      setIntegrationError(
        error instanceof Error ? error.message : 'Failed to save the Proxmox integration.',
      );
    },
  });

  const deleteIntegrationMutation = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      apiFetch<IntegrationDeleteResponse>(`/api/integrations/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({
          confirm: true,
        }),
      }),
    onMutate: () => {
      setIntegrationError(null);
      setIntegrationStatus(null);
    },
    onSuccess: async (result, variables) => {
      if (editingIntegrationId === variables.id) {
        resetIntegrationForm();
      }
      setIntegrationStatus(buildIntegrationDeleteStatus(variables.name, result));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['integrations'] }),
        queryClient.invalidateQueries({ queryKey: ['hosts'] }),
        queryClient.invalidateQueries({ queryKey: ['services'] }),
        queryClient.invalidateQueries({ queryKey: ['checks'] }),
        queryClient.invalidateQueries({ queryKey: ['home-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['events'] }),
        queryClient.invalidateQueries({ queryKey: ['alerts-incidents'] }),
      ]);
    },
    onError: (error, variables) => {
      setIntegrationError(
        error instanceof Error
          ? error.message
          : `Failed to delete integration "${variables.name}".`,
      );
    },
  });

  const saveAiPersonalityMutation = useMutation({
    mutationFn: (personality: string) =>
      apiFetch<{ personality: string; isCustom: boolean; updatedAt: string | null }>(
        '/api/ai/personality',
        {
          method: 'PUT',
          body: JSON.stringify({
            confirm: true,
            personality,
          }),
        },
      ),
    onSuccess: async (result) => {
      setAiPersonalityDraft(result.personality);
      setAiPersonalityDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['ai-personality'] });
    },
  });

  const saveAiProviderMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<AiProviderConfigResponse>('/api/ai/provider', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          ...payload,
        }),
      }),
    onMutate: () => {
      setAiProviderDiscoveryError(null);
      setAiProviderDiscoveryStatus(null);
      setAiProviderError(null);
      setAiProviderStatus(null);
    },
    onSuccess: async (_result, payload) => {
      setAiProviderOpenAiApiKey('');
      setAiProviderOllamaApiKey('');
      if (payload.provider !== 'ollama') {
        setAiProviderDiscoveredModels(null);
      }
      setAiProviderStatus(
        payload.provider === 'none'
          ? 'AI provider cleared.'
          : payload.provider === 'ollama'
            ? 'Ollama provider saved.'
            : 'OpenAI provider saved.',
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ai-provider'] }),
        queryClient.invalidateQueries({ queryKey: ['ai-status'] }),
      ]);
    },
    onError: (error) => {
      setAiProviderError(
        error instanceof Error ? error.message : 'Failed to update the AI provider.',
      );
    },
  });

  const discoverAiProviderModelsMutation = useMutation({
    mutationFn: (payload: AiProviderModelsDiscoverRequest) =>
      apiFetch<AiProviderModelsResponse>('/api/ai/provider/models/discover', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onMutate: () => {
      setAiProviderDiscoveryError(null);
      setAiProviderDiscoveryStatus(null);
      setAiProviderError(null);
      setAiProviderStatus(null);
    },
    onSuccess: (result) => {
      setAiProviderDiscoveredModels(result);
      if (result.models.length === 0) {
        setAiProviderDiscoveryStatus('No Ollama models were discovered at the configured URL.');
        return;
      }

      if (!result.models.some((model) => model.id === aiProviderOllamaModel.trim())) {
        setAiProviderOllamaModel(result.models[0]?.id ?? '');
      }
      setAiProviderDiscoveryStatus(
        `Discovered ${formatCount(result.models.length, 'Ollama model')}.`,
      );
    },
    onError: (error) => {
      setAiProviderDiscoveredModels(null);
      setAiProviderDiscoveryError(
        error instanceof Error ? error.message : 'Model discovery failed.',
      );
    },
  });

  const saveAiUsageConfigMutation = useMutation({
    mutationFn: (payload: { adminApiKey: string | null; projectIds: string[] }) =>
      apiFetch<AiUsageTelemetryConfigResponse>('/api/ai/usage-config', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          ...payload,
        }),
      }),
    onMutate: () => {
      setAiUsageError(null);
      setAiUsageStatus(null);
    },
    onSuccess: async (_result, payload) => {
      setAiUsageAdminApiKey('');
      setAiUsageStatus(
        payload.adminApiKey === null ? 'Telemetry key cleared.' : 'Telemetry settings saved.',
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ai-usage-config'] }),
        queryClient.invalidateQueries({ queryKey: ['ai-usage-summary'] }),
      ]);
    },
    onError: (error) => {
      setAiUsageError(
        error instanceof Error ? error.message : 'Failed to update telemetry settings.',
      );
    },
  });

  const refreshAiUsageMutation = useMutation({
    mutationFn: () =>
      apiFetch<AiUsageRefreshResponse>('/api/ai/usage-refresh', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
        }),
      }),
    onMutate: () => {
      setAiUsageError(null);
      setAiUsageStatus(null);
    },
    onSuccess: async () => {
      setAiUsageStatus('Usage snapshot refreshed.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ai-usage-config'] }),
        queryClient.invalidateQueries({ queryKey: ['ai-usage-summary'] }),
      ]);
    },
    onError: (error) => {
      setAiUsageError(error instanceof Error ? error.message : 'Failed to refresh usage data.');
    },
  });

  const saveUiThemeMutation = useMutation({
    mutationFn: (theme: UiThemeSettings) =>
      apiFetch<{
        theme: UiThemeSettings;
        isCustom: boolean;
        updatedAt: string | null;
      }>('/api/account/theme', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          theme,
        }),
      }),
    onSuccess: async (result) => {
      const normalized = normalizeUiThemeSettings(result.theme);
      setUiThemeDraft(normalized);
      setUiThemeDirty(false);
      applyUiThemeSettings(normalized);
      persistUiThemeSettings(normalized);
      await queryClient.invalidateQueries({ queryKey: ['ui-theme'] });
    },
  });

  const saveDashboardAgentConfigMutation = useMutation({
    mutationFn: (payload: DashboardAgentConfigResponse['config']) =>
      apiFetch<DashboardAgentConfigResponse>('/api/dashboard-agent/config', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          config: payload,
        }),
      }),
    onSuccess: async (result) => {
      setDashboardAgentEnabled(result.config.enabled);
      setDashboardAgentIntervalSec(String(result.config.intervalSec));
      setDashboardAgentEscalateCreateEvents(result.config.escalateCreateEvents);
      setDashboardAgentPersonality(result.config.personality);
      setDashboardAgentDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['dashboard-agent-config'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-agent-status'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-agent-runs'] });
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (payload: { currentPassword: string; newPassword: string }) =>
      apiFetch<{ ok: true }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          currentPassword: payload.currentPassword,
          newPassword: payload.newPassword,
        }),
      }),
    onMutate: () => {
      setPasswordError(null);
      setPasswordStatus(null);
    },
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordStatus('Admin password updated.');
    },
    onError: (error) => {
      setPasswordError(error instanceof Error ? error.message : 'Failed to update admin password.');
    },
  });

  /**
   * Implements preview ui theme draft.
   */
  const previewUiThemeDraft = (theme: UiThemeSettings, dirty: boolean) => {
    const normalized = normalizeUiThemeSettings(theme);
    setUiThemeDraft(normalized);
    setUiThemeDirty(dirty);
    applyUiThemeSettings(normalized);
    persistUiThemeSettings(normalized);
  };

  /**
   * Implements update ui theme draft.
   */
  const updateUiThemeDraft = (patch: Partial<UiThemeSettings>) => {
    setUiThemeDraft((current) => {
      const paletteChanged = patch.palette !== undefined && patch.palette !== current.palette;
      const styleChanged = patch.style !== undefined && patch.style !== current.style;
      const nextPreset =
        patch.preset ?? (paletteChanged || styleChanged ? 'custom' : current.preset);
      const next = normalizeUiThemeSettings({
        ...current,
        ...patch,
        preset: nextPreset,
      });
      applyUiThemeSettings(next);
      persistUiThemeSettings(next);
      return next;
    });
    setUiThemeDirty(true);
  };

  const selectedPresetOption = uiThemePresetOptions.find(
    (option) => option.id === uiThemeDraft.preset,
  );
  const selectedModeOption = uiThemeModeOptions.find((option) => option.id === uiThemeDraft.mode);
  const selectedPaletteOption = uiThemePaletteOptions.find(
    (option) => option.id === uiThemeDraft.palette,
  );
  const selectedStyleOption = uiThemeStyleOptions.find(
    (option) => option.id === uiThemeDraft.style,
  );
  const deletingIntegrationId = deleteIntegrationMutation.isPending
    ? (deleteIntegrationMutation.variables?.id ?? null)
    : null;
  const aiUsageSummary = aiUsageSummaryQuery.data ?? null;
  const usageSnapshot = aiUsageSummaryQuery.data?.snapshot ?? null;

  /**
   * Implements reset integration form.
   */
  const resetIntegrationForm = () => {
    setEditingIntegrationId(null);
    setIntegrationDraft(createDefaultProxmoxIntegrationDraft());
  };

  if (
    integrationsQuery.isLoading ||
    routesQuery.isLoading ||
    aiProviderQuery.isLoading ||
    aiUsageConfigQuery.isLoading ||
    aiUsageSummaryQuery.isLoading ||
    aiPersonalityQuery.isLoading ||
    dashboardAgentConfigQuery.isLoading ||
    uiThemeQuery.isLoading
  ) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Admin Password</CardTitle>
          <CardDescription>
            Update the password for the built-in local admin account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setPasswordError(null);
              setPasswordStatus(null);

              if (newPassword !== confirmPassword) {
                setPasswordError('New passwords do not match.');
                return;
              }

              changePasswordMutation.mutate({
                currentPassword,
                newPassword,
              });
            }}
          >
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">Current Password</label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">New Password</label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground">Confirm New Password</label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
            </div>
            <Button type="submit" disabled={changePasswordMutation.isPending}>
              {changePasswordMutation.isPending ? 'Saving...' : 'Update Password'}
            </Button>
          </form>

          {passwordError && <div className="text-xs text-rose-400">{passwordError}</div>}
          {passwordStatus && <div className="text-xs text-emerald-400">{passwordStatus}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Proxmox Integrations</CardTitle>
          <CardDescription>
            Connect one or more Proxmox clusters with explicit fields instead of raw JSON payloads.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setIntegrationError(null);
              setIntegrationStatus(null);

              if (!integrationDraft.name.trim()) {
                setIntegrationError('Integration Name is required.');
                return;
              }
              if (!integrationDraft.baseUrl.trim()) {
                setIntegrationError('Base URL is required.');
                return;
              }
              if (!integrationDraft.apiTokenId.trim()) {
                setIntegrationError('API Token ID is required.');
                return;
              }
              if (!editingIntegrationId && !integrationDraft.apiTokenSecret.trim()) {
                setIntegrationError(
                  'API Token Secret is required when creating a Proxmox integration.',
                );
                return;
              }

              saveIntegrationMutation.mutate({
                id: editingIntegrationId ?? undefined,
                name: integrationDraft.name.trim(),
                enabled: integrationDraft.enabled,
                baseUrl: integrationDraft.baseUrl.trim(),
                apiTokenId: integrationDraft.apiTokenId.trim(),
                apiTokenSecret: integrationDraft.apiTokenSecret.trim() || undefined,
                allowInsecureTls: integrationDraft.allowInsecureTls,
              });
            }}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-integration-name">
                  Integration Name
                </label>
                <Input
                  id="proxmox-integration-name"
                  value={integrationDraft.name}
                  onChange={(event) =>
                    /**
                     * Sets integration draft.
                     */
                    setIntegrationDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Proxmox Lab"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-base-url">
                  Base URL
                </label>
                <Input
                  id="proxmox-base-url"
                  type="url"
                  value={integrationDraft.baseUrl}
                  onChange={(event) =>
                    /**
                     * Sets integration draft.
                     */
                    setIntegrationDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  placeholder="https://proxmox.local:8006"
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-api-token-id">
                  API Token ID
                </label>
                <Input
                  id="proxmox-api-token-id"
                  value={integrationDraft.apiTokenId}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      apiTokenId: event.target.value,
                    }))
                  }
                  placeholder="root@pam!dashboard"
                />
                <div className="text-xs text-muted-foreground">
                  Use the Proxmox token identifier, for example <code>root@pam!dashboard</code>.
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm text-muted-foreground" htmlFor="proxmox-api-token-secret">
                  API Token Secret
                </label>
                <Input
                  id="proxmox-api-token-secret"
                  type="password"
                  value={integrationDraft.apiTokenSecret}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      apiTokenSecret: event.target.value,
                    }))
                  }
                  placeholder={
                    editingIntegrationId
                      ? 'Leave blank to keep the current secret'
                      : 'Paste token secret'
                  }
                />
                {editingIntegrationId ? (
                  <div className="text-xs text-muted-foreground">
                    Leave blank to keep the current stored secret.
                  </div>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                <input
                  aria-label="Allow insecure TLS"
                  type="checkbox"
                  checked={integrationDraft.allowInsecureTls}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      allowInsecureTls: event.target.checked,
                    }))
                  }
                />
                <span>
                  Allow insecure TLS
                  <span className="block text-xs text-muted-foreground">
                    Use only for self-signed or lab certificates you trust.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                <input
                  aria-label="Enabled"
                  type="checkbox"
                  checked={integrationDraft.enabled}
                  onChange={(event) =>
                    setIntegrationDraft((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>
                  Enabled
                  <span className="block text-xs text-muted-foreground">
                    Enabled integrations appear in the Proxmox tab and can be queried live.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saveIntegrationMutation.isPending}>
                {saveIntegrationMutation.isPending
                  ? editingIntegrationId
                    ? 'Updating...'
                    : 'Saving...'
                  : editingIntegrationId
                    ? 'Update Integration'
                    : 'Save Integration'}
              </Button>
              {editingIntegrationId ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetIntegrationForm}
                  disabled={saveIntegrationMutation.isPending}
                >
                  Cancel Edit
                </Button>
              ) : null}
            </div>
          </form>

          {integrationError && <div className="text-xs text-rose-400">{integrationError}</div>}
          {integrationStatus && <div className="text-xs text-emerald-400">{integrationStatus}</div>}

          <div className="space-y-2 text-sm">
            {(integrationsQuery.data ?? []).map((integration) => (
              <div key={integration.id} className="rounded-md border border-border/60 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="font-medium">{integration.name}</div>
                    <div className="text-xs text-muted-foreground">{integration.baseUrl}</div>
                    <div className="text-xs text-muted-foreground">
                      Token ID: {integration.apiTokenId?.trim() || 'Legacy credential'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {integration.enabled ? 'Enabled' : 'Disabled'}
                      {integration.allowInsecureTls ? ' • Insecure TLS allowed' : ''}
                    </div>
                    {integration.lastStatus ? (
                      <div className="text-xs text-muted-foreground">
                        Last status: {integration.lastStatus}
                        {integration.lastSyncAt
                          ? ` • ${new Date(integration.lastSyncAt).toLocaleString()}`
                          : ''}
                      </div>
                    ) : null}
                    {integration.lastError ? (
                      <div className="text-xs text-rose-400">{integration.lastError}</div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() => {
                      setEditingIntegrationId(integration.id);
                      setIntegrationError(null);
                      setIntegrationStatus(null);
                      setIntegrationDraft({
                        name: integration.name,
                        baseUrl: integration.baseUrl,
                        apiTokenId: integration.apiTokenId?.trim() ?? '',
                        apiTokenSecret: '',
                        allowInsecureTls: integration.allowInsecureTls,
                        enabled: integration.enabled,
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() =>
                      apiFetch(`/api/integrations/${integration.id}/test`, {
                        method: 'POST',
                        body: JSON.stringify({ confirm: true }),
                      }).then(() =>
                        Promise.all([
                          queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] }),
                          queryClient.invalidateQueries({ queryKey: ['integrations'] }),
                        ]),
                      )
                    }
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() =>
                      apiFetch(`/api/integrations/${integration.id}/sync`, {
                        method: 'POST',
                        body: JSON.stringify({ confirm: true }),
                      }).then(() => {
                        void queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] });
                        void queryClient.invalidateQueries({ queryKey: ['integrations'] });
                        void queryClient.invalidateQueries({ queryKey: ['hosts'] });
                        void queryClient.invalidateQueries({ queryKey: ['services'] });
                      })
                    }
                  >
                    Sync
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={deletingIntegrationId === integration.id}
                    onClick={() => {
                      const confirmed = window.confirm(
                        `Delete integration "${integration.name}"? This removes the integration, deletes sourced services and service instances, and attempts orphan-host cleanup. This cannot be undone.`,
                      );
                      if (!confirmed) {
                        return;
                      }
                      deleteIntegrationMutation.mutate({
                        id: integration.id,
                        name: integration.name,
                      });
                    }}
                  >
                    {deletingIntegrationId === integration.id ? 'Deleting...' : 'Delete'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>UI Theme</CardTitle>
          <CardDescription>
            Choose a cinematic preset, then fine-tune the underlying mode, palette, and surface
            treatment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Preset
                </div>
                <div className="text-xs text-muted-foreground">
                  Presets coordinate typography, surface density, and motion with their color
                  systems.
                </div>
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {selectedPresetOption?.label ?? 'Custom Theme'}
              </div>
            </div>

            <div className="grid gap-3 xl:grid-cols-2">
              {uiThemePresetOptions.map((option) => {
                const active = uiThemeDraft.preset === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`relative overflow-hidden rounded-xl border p-4 text-left transition ${
                      active
                        ? 'border-primary/70 bg-secondary/20 shadow-lg shadow-primary/10'
                        : 'border-border/60 bg-background/50 hover:border-primary/40 hover:bg-secondary/20'
                    }`}
                    onClick={() => previewUiThemeDraft(buildUiThemePresetSettings(option.id), true)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="font-display text-sm font-semibold">{option.label}</div>
                        <div className="text-xs text-muted-foreground">{option.description}</div>
                      </div>
                      <span
                        className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
                          active
                            ? 'border-primary/40 text-primary'
                            : 'border-border/60 text-muted-foreground'
                        }`}
                      >
                        {active ? 'Active' : 'Preset'}
                      </span>
                    </div>

                    <div className="mt-4 flex gap-2">
                      {option.swatches.map((swatch) => (
                        <span
                          key={swatch}
                          className="h-2.5 flex-1 rounded-full border border-white/10"
                          style={{ backgroundColor: swatch }}
                        />
                      ))}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      <span>{option.motifLabel}</span>
                      <span>{option.fontLabel}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-display text-sm font-semibold">Expert Overrides</div>
                <div className="text-xs text-muted-foreground">
                  Mode changes keep the active preset. Palette or style changes save as a custom
                  variant.
                </div>
              </div>
              <div className="rounded-full border border-border/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {selectedPresetOption ? `Preset: ${selectedPresetOption.label}` : 'Preset: Custom'}
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Mode
                </div>
                <Select
                  aria-label="Theme Mode"
                  value={uiThemeDraft.mode}
                  onChange={(event) =>
                    updateUiThemeDraft({
                      mode: event.target.value as UiThemeSettings['mode'],
                    })
                  }
                >
                  {uiThemeModeOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <div className="text-xs text-muted-foreground">
                  {selectedModeOption?.description}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Palette
                </div>
                <Select
                  aria-label="Theme Palette"
                  value={uiThemeDraft.palette}
                  onChange={(event) =>
                    updateUiThemeDraft({
                      palette: event.target.value as UiThemeSettings['palette'],
                    })
                  }
                >
                  {uiThemePaletteOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <div className="text-xs text-muted-foreground">
                  {selectedPaletteOption?.description}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Style
                </div>
                <Select
                  aria-label="Theme Style"
                  value={uiThemeDraft.style}
                  onChange={(event) =>
                    updateUiThemeDraft({
                      style: event.target.value as UiThemeSettings['style'],
                    })
                  }
                >
                  {uiThemeStyleOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <div className="text-xs text-muted-foreground">
                  {selectedStyleOption?.description}
                </div>
              </div>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            {uiThemeQuery.data?.isCustom ? 'Custom theme saved.' : 'Preset saved.'}{' '}
            {uiThemeQuery.data?.updatedAt
              ? `Last updated ${new Date(uiThemeQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                previewUiThemeDraft(
                  normalizeUiThemeSettings(uiThemeQuery.data?.theme ?? defaultUiThemeSettings),
                  false,
                );
              }}
            >
              Revert
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                previewUiThemeDraft(normalizeUiThemeSettings(defaultUiThemeSettings), true);
              }}
            >
              Use Default Theme
            </Button>
            <Button
              size="sm"
              disabled={saveUiThemeMutation.isPending || !uiThemeDirty}
              onClick={() => saveUiThemeMutation.mutate(uiThemeDraft)}
            >
              {saveUiThemeMutation.isPending ? 'Saving...' : 'Save Theme'}
            </Button>
          </div>

          {saveUiThemeMutation.isError && (
            <div className="text-xs text-rose-400">Failed to save theme preferences.</div>
          )}
          {saveUiThemeMutation.isSuccess && (
            <div className="text-xs text-emerald-400">Theme preferences saved.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Provider</CardTitle>
          <CardDescription>
            Configure the installation-wide AI provider used by model-backed features.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="text-xs text-muted-foreground">
            {aiProviderQuery.data?.configured
              ? `Active provider: ${
                  aiProviderQuery.data.provider === 'ollama' ? 'Ollama' : 'OpenAI'
                }.`
              : 'No AI provider is configured.'}{' '}
            {aiProviderQuery.data?.model ? `Model: ${aiProviderQuery.data.model}.` : ''}
            {aiProviderQuery.data?.updatedAt
              ? ` Last updated ${new Date(aiProviderQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="ai-provider-kind" className="text-sm text-muted-foreground">
                Provider
              </label>
              <Select
                id="ai-provider-kind"
                value={aiProviderSelection}
                onChange={(event) => setAiProviderSelection(event.target.value as AiProviderSelection)}
              >
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama</option>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Current Model</label>
              <Input
                readOnly
                value={
                  aiProviderSelection === 'ollama'
                    ? aiProviderOllamaModel || aiProviderQuery.data?.model || ''
                    : aiProviderQuery.data?.provider === 'openai'
                      ? aiProviderQuery.data?.model ?? 'gpt-5-mini'
                      : 'gpt-5-mini'
                }
              />
            </div>
          </div>
          {aiProviderSelection === 'openai' ? (
            <div className="space-y-1">
              <label htmlFor="ai-provider-openai-key" className="text-sm text-muted-foreground">
                OpenAI API Key
              </label>
              <Input
                id="ai-provider-openai-key"
                type="password"
                value={aiProviderOpenAiApiKey}
                autoComplete="new-password"
                placeholder={
                  aiProviderQuery.data?.provider === 'openai' && aiProviderQuery.data?.configured
                    ? 'Enter a replacement key'
                    : 'Enter a key to enable AI features'
                }
                onChange={(event) => setAiProviderOpenAiApiKey(event.target.value)}
              />
              <div className="text-xs text-muted-foreground">
                OpenAI continues using the environment model. The key is write-only from the UI.
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="ai-provider-ollama-url" className="text-sm text-muted-foreground">
                  Ollama Base URL
                </label>
                <Input
                  id="ai-provider-ollama-url"
                  value={aiProviderOllamaBaseUrl}
                  onChange={(event) => setAiProviderOllamaBaseUrl(event.target.value)}
                  placeholder={defaultOllamaBaseUrl}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="ai-provider-ollama-token"
                  className="text-sm text-muted-foreground"
                >
                  Ollama Token
                </label>
                <Input
                  id="ai-provider-ollama-token"
                  type="password"
                  value={aiProviderOllamaApiKey}
                  autoComplete="new-password"
                  placeholder="Optional bearer token"
                  onChange={(event) => setAiProviderOllamaApiKey(event.target.value)}
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label
                  htmlFor="ai-provider-ollama-model"
                  className="text-sm text-muted-foreground"
                >
                  Ollama Model
                </label>
                <Input
                  id="ai-provider-ollama-model"
                  value={aiProviderOllamaModel}
                  onChange={(event) => setAiProviderOllamaModel(event.target.value)}
                  placeholder="qwen3.5:latest"
                />
                <div className="text-xs text-muted-foreground">
                  Model IDs must exactly match an Ollama tag, for example{' '}
                  <code>qwen3.5:latest</code>.
                </div>
              </div>
              {aiProviderDiscoveredModels?.supported && aiProviderDiscoveredModels.models.length > 0 && (
                <div className="space-y-1 md:col-span-2">
                  <label
                    htmlFor="ai-provider-ollama-discovered"
                    className="text-sm text-muted-foreground"
                  >
                    Discovered Models
                  </label>
                  <Select
                    id="ai-provider-ollama-discovered"
                    value={aiProviderOllamaModel}
                    onChange={(event) => setAiProviderOllamaModel(event.target.value)}
                  >
                    {aiProviderDiscoveredModels.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {aiProviderDiscoveryError && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 md:col-span-2">
                  {aiProviderDiscoveryError}
                </div>
              )}
              {aiProviderDiscoveryStatus && (
                <div className="text-xs text-muted-foreground md:col-span-2">
                  {aiProviderDiscoveryStatus}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={saveAiProviderMutation.isPending}
              onClick={() => {
                if (aiProviderSelection === 'openai') {
                  const apiKey = aiProviderOpenAiApiKey.trim();
                  if (!apiKey) {
                    setAiProviderError('Enter an OpenAI API key before saving.');
                    setAiProviderStatus(null);
                    return;
                  }
                  saveAiProviderMutation.mutate({
                    provider: 'openai',
                    apiKey,
                  });
                  return;
                }

                const baseUrl = aiProviderOllamaBaseUrl.trim();
                const model = aiProviderOllamaModel.trim();
                if (!baseUrl) {
                  setAiProviderError('Enter an Ollama base URL before saving.');
                  setAiProviderStatus(null);
                  return;
                }
                if (!model) {
                  setAiProviderError('Enter an Ollama model before saving.');
                  setAiProviderStatus(null);
                  return;
                }
                saveAiProviderMutation.mutate({
                  provider: 'ollama',
                  baseUrl,
                  model,
                  apiKey: aiProviderOllamaApiKey.trim() || null,
                });
              }}
            >
              {saveAiProviderMutation.isPending ? 'Saving...' : 'Save Provider'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saveAiProviderMutation.isPending || !aiProviderQuery.data?.configured}
              onClick={() => saveAiProviderMutation.mutate({ provider: 'none' })}
            >
              {saveAiProviderMutation.isPending ? 'Clearing...' : 'Clear Provider'}
            </Button>
            {aiProviderSelection === 'ollama' && (
              <Button
                size="sm"
                variant="secondary"
                disabled={discoverAiProviderModelsMutation.isPending}
                onClick={() => {
                  const baseUrl = aiProviderOllamaBaseUrl.trim();
                  if (!baseUrl) {
                    setAiProviderDiscoveredModels(null);
                    setAiProviderDiscoveryError('Enter an Ollama base URL before discovering models.');
                    setAiProviderDiscoveryStatus(null);
                    return;
                  }

                  discoverAiProviderModelsMutation.mutate({
                    provider: 'ollama',
                    baseUrl,
                    apiKey: aiProviderOllamaApiKey.trim() || null,
                  });
                }}
              >
                {discoverAiProviderModelsMutation.isPending
                  ? 'Discovering...'
                  : aiProviderDiscoveredModels
                    ? 'Retry Model Discovery'
                    : 'Discover Models'}
              </Button>
            )}
          </div>
          {aiProviderError && <div className="text-xs text-rose-400">{aiProviderError}</div>}
          {aiProviderStatus && <div className="text-xs text-emerald-400">{aiProviderStatus}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OpenAI Usage &amp; Spend</CardTitle>
          <CardDescription>
            View cached OpenAI administration telemetry for this installation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="text-xs text-muted-foreground">
            {aiUsageConfigQuery.data?.configured
              ? `Telemetry is configured for ${
                  aiUsageConfigQuery.data.projectIds.length > 0
                    ? `${aiUsageConfigQuery.data.projectIds.length} project(s)`
                    : 'all projects'
                }.`
              : 'Telemetry is not configured.'}{' '}
            {aiUsageConfigQuery.data?.updatedAt
              ? `Last updated ${new Date(aiUsageConfigQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="ai-usage-admin-key" className="text-sm text-muted-foreground">
                OpenAI Admin API Key
              </label>
              <Input
                id="ai-usage-admin-key"
                type="password"
                autoComplete="new-password"
                value={aiUsageAdminApiKey}
                placeholder={
                  aiUsageConfigQuery.data?.configured
                    ? 'Enter a replacement admin key'
                    : 'Enter an OpenAI Admin API key'
                }
                onChange={(event) => setAiUsageAdminApiKey(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="ai-usage-project-ids" className="text-sm text-muted-foreground">
                Project IDs
              </label>
              <Textarea
                id="ai-usage-project-ids"
                rows={4}
                value={aiUsageProjectIdsText}
                placeholder={'proj_123\nproj_456'}
                onChange={(event) => setAiUsageProjectIdsText(event.target.value)}
              />
            </div>
          </div>

          {!aiUsageConfigQuery.data?.configured && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              This card requires a separate OpenAI Admin API key. The runtime provider key only
              powers inference.
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={saveAiUsageConfigMutation.isPending}
              onClick={() => {
                const projectIds = parseProjectIdsInput(aiUsageProjectIdsText);
                const adminApiKey = aiUsageAdminApiKey.trim();
                if (!adminApiKey) {
                  setAiUsageError('Enter an OpenAI Admin API key before saving.');
                  setAiUsageStatus(null);
                  return;
                }
                saveAiUsageConfigMutation.mutate({
                  adminApiKey,
                  projectIds,
                });
              }}
            >
              {saveAiUsageConfigMutation.isPending ? 'Saving...' : 'Save Telemetry Key'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saveAiUsageConfigMutation.isPending || !aiUsageConfigQuery.data?.configured}
              onClick={() =>
                saveAiUsageConfigMutation.mutate({
                  adminApiKey: null,
                  projectIds: [],
                })
              }
            >
              {saveAiUsageConfigMutation.isPending ? 'Clearing...' : 'Clear Telemetry Key'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={refreshAiUsageMutation.isPending || !aiUsageConfigQuery.data?.configured}
              onClick={() => refreshAiUsageMutation.mutate()}
            >
              {refreshAiUsageMutation.isPending ? 'Refreshing...' : 'Refresh Usage Data'}
            </Button>
          </div>

          {aiUsageSummary && usageSnapshot ? (
            <>
              <div className="flex flex-wrap gap-2">
                {[7, 30, 90].map((windowDays) => (
                  <Button
                    key={windowDays}
                    size="sm"
                    variant={aiUsageWindowDays === windowDays ? 'default' : 'outline'}
                    onClick={() => setAiUsageWindowDays(windowDays as AiUsageWindowDays)}
                  >
                    {windowDays}d
                  </Button>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">
                Last successful refresh {new Date(usageSnapshot.syncedAt).toLocaleString()}. Scope:{' '}
                {aiUsageSummary.projectIds.length > 0
                  ? aiUsageSummary.projectIds.join(', ')
                  : 'All projects'}
                .
              </div>
              {aiUsageSummary.projectIds.length === 0 && (
                <div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-100">
                  Org-wide spend may include non-text usage outside the text-model token totals.
                </div>
              )}
              {aiUsageSummary.lastRefreshError && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                  Last refresh failed {new Date(aiUsageSummary.lastRefreshError.occurredAt).toLocaleString()}
                  : {aiUsageSummary.lastRefreshError.message}
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-md border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">Spend Today</div>
                  <div className="text-lg font-semibold">
                    {formatCurrency(
                      usageSnapshot.totals.spendToday,
                      usageSnapshot.currency,
                    )}
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">Month-to-Date Spend</div>
                  <div className="text-lg font-semibold">
                    {formatCurrency(
                      usageSnapshot.totals.spendMonthToDate,
                      usageSnapshot.currency,
                    )}
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">
                    Spend Over {aiUsageSummary.windowDays}d
                  </div>
                  <div className="text-lg font-semibold">
                    {formatCurrency(
                      usageSnapshot.totals.spendTotal,
                      usageSnapshot.currency,
                    )}
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">Requests</div>
                  <div className="text-lg font-semibold">
                    {formatWholeNumber(usageSnapshot.totals.requests)}
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">Input Tokens</div>
                  <div className="text-lg font-semibold">
                    {formatWholeNumber(usageSnapshot.totals.inputTokens)}
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">Output Tokens</div>
                  <div className="text-lg font-semibold">
                    {formatWholeNumber(usageSnapshot.totals.outputTokens)}
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <div className="text-xs text-muted-foreground">Cached Input Tokens</div>
                  <div className="text-lg font-semibold">
                    {formatWholeNumber(
                      usageSnapshot.totals.cachedInputTokens,
                    )}
                  </div>
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="space-y-2 rounded-md border border-border/60 p-3">
                  <div className="text-sm font-medium">Daily Spend</div>
                  {usageSnapshot.series.dailySpend.map((row) => (
                    <div
                      key={row.date}
                      className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                    >
                      <span>{formatUsageDate(row.date)}</span>
                      <span>{formatCurrency(row.amount, usageSnapshot.currency)}</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-2 rounded-md border border-border/60 p-3">
                  <div className="text-sm font-medium">Daily Text Usage</div>
                  {usageSnapshot.series.dailyUsage.map((row) => (
                    <div key={row.date} className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between gap-3">
                        <span>{formatUsageDate(row.date)}</span>
                        <span>{formatWholeNumber(row.requests)} requests</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Input {formatWholeNumber(row.inputTokens)}</span>
                        <span>Output {formatWholeNumber(row.outputTokens)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-3">
                <div className="space-y-2 rounded-md border border-border/60 p-3">
                  <div className="text-sm font-medium">By Model</div>
                  {usageSnapshot.breakdowns.byModel.map((row, index) => (
                    <div
                      key={`${row.label ?? 'unknown'}-${index}`}
                      className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                    >
                      <span>{row.label ?? 'Unscoped'}</span>
                      <span>{formatWholeNumber(row.requests)} req</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-2 rounded-md border border-border/60 p-3">
                  <div className="text-sm font-medium">By Project</div>
                  {usageSnapshot.breakdowns.byProject.map((row, index) => (
                    <div
                      key={`${row.label ?? 'unknown'}-${index}`}
                      className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                    >
                      <span>{row.label ?? 'Unscoped'}</span>
                      <span>{formatCurrency(row.spend, usageSnapshot.currency)}</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-2 rounded-md border border-border/60 p-3">
                  <div className="text-sm font-medium">By Line Item</div>
                  {usageSnapshot.breakdowns.byLineItem.map((row, index) => (
                    <div
                      key={`${row.label ?? 'unknown'}-${index}`}
                      className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                    >
                      <span>{row.label ?? 'Other'}</span>
                      <span>{formatCurrency(row.amount, usageSnapshot.currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            aiUsageConfigQuery.data?.configured && (
              <div className="rounded-md border border-border/60 p-3 text-xs text-muted-foreground">
                No usage snapshot has been captured yet. Refresh to pull data from OpenAI.
              </div>
            )
          )}

          {aiUsageError && <div className="text-xs text-rose-400">{aiUsageError}</div>}
          {aiUsageStatus && <div className="text-xs text-emerald-400">{aiUsageStatus}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Personality</CardTitle>
          <CardDescription>
            Define an English-language personality profile applied to model-backed AI calls.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Textarea
            value={aiPersonalityDraft}
            onChange={(event) => {
              setAiPersonalityDraft(event.target.value);
              setAiPersonalityDirty(true);
            }}
            rows={8}
            placeholder="Describe tone, behavior, communication style, and priorities for your AI assistant."
          />
          <div className="text-xs text-muted-foreground">
            {aiPersonalityQuery.data?.isCustom
              ? 'Custom personality active.'
              : 'Default personality active.'}{' '}
            {aiPersonalityQuery.data?.updatedAt
              ? `Last updated ${new Date(aiPersonalityQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setAiPersonalityDraft('');
                setAiPersonalityDirty(true);
              }}
            >
              Use Default Personality
            </Button>
            <Button
              size="sm"
              disabled={saveAiPersonalityMutation.isPending || !aiPersonalityDirty}
              onClick={() => saveAiPersonalityMutation.mutate(aiPersonalityDraft)}
            >
              {saveAiPersonalityMutation.isPending ? 'Saving...' : 'Save Personality'}
            </Button>
          </div>
          {saveAiPersonalityMutation.isError && (
            <div className="text-xs text-rose-400">Failed to save personality.</div>
          )}
          {saveAiPersonalityMutation.isSuccess && (
            <div className="text-xs text-emerald-400">Personality saved.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dashboard Agent</CardTitle>
          <CardDescription>
            Configure the read-only background agent loop and global persona used for anomaly
            triage.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={dashboardAgentEnabled}
              onChange={(event) => {
                setDashboardAgentEnabled(event.target.checked);
                setDashboardAgentDirty(true);
                setDashboardAgentError(null);
              }}
            />
            Enable Dashboard Agent schedule
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Loop Interval (seconds)
              </div>
              <Input
                type="number"
                min={60}
                max={86_400}
                step={1}
                value={dashboardAgentIntervalSec}
                onChange={(event) => {
                  setDashboardAgentIntervalSec(event.target.value);
                  setDashboardAgentDirty(true);
                  setDashboardAgentError(null);
                }}
              />
              <div className="text-xs text-muted-foreground">Valid range: 60 to 86400 seconds.</div>
            </div>
            <label className="flex items-center gap-2 self-end">
              <input
                type="checkbox"
                checked={dashboardAgentEscalateCreateEvents}
                onChange={(event) => {
                  setDashboardAgentEscalateCreateEvents(event.target.checked);
                  setDashboardAgentDirty(true);
                }}
              />
              Emit events for high-priority findings
            </label>
          </div>

          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Global Persona
            </div>
            <Textarea
              rows={6}
              value={dashboardAgentPersonality}
              onChange={(event) => {
                setDashboardAgentPersonality(event.target.value);
                setDashboardAgentDirty(true);
              }}
              placeholder={dashboardAgentConfigQuery.data?.defaultPersonality}
            />
            <div className="text-xs text-muted-foreground">
              Leave blank to use the built-in default personality.
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            {dashboardAgentConfigQuery.data?.updatedAt
              ? `Last updated ${new Date(dashboardAgentConfigQuery.data.updatedAt).toLocaleString()}.`
              : ''}
          </div>

          {dashboardAgentError && (
            <div className="text-xs text-rose-400">{dashboardAgentError}</div>
          )}
          {saveDashboardAgentConfigMutation.isError && (
            <div className="text-xs text-rose-400">Failed to save Dashboard Agent settings.</div>
          )}
          {saveDashboardAgentConfigMutation.isSuccess && !dashboardAgentDirty && (
            <div className="text-xs text-emerald-400">Dashboard Agent settings saved.</div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (!dashboardAgentConfigQuery.data) {
                  return;
                }
                setDashboardAgentEnabled(dashboardAgentConfigQuery.data.config.enabled);
                setDashboardAgentIntervalSec(
                  String(dashboardAgentConfigQuery.data.config.intervalSec),
                );
                setDashboardAgentEscalateCreateEvents(
                  dashboardAgentConfigQuery.data.config.escalateCreateEvents,
                );
                setDashboardAgentPersonality(dashboardAgentConfigQuery.data.config.personality);
                setDashboardAgentDirty(false);
                setDashboardAgentError(null);
              }}
            >
              Revert
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDashboardAgentPersonality('');
                setDashboardAgentDirty(true);
              }}
            >
              Use Default Persona
            </Button>
            <Button
              size="sm"
              disabled={saveDashboardAgentConfigMutation.isPending || !dashboardAgentDirty}
              onClick={() => {
                const parsedInterval = Number(dashboardAgentIntervalSec.trim());
                if (!Number.isFinite(parsedInterval) || !Number.isInteger(parsedInterval)) {
                  setDashboardAgentError('Loop interval must be a whole number.');
                  return;
                }
                if (parsedInterval < 60 || parsedInterval > 86_400) {
                  setDashboardAgentError('Loop interval must be between 60 and 86400 seconds.');
                  return;
                }

                setDashboardAgentError(null);
                saveDashboardAgentConfigMutation.mutate({
                  enabled: dashboardAgentEnabled,
                  intervalSec: parsedInterval,
                  escalateCreateEvents: dashboardAgentEscalateCreateEvents,
                  personality: dashboardAgentPersonality,
                });
              }}
            >
              {saveDashboardAgentConfigMutation.isPending ? 'Saving...' : 'Save Dashboard Agent'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notification Routes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(routesQuery.data ?? []).map((route) => (
            <div key={route.id} className="rounded-md border border-border/60 p-3">
              <div className="font-medium">{route.name}</div>
              <div className="text-muted-foreground">{route.type}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
