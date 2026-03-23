# TASK-001 Design: Ollama Provider Support In Settings

## Objective

Add Ollama-hosted model support to the Homelab Control Plane so an authenticated admin can choose the active AI provider in `Settings`, while enforcing the product rule that only one AI API configuration is active at a time.

The design must preserve the repo guardrails:

- every API route remains behind auth
- secrets are write-only and never logged
- every persisted write requires explicit confirmation and an `audit_events` record
- diagnostics stay allowlisted and do not expand into arbitrary command execution

## Research Notes

Official Ollama documentation materially changes the implementation tradeoff versus a custom native adapter:

- Ollama exposes a default local API root at `http://localhost:11434/api`, and ollama.com exposes the same API shape at `https://ollama.com/api`.
- Ollama also exposes an OpenAI-compatible API at `/v1`.
- Ollama added `/v1/responses` support in version `0.13.3`, with non-stateful support plus tools and reasoning summaries.
- Ollama exposes model discovery via `GET /api/tags`.
- Local Ollama does not require auth, but direct access to ollama.com requires a bearer API key.

Primary references:

- `https://docs.ollama.com/api/introduction`
- `https://docs.ollama.com/api/openai-compatibility`
- `https://docs.ollama.com/api/tags`
- `https://docs.ollama.com/api/authentication`
- `https://docs.ollama.com/api-reference/get-version`

Inference from those docs plus the current repo:

- the repo already uses non-stateful `openai.responses.create(...)`
- the repo does not use `previous_response_id` or `conversation`
- only `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts` relies on reasoning summaries

That means Ollama can be integrated without inventing a second prompt/runtime contract, as long as the repo uses a provider-neutral wrapper around the existing Responses API usage.

## Current State

- `apps/web/src/pages/settings-page.tsx` exposes a single `AI Provider` card that only stores an installation-wide OpenAI runtime key.
- `apps/api/src/modules/ai/ai-provider.service.ts` stores that key in `OpsMemory` under `ai_provider_v1`, returns safe metadata, and writes `audit_events` on update.
- `apps/api/src/modules/ai/ai.service.ts`, `apps/api/src/modules/checks/checks.service.ts`, `apps/api/src/modules/alerts/alerts.service.ts`, `apps/api/src/modules/service-discovery/service-discovery.service.ts`, and `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts` all assume an OpenAI client and call `responses.create(...)`.
- `apps/api/src/config/env.ts` exposes `OPENAI_MODEL` as an environment default. There is no Ollama endpoint or model config today.
- User-facing copy across the repo still says `OpenAI` in Settings, AI disabled states, service discovery failures, and the Dashboard Agent debug console.

## Requirements And Constraints

### Functional requirements

1. The admin can select `OpenAI` or `Ollama` from `Settings`.
2. Only one provider configuration is active at a time.
3. Switching providers replaces the prior provider configuration rather than preserving multiple live credentials.
4. Ollama configuration must support:
   - endpoint base URL
   - model selection
   - optional bearer token for direct ollama.com access or protected reverse proxies
5. Existing AI-backed features must keep working once the active provider changes.

### Non-functional constraints

- No new public API routes.
- No secret material in responses, logs, errors, or audit payloads.
- All provider writes require `confirm: true` and an audit record.
- The first rollout should not require bundling Ollama into the default Compose stack.
- Code-producing implementation work should be sequenced serially even if separate agents own separate phases.

## Architecture Options

### Option A: Native Ollama API adapter plus existing OpenAI client

Use OpenAI SDK for OpenAI and separate `fetch` calls to Ollama native endpoints such as `/api/chat` and `/api/tags`.

Pros:

- no dependency on Ollama’s OpenAI compatibility layer
- full access to Ollama-native response metadata

Cons:

- duplicates prompt/request shaping across providers
- increases code paths in every AI feature
- forces a larger abstraction layer immediately

