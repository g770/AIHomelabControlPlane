# TASK-004 Report

## Scope

Integrated the neutral AI runtime across provider storage, API contracts, backend AI call sites, and provider-related UI.

## Files Changed

- `packages/shared/src/schemas.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/api/src/modules/ai/ai-provider.service.ts`
- `apps/api/src/modules/ai/ai.controller.ts`
- `apps/api/src/modules/ai/ai.module.ts`
- `apps/api/src/modules/ai/ai.service.ts`
- `apps/api/src/modules/checks/checks.service.ts`
- `apps/api/src/modules/alerts/alerts.service.ts`
- `apps/api/src/modules/service-discovery/service-discovery.service.ts`
- `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts`
- `apps/api/test/ai-provider.service.test.ts`
- `apps/api/test/ai.personality.controller.int.test.ts`
- `apps/api/test/checks.service.ai-monitor-draft.test.ts`
- `apps/api/test/alerts.service.test.ts`
- `apps/api/test/dashboard-agent.service.test.ts`
- `apps/api/test/service-discovery.service.test.ts`
- `apps/web/src/types/api.ts`
- `apps/web/src/pages/settings-page.tsx`
- `apps/web/src/pages/ai-page.tsx`
- `apps/web/src/lib/ai-chat-session.ts`
- `apps/web/src/pages/dashboard-agent-page.tsx`
- `apps/web/test/dashboard-agent-page.test.tsx`
- `docs/ENVIRONMENT_SETUP.md`
- `docs/OPERATIONS.md`
- `README.md`

## Summary

- Replaced the legacy OpenAI-only provider flow with `ai_provider_v2`, legacy fallback reads, a cleared sentinel state, safe provider metadata, and read-only model discovery.
- Migrated AI-backed services to the neutral runtime so OpenAI and Ollama use the same internal contract while preserving heuristic fallbacks and provider-neutral disabled copy.
- Extended dashboard-agent debug entries with `provider` while keeping the stored `openAiCalls` collection name for compatibility and renaming the UI label to `AI Debug Console`.
- Updated Settings so operators can choose one active provider, manage Ollama configuration, retry model discovery, and see safe provider metadata without re-rendering secrets.
- Updated contributor and operator docs to describe provider setup, Ollama reachability expectations, and the single-active-provider model.

## Verification

- `pnpm --filter @homelab/web typecheck`
- `pnpm --filter @homelab/web test -- dashboard-agent-page ai-page`
- `pnpm --filter @homelab/api test -- ai-provider.service ai.personality.controller.int checks.service.ai-monitor-draft alerts.service dashboard-agent.service service-discovery.service`
- `git diff --check -- packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts apps/api/src/modules/ai/ai-provider.service.ts apps/api/src/modules/ai/ai.controller.ts apps/api/src/modules/ai/ai.module.ts apps/api/src/modules/ai/ai.service.ts apps/api/src/modules/checks/checks.service.ts apps/api/src/modules/alerts/alerts.service.ts apps/api/src/modules/service-discovery/service-discovery.service.ts apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts apps/api/test/ai-provider.service.test.ts apps/api/test/ai.personality.controller.int.test.ts apps/api/test/checks.service.ai-monitor-draft.test.ts apps/api/test/alerts.service.test.ts apps/api/test/dashboard-agent.service.test.ts apps/api/test/service-discovery.service.test.ts apps/web/src/types/api.ts apps/web/src/pages/settings-page.tsx apps/web/src/pages/ai-page.tsx apps/web/src/lib/ai-chat-session.ts apps/web/src/pages/dashboard-agent-page.tsx apps/web/test/dashboard-agent-page.test.tsx docs/ENVIRONMENT_SETUP.md docs/OPERATIONS.md README.md`

## Notes

- `pnpm --filter @homelab/api typecheck` still reports pre-existing unrelated errors in `src/modules/proxmox/proxmox.service.ts` and `test/integration-cleanup.test.ts`.
