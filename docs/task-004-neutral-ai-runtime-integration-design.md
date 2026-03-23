# TASK-004 Design: Neutral AI Runtime Integration Across The Codebase

## Goal

Adopt the neutral AI runtime from TASK-003 across backend services, API contracts, storage, and web experiences so the app can run against OpenAI or Ollama while degrading gracefully when a provider is unavailable or lacks optional capabilities.

This task assumes TASK-003 is already merged and tested.

## Product Outcome

The Homelab Control Plane should support one installation-wide active AI provider:

- `OpenAI`
- `Ollama`
- or no provider configured

Every AI-backed experience should continue to behave predictably:

- OpenAI works as it does today
- Ollama works for the repo’s stateless text-generation use cases
- optional capabilities such as reasoning summaries and usage details degrade safely when absent
- unconfigured or failing providers preserve existing heuristic or disabled-state fallbacks

## Current Baseline

- `AiProviderService` stores only an encrypted OpenAI runtime key in `ai_provider_v1`.
- Existing AI call sites fetch a raw `OpenAI` client and call `responses.create(...)` directly.
- OpenAI-specific copy appears in Settings, disabled-state messaging, service discovery failure text, and the dashboard-agent debug console.
- The repo already has a design for adding Ollama settings support in `docs/task-001-ollama-provider-plan.md`, but that plan assumes a thinner OpenAI-SDK-centered runtime than TASK-003.

## Integration Decisions

### 1. Keep a single active-provider record

Use one installation-level provider envelope under `ai_provider_v2`.

Do not preserve multiple live provider configs.

Persisted states:

- OpenAI active
- Ollama active
- explicit cleared sentinel

### 2. `AiProviderService` becomes config plus runtime orchestration

It should own:

- persistence and migration logic
- auth and audit rules
- decryption of stored secrets
- creation of the neutral runtime client
- read-only model discovery for the active provider

It should not expose:

- `getClient()`
- `getModel()`
- any raw OpenAI or provider-native client

### 3. Call sites must branch on capabilities and fallback policy, not on provider implementation details

Later code should check:

- runtime exists or not
- capability exists or not
- request succeeded or failed

It should not spread provider-specific response parsing across the app.

### 4. Keep OpenAI model management out of scope in v1

OpenAI integration should continue to source the active model from `OPENAI_MODEL`.

Ollama integration should store the selected model in provider config because local model names are installation-specific.

### 5. Preserve existing heuristic and disabled-state behavior

The neutral runtime is not an excuse to remove existing fallbacks.

If AI is unavailable, each feature should keep doing what it already does today:

- return heuristic data when a heuristic fallback exists
- show provider-neutral disabled copy when no heuristic fallback exists
- never block the core product on AI availability

### 6. Keep dashboard-agent debug storage stable in v1

Do not rename the persisted `openAiCalls` collection immediately.

Instead:

- keep the array name for backward compatibility
- add `provider: 'openai' | 'ollama'` per entry
- rename UI labels to `AI Debug Console`

## Shared Contract And Persistence Changes

### 1. Provider persistence envelope

Use `ai_provider_v2`.

Recommended shape:

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

OpenAI shape:

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

### 2. Legacy migration rules

- `GET /api/ai/provider`
  - if `ai_provider_v2` exists, use it
  - otherwise fallback-read `ai_provider_v1` as legacy OpenAI config
- `PUT /api/ai/provider`
  - always writes `ai_provider_v2`
  - deletes `ai_provider_v1` if present
  - emits one audit event
- clear action
  - writes the cleared sentinel to `ai_provider_v2`
  - deletes `ai_provider_v1` if present

### 3. Shared API schemas

Update `packages/shared/src/schemas.ts`, `packages/shared/src/index.ts`, `packages/shared/src/schemas.test.ts`, and `apps/web/src/types/api.ts`.

Add:

- `aiProviderIdSchema = z.enum(['openai', 'ollama'])`
- `aiProviderConfigUpdateSchema` discriminated union
- `aiProviderConfigResponseSchema`
- `aiProviderModelsResponseSchema`

Recommended update payloads:

- `{ confirm: true, provider: 'openai', apiKey: string }`
- `{ confirm: true, provider: 'ollama', baseUrl: string, model: string, apiKey: string | null }`
- `{ confirm: true, provider: 'none' }`

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

Model discovery response:

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

OpenAI discovery response:

```json
{
  "provider": "openai",
  "supported": false,
  "fetchedAt": "2026-03-23T00:15:00.000Z",
  "models": []
}
```

## Backend Integration Design

### `AiProviderService`

Update `apps/api/src/modules/ai/ai-provider.service.ts`.

Responsibilities:

- read and write `ai_provider_v2`
- fallback-read legacy `ai_provider_v1`
- expose safe provider metadata
- decrypt provider config into the TASK-003 runtime config
- construct a neutral `AiClient` from the library
- expose one new runtime accessor:

```ts
type AiRuntimeHandle = {
  provider: 'openai' | 'ollama';
  model: string;
  client: AiClient;
} | null;
```

Public service methods:

- `getProviderConfig()`
- `setProviderConfig(userId, update)`
- `clearProviderConfig(userId)`
- `isConfigured()`
- `getRuntime()`
- `listAvailableModels()`

Implementation rules:

- OpenAI runtime config uses the decrypted API key plus `OPENAI_MODEL`
- Ollama runtime config uses stored `baseUrl`, stored model, and optional decrypted token
- no caller receives decrypted secrets directly
- no method returns raw provider-native responses

### Save-time validation policy

OpenAI save:

- preserve current behavior
- require `confirm: true`
- require a non-empty API key
- do not block save on a live upstream validation request in v1

Ollama save:

- require `confirm: true`
- normalize and validate the URL
- call the neutral client `validateConfig()`
- reject invalid URL, unreachable instance, old version, or missing model with safe errors

Reason for asymmetric validation:

- OpenAI already behaves as “store runtime key and use it later”
- Ollama needs stronger activation-time validation because URL reachability and local model presence are core parts of configuration correctness

### `AiController`

Update `apps/api/src/modules/ai/ai.controller.ts`.

Routes:

- `GET /api/ai/provider`
- `PUT /api/ai/provider`
- `GET /api/ai/provider/models`
- keep existing `GET /api/ai/status` and compute `enabled` from the new provider config

Rules:

- keep all routes authenticated and admin-only under the existing AI controller surface
- model discovery stays read-only and must not persist any DB state
- all writes require `confirm: true`
- all writes emit `audit_events`

### `AiModule`

Update `apps/api/src/modules/ai/ai.module.ts`.

Add the runtime factory/provider wiring from TASK-003 and export it only through `AiProviderService`.

Do not expose provider adapters directly to unrelated modules.

## Call-Site Integration Design

Every AI caller should switch from:

- `const openai = await this.aiProviderService.getClient()`
- `const model = this.aiProviderService.getModel()`

to:

- `const runtime = await this.aiProviderService.getRuntime()`

Then use:

- `runtime?.client.generate(...)`
- `runtime?.client.capabilities`
- `runtime?.model`

### `AiService`

Update `apps/api/src/modules/ai/ai.service.ts`.

Affected behaviors:

- host detail summary generation
- AI chat answer generation
- conversation memory summarization

Migration rules:

- convert each prompt to `AiGenerateRequest` with plain text messages
- preserve current prompt content and downstream parsers
- if no runtime exists, keep current disabled/fallback behavior
- if `generate()` throws or returns empty output, keep current fallback behavior
- update disabled-state copy from OpenAI-specific wording to provider-neutral wording

### `ChecksService`

Update `apps/api/src/modules/checks/checks.service.ts`.

Affected behaviors:

- monitor draft generation
- monitor suggestions generation

Migration rules:

- use the neutral runtime
- keep all existing sanitization and heuristic fallback logic
- continue parsing JSON text from `outputText`
- if no runtime or generation failure, preserve current heuristic paths exactly

### `AlertsService`

Update `apps/api/src/modules/alerts/alerts.service.ts`.

Affected behavior:

- alert draft generation

Migration rules:

- use the neutral runtime
- keep the existing fallback draft
- keep all sanitization and entity validation logic unchanged

### `ServiceDiscoveryService`

Update `apps/api/src/modules/service-discovery/service-discovery.service.ts`.

Affected behavior:

- AI catalog generation

Migration rules:

- use the neutral runtime
- keep built-in catalog fallback behavior
- update user-facing error wording from `OpenAI unavailable` to `AI provider unavailable`

### `DashboardAgentService`

Update `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts`.

Affected behavior:

- highlight refinement
- AI debug telemetry capture

Migration rules:

- use the neutral runtime
- request reasoning summaries only when `runtime.client.capabilities.reasoningSummary` is true
- otherwise omit the reasoning request option entirely
- always accept `reasoningSummary: []`
- always accept `usage: null`
- capture per-call `provider`
- keep the existing `openAiCalls` persisted field name in v1
- rename user-visible labels to `AI Debug Console`

Debug entry additions:

- `provider`
- `model`
- `reasoningSummary`
- `usage`

Debug fallback rules:

- if reasoning summaries are unsupported or missing, store `[]`
- if usage is unsupported or missing, store `null`
- if generation fails, keep the existing failure/debug record pattern with safe errors only