### Option B: Thin provider-neutral runtime wrapper over the OpenAI SDK

Keep using the `openai` SDK, but instantiate it with provider-specific base URLs and credentials:

- OpenAI: default base URL and runtime key
- Ollama: `baseURL = <normalized-root>/v1`, `apiKey = provided token or sentinel value`

Model discovery stays separate through Ollama’s `GET /api/tags`.

Pros:

- smallest behavioral delta from the current repo
- existing `responses.create(...)` request shapes remain valid
- dashboard-agent reasoning summaries stay compatible with the documented Ollama feature set
- future providers can still slot in behind one runtime seam

Cons:

- the repo still depends on OpenAI SDK types internally
- Ollama compatibility must be version-gated

### Option C: Provider-specific logic in every AI caller

Let each service branch on provider type and call OpenAI or Ollama directly.

Pros:

- no shared abstraction work upfront

Cons:

- worst long-term maintenance path
- repeated security and fallback logic
- highest regression risk

## Chosen Architecture

Choose Option B.

It matches the current repo shape, minimizes invasive prompt changes, and is explicitly supported by Ollama’s documented `/v1/responses` compatibility surface. The design still introduces a small provider-neutral runtime seam so the repo stops coupling `getClient()` and `getModel()` to OpenAI-only storage assumptions.

## Product Outcome

The `AI Provider` card in `Settings` becomes a single-provider configuration surface with an explicit provider selector.

### User-visible behavior

1. The admin opens `Settings`.
2. The card shows the active provider state:
   - no provider configured
   - OpenAI active
   - Ollama active
3. The admin chooses one provider:
   - `OpenAI`
   - `Ollama`
4. Provider-specific fields render below the selector:
   - OpenAI: write-only API key field
   - Ollama: base URL, optional token, model input, and discovered-model list when available
5. Saving one provider replaces the other provider’s config.
6. Clearing provider config disables AI-backed features entirely.

### Settings card states

#### State A: no provider configured

Show:

- provider selector
- explanation that only one provider can be active at a time
- OpenAI key field when `OpenAI` is selected
- Ollama base URL, optional token, and model field when `Ollama` is selected

#### State B: OpenAI active

Show:

- status line: `Active provider: OpenAI`
- model from `OPENAI_MODEL`
- last updated timestamp
- write-only replacement key field
- `Save Provider` and `Clear Provider` actions

#### State C: Ollama active and reachable

Show:

- status line: `Active provider: Ollama`
- saved base URL
- selected model
- last updated timestamp
- optional badge for discovered-model count
- discovered model picker populated from `GET /api/tags`

#### State D: Ollama active but discovery currently failing

Show:

- saved base URL and selected model
- warning banner with safe fetch error
- manual model text input still usable
- `Retry Model Discovery` action

The saved config remains active even when read-only discovery fails later.

## Proposed Backend Design

### 1. Replace single-provider key storage with a single active-provider envelope

Add a new installation-level `OpsMemory` key:

- `ai_provider_v2`

Do not preserve multiple runtime provider configs. The payload should represent exactly one active provider or an explicit cleared state.

Recommended persisted shape:

```json
{
  "schemaVersion": 2,
  "provider": "ollama",
  "config": {
    "baseUrl": "http://ollama:11434",
    "apiKeyEncrypted": null,
    "model": "qwen3:8b"
  }
}
```

OpenAI variant:

```json
{
  "schemaVersion": 2,
  "provider": "openai",
  "config": {
    "apiKeyEncrypted": "ciphertext"
  }
}
```

Cleared sentinel:

```json
{
  "schemaVersion": 2,
  "provider": null,
  "config": null
}
```

Why keep an explicit cleared sentinel instead of deleting the row:

- `GET` requests must stay read-only
- legacy `ai_provider_v1` may still exist during migration
- a persisted cleared sentinel prevents legacy fallback from resurrecting old OpenAI config

### 2. Legacy migration rules

