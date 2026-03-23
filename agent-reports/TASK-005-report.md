# TASK-005 Report

## Scope

Implemented OpenAI usage/spend telemetry storage, admin refresh flows, Settings UI, and documentation for the cached usage reporting feature.

## Files Changed

- `packages/shared/src/schemas.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/api/src/modules/ai/ai-usage.service.ts`
- `apps/api/src/modules/ai/ai.controller.ts`
- `apps/api/src/modules/ai/ai.module.ts`
- `apps/api/test/ai-usage.service.test.ts`
- `apps/api/test/ai.personality.controller.int.test.ts`
- `apps/web/src/types/api.ts`
- `apps/web/src/pages/settings-page.tsx`
- `apps/web/test/settings-page.test.tsx`
- `docs/ENVIRONMENT_SETUP.md`
- `docs/OPERATIONS.md`
- `README.md`

## Summary

- Added encrypted telemetry config storage in `ai_usage_telemetry_v1` and cached snapshots in `ai_usage_snapshot_v1`, with explicit approval and audit events for config writes and refreshes.
- Implemented authenticated `usage-config`, `usage-summary`, and `usage-refresh` routes plus safe OpenAI Admin API pagination, normalization, stale-cache preservation, and error handling.
- Added the `OpenAI Usage & Spend` settings card with write-only Admin key handling, optional project scoping, explicit refresh, cached-window views, stale-error banners, and usage/spend breakdowns.
- Added service and controller coverage for telemetry config saves, cached summary trimming, paginated refresh aggregation, failure handling, confirm-gated routes, and safe response shapes.
- Documented the separation between runtime inference credentials and the OpenAI Admin telemetry credential for operators.

## Verification

- `pnpm --filter @homelab/shared test -- schemas`
- `pnpm --filter @homelab/web typecheck`
- `pnpm --filter @homelab/web test -- settings-page`
- `pnpm --filter @homelab/api test -- ai-usage.service ai.personality.controller.int`
- `git diff --check -- packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts apps/api/src/modules/ai/ai-usage.service.ts apps/api/src/modules/ai/ai.controller.ts apps/api/src/modules/ai/ai.module.ts apps/api/test/ai-usage.service.test.ts apps/api/test/ai.personality.controller.int.test.ts apps/web/src/types/api.ts apps/web/src/pages/settings-page.tsx apps/web/test/settings-page.test.tsx docs/ENVIRONMENT_SETUP.md docs/OPERATIONS.md README.md`

## Notes

- Refresh continues to preserve the previous successful snapshot when OpenAI returns an auth or upstream error.