## Graceful Degradation Rules

### Global rules

- `getRuntime()` returning `null` means AI is unavailable, not that the request failed unexpectedly
- missing optional capability must never be treated as a hard error
- generation failure should fall back to existing heuristics where available
- provider-specific validation failures on save must be surfaced in Settings with safe, user-facing copy
- read-only model discovery failure must never disable an already saved Ollama provider

### Experience matrix

| Experience | OpenAI active | Ollama active | No provider | Provider failure or missing capability |
| --- | --- | --- | --- | --- |
| Host detail summary | AI summary | AI summary | existing non-AI fallback | existing non-AI fallback |
| AI chat answer | AI answer | AI answer | provider-neutral disabled message | provider-neutral unavailable message |
| Chat memory summarization | AI summary chunking | AI summary chunking | keep current null/no-op fallback | keep current null/no-op fallback |
| Monitor draft | AI draft | AI draft | heuristic draft | heuristic draft |
| Monitor suggestions | AI suggestions | AI suggestions | heuristic suggestions | heuristic suggestions |
| Alert draft | AI draft | AI draft | heuristic draft | heuristic draft |
| Service discovery catalog | AI catalog | AI catalog | built-in catalog | built-in catalog |
| Dashboard-agent refinement | AI refinement with reasoning/usage | AI refinement, reasoning optional | keep heuristic highlights | keep heuristic highlights |
| Settings model discovery | unsupported | discovered tags list | selector only | warning banner plus manual model input |

### Settings-specific graceful degradation

Ollama discovery success:

- show model picker from `GET /api/ai/provider/models`

Ollama discovery failure after save:

- keep the saved provider active
- show safe warning text
- allow manual model text input
- offer `Retry Model Discovery`

OpenAI active:

- show configured status
- show env-driven model
- do not show model discovery controls

No provider configured:

- show selector and provider-specific inputs
- explain that only one provider can be active at a time

## Frontend Integration Design

### Settings page

Update `apps/web/src/pages/settings-page.tsx`.

Required UI:

- one `AI Provider` card
- provider selector with `OpenAI` and `Ollama`
- OpenAI fields:
  - write-only API key
  - current model from response
- Ollama fields:
  - base URL
  - optional token
  - model input
  - discovered models when available
- actions:
  - `Save Provider`
  - `Clear Provider`
  - `Retry Model Discovery` when provider is Ollama

Behavior:

- saving one provider replaces the previous provider config
- invalidate `['ai-provider']`
- invalidate `['ai-status']`
- invalidate `['ai-provider-models']`
- never re-render secrets after save

### Other web copy updates

Update:

- `apps/web/src/pages/ai-page.tsx`
- `apps/web/src/lib/ai-chat-session.ts`
- `apps/web/src/pages/dashboard-agent-page.tsx`

Copy rules:

- replace `OpenAI`-specific enablement hints with provider-neutral wording
- rename `OpenAI Debug Console` to `AI Debug Console`
- keep the separate OpenAI usage/spend card unchanged because that remains a different feature

## Security And Audit Requirements

- every provider route remains behind auth and admin-only authorization
- every provider write requires `confirm: true`
- every provider write emits `ai.provider.update`
- audit payloads may include only safe metadata:
  - `provider`
  - `configured`
  - `model`
  - `ollamaBaseUrl` only if the product already treats it as safe operator-entered config
  - `replacedPreviousProvider`
- never return or log:
  - decrypted API keys
  - auth headers
  - raw upstream error bodies
  - encrypted secret blobs in safe responses

## Documentation Updates

Update:

- `README.md`
- `docs/ENVIRONMENT_SETUP.md`
- `docs/OPERATIONS.md`

Document:

- supported providers are OpenAI and Ollama
- Ollama minimum supported version is `0.13.3`
- `http://localhost:11434` is topology-sensitive
- containerized deployments may require `host.docker.internal`, a service name, or a LAN hostname
- local Ollama may not require auth, but hosted/proxied Ollama can

## Test Plan

### Shared schema tests

- valid OpenAI update payload
- valid Ollama update payload
- valid clear payload
- invalid provider/input combinations
- safe response shape never contains secret fields

### Provider service tests

Update `apps/api/test/ai-provider.service.test.ts`.

Add coverage for:

- legacy `ai_provider_v1` read fallback
- OpenAI save to `ai_provider_v2`
- Ollama save to `ai_provider_v2`
- clear action writes cleared sentinel
- legacy key deletion on writes
- `getRuntime()` returns a neutral runtime handle
- `listAvailableModels()` behavior for OpenAI and Ollama
- audit payload remains secret-safe

### Controller tests