Current state uses `ai_provider_v1` with the legacy `{ apiKeyEncrypted }` shape.

Migration behavior:

- `GET /api/ai/provider`
  - if `ai_provider_v2` exists, it wins
  - otherwise, fallback-read `ai_provider_v1` as legacy OpenAI config
- `PUT /api/ai/provider`
  - writes `ai_provider_v2`
  - deletes `ai_provider_v1` if present
  - writes a single audit event for the update action
- `PUT /api/ai/provider` with clear action
  - writes the cleared sentinel to `ai_provider_v2`
  - deletes `ai_provider_v1` if present

This makes migration explicit, auditable, and safe under the repo rule that reads must not mutate state.

### 3. Shared contracts

Expand `packages/shared/src/schemas.ts` and exported types to cover provider selection.

Recommended new contract shapes:

- `aiProviderIdSchema = z.enum(['openai', 'ollama'])`
- `aiProviderConfigUpdateSchema` as a discriminated union:
  - `{ confirm: true, provider: 'openai', apiKey: string }`
  - `{ confirm: true, provider: 'ollama', baseUrl: string, model: string, apiKey: string | null }`
  - `{ confirm: true, provider: 'none' }`
- `aiProviderConfigResponseSchema`
- `aiProviderModelsResponseSchema`

Recommended safe response shape:

```json
{
  "configured": true,
  "provider": "ollama",
  "model": "qwen3:8b",
  "updatedAt": "2026-03-23T00:00:00.000Z",
  "openai": null,
  "ollama": {
    "baseUrl": "http://ollama:11434",
    "apiKeyConfigured": false
  }
}
```

OpenAI response shape:

```json
{
  "configured": true,
  "provider": "openai",
  "model": "gpt-5-mini",
  "updatedAt": "2026-03-23T00:00:00.000Z",
  "openai": {
    "apiKeyConfigured": true
  },
  "ollama": null
}
```

Unconfigured response shape:

```json
{
  "configured": false,
  "provider": null,
  "model": null,
  "updatedAt": null,
  "openai": null,
  "ollama": null
}
```

### 4. Provider service split: config plus runtime

Keep `AiProviderService` as the persistence/auth/audit entry point, but stop exposing an OpenAI-only mental model.

Recommended service contract:

- `getProviderConfig()`
- `setProviderConfig(userId, update)`
- `isConfigured()`
- `getRuntime()`
- `listAvailableModels()`

Recommended `getRuntime()` return shape:

```ts
type AiRuntime =
  | {
      provider: 'openai';
      model: string;
      client: OpenAI;
    }
  | {
      provider: 'ollama';
      model: string;
      client: OpenAI;
      baseUrl: string;
    }
  | null;
```

Important design decision:

- callers should stop asking for `getClient()` and `getModel()` separately
- callers should read both from the same runtime object so provider/model selection cannot drift

### 5. OpenAI runtime behavior

When the active provider is OpenAI:

- use the encrypted runtime key from `ai_provider_v2`
- keep `OPENAI_MODEL` as the default model source
- instantiate the existing `OpenAI` client normally

This keeps current OpenAI behavior stable and avoids expanding TASK-001 into a broader OpenAI model-management project.

### 6. Ollama runtime behavior

When the active provider is Ollama:

1. Normalize the stored root URL, for example `http://ollama:11434`
2. Build:
   - native root: `<root>/api`
   - OpenAI-compatible root: `<root>/v1`
3. Instantiate `OpenAI` with:
   - `baseURL: <root>/v1`
   - `apiKey: stored token or 'ollama'`
4. Use the stored Ollama model name for `responses.create(...)`

Validation rules for save:

- URL must be valid `http` or `https`
- URL must not include query, fragment, or extra path segments beyond `/`
- call `GET <root>/api/version`
- reject versions lower than `0.13.3` because `/v1/responses` support was documented as added there
- call `GET <root>/api/tags`
- if the selected model is missing from the returned list, reject the save with a safe error

Why validate on save:

- prevents activating a broken provider config that immediately disables AI features
- gives the UI a definitive success/failure outcome
- keeps provider activation auditable and intentional

### 7. Model discovery endpoint

Add a read-only authenticated route:

- `GET /api/ai/provider/models`

Behavior:

- if active provider is not Ollama, return `supported: false` and an empty list
- if active provider is Ollama, call `GET <root>/api/tags`
- return safe model metadata only

Recommended response:

```json
{
  "provider": "ollama",
  "supported": true,
  "fetchedAt": "2026-03-23T00:15:00.000Z",
  "models": [
    {
      "id": "qwen3:8b",
      "modifiedAt": "2026-03-23T00:10:00.000Z",
      "sizeBytes": 5234567890,
      "family": "qwen3",
      "parameterSize": "8B",
      "quantizationLevel": "Q4_K_M"
    }
  ]
}
```

This route is intentionally read-only and does not persist anything.

### 8. API routes

Recommended authenticated routes:

- `GET /api/ai/provider`
  - returns safe active-provider metadata
- `PUT /api/ai/provider`
  - updates or clears the active provider
  - requires `confirm: true`
  - writes `audit_events`
- `GET /api/ai/provider/models`
  - read-only model discovery for the active provider

Keep `GET /api/ai/status` for compatibility, but compute `enabled` from the new provider config.

### 9. Call-site changes required beyond Settings

The provider-selection feature is not only a Settings change. The following runtime assumptions must be generalized:

- `apps/api/src/modules/ai/ai.service.ts`
  - change OpenAI-only fallback copy to provider-neutral copy
- `apps/api/src/modules/checks/checks.service.ts`
  - source runtime/model from `getRuntime()`
- `apps/api/src/modules/alerts/alerts.service.ts`
  - source runtime/model from `getRuntime()`
- `apps/api/src/modules/service-discovery/service-discovery.service.ts`
  - change `OpenAI unavailable` to `AI provider unavailable`
- `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts`
  - source runtime/model from `getRuntime()`
  - attach provider metadata to captured debug calls

### 10. Dashboard agent debug telemetry decision

Do not rename the persisted `openAiCalls` collection in the first rollout.

Instead:

- keep the existing array name to avoid a historical data migration
- add `provider: 'openai' | 'ollama'` to each entry
- rename UI labels from `OpenAI Debug Console` to `AI Debug Console`

Why:

- the current debug summary is internal to this repo
- changing the stored collection name would add migration risk with low product value
- adding a provider field is enough to make captured calls truthful when Ollama is active

## Proposed Frontend Design

### Settings card layout

Keep a single `AI Provider` card in `apps/web/src/pages/settings-page.tsx`, but replace the OpenAI-only copy with a provider selector.

Recommended controls:

- provider radio group or segmented control:
  - `OpenAI`
  - `Ollama`
- OpenAI section:
  - write-only API key field
  - static current model label from response
- Ollama section:
  - base URL input
  - optional token field
  - model combobox:
    - discovered models when available
    - free-text fallback when discovery fails
- actions:
  - `Save Provider`
  - `Clear Provider`
  - `Retry Model Discovery` when provider is Ollama

### UX notes

- When switching from one configured provider to another, show inline warning copy:
  - `Saving a new provider replaces the existing runtime provider configuration.`
- After successful save:
  - invalidate `['ai-provider']`
  - invalidate `['ai-status']`
  - invalidate `['ai-provider-models']` for Ollama
- Error copy must stay provider-specific but secret-safe:
  - good: `Failed to reach Ollama at the configured URL.`
  - bad: echoing raw auth headers or upstream request dumps

### Other UI copy updates required

- `apps/web/src/pages/ai-page.tsx`
  - change `configure the OpenAI API key` to provider-neutral copy