Update `apps/api/test/ai.personality.controller.int.test.ts` or add a dedicated AI controller integration test.

Add coverage for:

- auth enforcement on provider routes
- `confirm: true` requirement on writes
- safe validation errors
- `GET /api/ai/provider/models` read-only behavior
- no secret fields in JSON responses

### Feature-service tests

Update existing tests:

- `apps/api/test/checks.service.ai-monitor-draft.test.ts`
- `apps/api/test/alerts.service.test.ts`
- `apps/api/test/service-discovery.service.test.ts`
- `apps/api/test/dashboard-agent.service.test.ts`
- `apps/api/test/ai-chat-memory.test.ts`

Add cases for:

- no runtime configured
- OpenAI runtime configured
- Ollama runtime configured
- provider generate failure
- missing reasoning summaries
- missing usage metrics

### Web tests

Update:

- `apps/web/test/settings-page.test.tsx`
- `apps/web/test/ai-page.test.tsx`
- `apps/web/test/dashboard-agent-page.test.tsx`

Add coverage for:

- no provider configured
- OpenAI active
- Ollama active with discovery success
- Ollama active with discovery failure
- provider switching warning copy
- save and clear flows
- query invalidation behavior
- no secret values rendered after save
- `AI Debug Console` label

### Optional live smoke tests

Keep optional env-gated compatibility checks for Ollama from TASK-003.

Use them as pre-release verification for:

- chosen Ollama version
- chosen Ollama model
- neutral runtime integration path

## Acceptance Criteria

- `AiProviderService` no longer exposes raw provider clients
- all AI call sites use the neutral runtime
- Settings supports OpenAI, Ollama, and cleared state
- AI-backed experiences preserve their existing fallback behavior
- missing reasoning summaries or usage metrics do not break dashboard-agent behavior
- model discovery is read-only and safe
- all routes remain authenticated
- all provider writes require confirmation and emit audits
- no secret material appears in responses, logs, or audit payloads

## Suggested Multi-Agent Execution Plan

### Agent 1: Shared Contracts And Provider Persistence Agent

Files:

- `packages/shared/src/schemas.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/web/src/types/api.ts`
- `apps/api/src/modules/ai/ai-provider.service.ts`

Tasks:

- add provider schemas and safe responses
- implement `ai_provider_v2`
- implement legacy migration rules
- implement runtime creation through TASK-003

Verification:

- schema tests
- provider service tests

### Agent 2: Controller And Backend Wiring Agent

Files:

- `apps/api/src/modules/ai/ai.controller.ts`
- `apps/api/src/modules/ai/ai.module.ts`
- AI controller integration tests

Tasks:

- add provider routes
- wire model discovery
- keep auth and confirmation rules intact

Verification:

- controller integration tests
- auth guard regression tests

### Agent 3: Feature Call-Site Migration Agent

Files:

- `apps/api/src/modules/ai/ai.service.ts`
- `apps/api/src/modules/checks/checks.service.ts`
- `apps/api/src/modules/alerts/alerts.service.ts`
- `apps/api/src/modules/service-discovery/service-discovery.service.ts`
- `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts`
- related service tests

Tasks:

- replace raw OpenAI client usage with the neutral runtime
- preserve prompt and fallback behavior
- capture provider-neutral debug metadata
- update provider-neutral copy in backend-generated responses

Verification:

- targeted service tests
- full API test run

### Agent 4: Settings And UX Integration Agent

Files:

- `apps/web/src/pages/settings-page.tsx`
- `apps/web/src/pages/ai-page.tsx`
- `apps/web/src/lib/ai-chat-session.ts`
- `apps/web/src/pages/dashboard-agent-page.tsx`
- related web tests

Tasks:

- add provider selector and provider-specific fields
- integrate model discovery
- add discovery failure handling
- rename user-visible debug labels

Verification:

- targeted web tests
- full web test run

### Agent 5: Docs And Guardrail Verification Agent

Files:

- `README.md`
- `docs/ENVIRONMENT_SETUP.md`
- `docs/OPERATIONS.md`
- targeted test files as needed

Tasks:

- update operator docs
- verify auth, audit, and secret-safety guardrails
- verify rollout guidance for containerized Ollama deployments

Verification:

- `pnpm --filter @homelab/api test`
- `pnpm --filter @homelab/web test`
- `pnpm --filter @homelab/api typecheck`
- `pnpm --filter @homelab/web typecheck`

## Assumptions

- TASK-003 lands before this task starts.
- The first rollout still supports only one active runtime provider at a time.
- OpenAI usage/spend telemetry remains a separate OpenAI-specific feature.
- The repo continues treating AI as an enhancement layer, not a hard dependency for core control-plane behavior.