- `apps/web/src/lib/ai-chat-session.ts`
  - change OpenAI-specific troubleshooting hint to provider-neutral hint
- `apps/web/src/pages/dashboard-agent-page.tsx`
  - rename `OpenAI Debug Console` to `AI Debug Console`

## Security And Audit Requirements

- All provider routes remain authenticated and admin-only like the current AI controller surface.
- Never return `apiKey`, `apiKeyEncrypted`, auth headers, or raw upstream error bodies.
- Require `confirm: true` on every `PUT /api/ai/provider` request.
- Emit `audit_events` for every provider change:
  - `ai.provider.update`
- Audit payload should include only safe metadata:
  - `provider`
  - `configured`
  - `model`
  - `ollamaBaseUrl` only if considered safe and already operator-entered
  - `replacedPreviousProvider`
- Read-only model discovery must not write DB state.
- Normalize and validate Ollama URLs to reduce request-surface ambiguity:
  - allow only `http` and `https`
  - reject query strings, fragments, and arbitrary path suffixes
- Do not add generic custom-header support. Only support the documented optional bearer token.

## Operational Notes

- Do not add Ollama to the default Compose stack in the first rollout.
- Treat Ollama as an operator-managed external dependency.
- Documentation must call out that `http://localhost:11434` only works when the API process can actually reach that host namespace.
- Containerized deployments may need:
  - `http://host.docker.internal:11434`
  - a Docker service name
  - a LAN hostname/IP for a separate Ollama host

## Multi-Agent Execution Plan

Implementation should be executed as serial phases so contract changes settle before runtime and UI work.

### Agent 1: Shared Contract And Migration Design Agent

Goal:

- define the provider-selection contract, legacy migration rules, and provider-neutral shared types

Files:

- `packages/shared/src/schemas.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/web/src/types/api.ts`

Tasks:

- add provider ID schemas and update schemas for OpenAI, Ollama, and clear actions
- add safe response schemas for provider metadata and model discovery
- add provider field to dashboard-agent debug-call schemas without renaming the existing `openAiCalls` collection
- define the legacy `ai_provider_v1` fallback behavior in tests as contract expectations

Verification:

- shared schema tests for valid OpenAI config payloads
- shared schema tests for valid Ollama config payloads
- shared schema tests for invalid provider mixes and malformed URLs
- schema tests confirming no secret fields appear in safe responses

### Agent 2: Backend Provider Runtime Agent

Goal:

- implement `ai_provider_v2`, migration behavior, provider save/clear flows, and the provider-neutral runtime wrapper

Files:

- `apps/api/src/modules/ai/ai-provider.service.ts`
- `apps/api/src/modules/ai/ai.controller.ts`
- `apps/api/src/modules/ai/ai.module.ts`
- `apps/api/test/ai-provider.service.test.ts`
- `apps/api/test/ai.personality.controller.int.test.ts`

Tasks:

- add read/write support for `ai_provider_v2`
- retain read-only fallback support for legacy `ai_provider_v1`
- delete legacy `ai_provider_v1` during explicit writes
- implement `getRuntime()` so callers receive `{ provider, model, client }`
- implement OpenAI and Ollama client construction
- validate Ollama URL, version, and selected model on save
- add `GET /api/ai/provider/models`
- ensure every new or changed route stays behind the existing auth path

Verification:

- service tests for OpenAI save, clear, and legacy read fallback
- service tests for Ollama save success, bad URL, unsupported version, missing model, and safe error handling
- controller tests for validation, auth wiring, and absence of secret fields
- tests proving `confirm: true` is required for write actions

### Agent 3: Runtime Call-Site Refactor Agent

Goal:

- update AI feature callers to consume the provider-neutral runtime object and provider-neutral copy

Files:

- `apps/api/src/modules/ai/ai.service.ts`
- `apps/api/src/modules/checks/checks.service.ts`
- `apps/api/src/modules/alerts/alerts.service.ts`
- `apps/api/src/modules/service-discovery/service-discovery.service.ts`
- `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts`
- related tests in `apps/api/test`

Tasks:

- replace separate `getClient()` plus `getModel()` usage with `getRuntime()`
- update OpenAI-specific fallback/error copy to provider-neutral wording
- keep existing structured prompt logic unchanged unless a provider incompatibility is proven
- attach `provider` metadata to dashboard-agent debug call entries
- preserve secret redaction behavior in dashboard-agent debug traces

Verification:

- targeted API/service tests for AI disabled fallback behavior
- dashboard-agent tests confirming provider metadata is captured and secrets remain redacted
- regression tests for alerts/checks/service-discovery AI flows under both unconfigured and configured states

### Agent 4: Settings And UX Agent

Goal:

- expose provider selection, Ollama config, and Ollama model discovery in the Settings UI

Files:

- `apps/web/src/pages/settings-page.tsx`
- `apps/web/src/pages/ai-page.tsx`
- `apps/web/src/pages/dashboard-agent-page.tsx`
- `apps/web/src/lib/ai-chat-session.ts`
- `apps/web/test/settings-page.test.tsx`
- related web tests

Tasks:

- replace the OpenAI-only card with a provider selector
- keep write-only key/token handling
- add Ollama base URL and model controls
- fetch model discovery only for active Ollama config
- handle unconfigured, OpenAI active, Ollama active, and Ollama discovery-failure states
- rename debug-console copy to provider-neutral wording

Verification:

- UI tests for provider switching, save, clear, and query invalidation
- UI tests for Ollama discovery success and discovery failure
- tests ensuring secrets are not re-rendered after save

### Agent 5: QA And Docs Agent

Goal:

- validate guardrails, operator guidance, and rollout readiness

Files:

- `README.md`
- `docs/ENVIRONMENT_SETUP.md`
- `docs/OPERATIONS.md`
- targeted tests in `apps/api/test` and `apps/web/test`

Tasks:

- update operator docs from OpenAI-only wording to provider-aware wording
- document Ollama version requirement `0.13.3+`
- document base URL guidance for local, container, and remote Ollama deployments
- verify all provider write actions emit audit records
- verify no route became public and no secret appears in logs, responses, or audits

Verification:

- `pnpm --filter @homelab/api test`
- `pnpm --filter @homelab/web test`
- repo markdown/format checks used by the team

## Suggested Test Matrix

- legacy `ai_provider_v1` is still readable as OpenAI when `ai_provider_v2` is absent
- saving OpenAI config writes `ai_provider_v2` and removes legacy `ai_provider_v1`
- clearing provider config writes cleared sentinel and removes legacy `ai_provider_v1`
- reject provider update without `confirm: true`
- reject Ollama URL with path/query/fragment
- reject Ollama version below `0.13.3`
- reject Ollama save when the selected model is not returned by `/api/tags`
- read-only model discovery never writes DB state
- AI status still reports disabled when provider is cleared
- service-discovery fallback error no longer says `OpenAI unavailable`
- dashboard-agent debug entries include `provider`
- Settings renders correct state for no provider, OpenAI, Ollama, and Ollama discovery failure

## Rollout Notes

- Keep the first rollout focused on runtime provider selection, not on a broader model marketplace or bundled Ollama deployment.
- Preserve the current OpenAI usage/spend task as a separate feature. Its telemetry credential can remain OpenAI-specific even when the runtime provider is Ollama.
- Do not rename persisted dashboard-agent summary collections in the first rollout unless a separate migration task is approved.

## Open Risks

- Ollama compatibility depends on operator-controlled versioning; older deployments will fail activation until upgraded.
- `localhost` is deployment-topology-sensitive. It works for some local dev cases and fails for many containerized setups unless docs are explicit.
- The repo will still use the OpenAI SDK internally, so any future provider that is not OpenAI-compatible will require a broader abstraction later.
