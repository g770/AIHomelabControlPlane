# TASK-003 Design: Neutral AI Runtime Library For OpenAI And Ollama

## Goal

Build an internal backend library that presents one provider-neutral AI runtime contract for OpenAI and Ollama.

This task is library creation only. It must not modify any existing service, controller, route, Settings flow, or UI to use the new library yet.

## Why Split This Out

The current repo is tightly coupled to `OpenAI` SDK types and raw `responses.create(...)` response shapes. That makes it hard to add Ollama safely without either:

- leaking OpenAI-specific assumptions across the codebase
- or branching on provider logic in every AI call site

This task isolates the adapter work first so the later integration task can consume a tested internal contract instead of inventing one during migration.

## Current Baseline

- `apps/api/src/modules/ai/ai-provider.service.ts` returns a raw `OpenAI` client and an OpenAI-only model.
- `apps/api/src/modules/ai/ai.service.ts`, `apps/api/src/modules/checks/checks.service.ts`, `apps/api/src/modules/alerts/alerts.service.ts`, `apps/api/src/modules/service-discovery/service-discovery.service.ts`, and `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts` call `openai.responses.create(...)` directly.
- The repo currently depends on `openai@^5.13.1` in `apps/api/package.json`.
- The app’s current request shapes are narrow:
  - stateless text-only `responses.create(...)`
  - prompt-driven JSON output parsing
  - optional `max_output_tokens`
  - dashboard-agent-only use of `reasoning.summary`
- The repo does not currently use `previous_response_id`, `conversation`, multimodal `responses` input, or hosted OpenAI tools.

## Verified External Constraints

Verified from official docs on March 23, 2026:

- OpenAI’s Responses API is broader than the narrow subset this repo currently uses: <https://platform.openai.com/docs/api-reference/responses/list?api-mode=responses>
- Ollama exposes native endpoints under `/api/*`, model discovery through `GET /api/tags`, and an OpenAI-compatible layer under `/v1/*`: <https://docs.ollama.com/api/introduction>
- Ollama documents `POST /v1/responses` support in version `0.13.3+`, but only for the non-stateful flavor. Ollama explicitly notes there is no `previous_response_id` or `conversation` support: <https://docs.ollama.com/api/openai-compatibility>
- Ollama documents model discovery at `GET /api/tags`: <https://docs.ollama.com/api/tags>
- Local Ollama does not require auth, while direct Ollama-hosted access can require bearer auth: <https://docs.ollama.com/api/authentication>

Implication:

- A shared runtime is realistic for the repo’s current stateless text subset.
- A true neutral library must not expose raw OpenAI SDK clients or assume full OpenAI feature parity.

## Scope Boundaries

### In scope

- Create a new internal runtime library under `apps/api/src/modules/ai/runtime/`
- Define provider-neutral types, capability flags, adapters, factory helpers, and safe error types
- Implement OpenAI and Ollama adapters behind the same contract
- Add adapter-focused tests and optional live-compatibility smoke-test scaffolding
- Export the library so later tasks can wire it into services

### Out of scope

- No changes to `AiProviderService`, routes, schemas, or persistence keys
- No changes to `Settings`, API responses, or any web code
- No refactor of existing AI call sites to use the library
- No `ai_provider_v2` migration work
- No dashboard-agent telemetry schema changes
- No bundled Ollama service in Compose

## Primary Decisions

### 1. Build an internal backend library, not a shared workspace package

Put the new runtime under `apps/api/src/modules/ai/runtime/`.

Reasons:

- it depends on backend-only concerns such as HTTP transport, the OpenAI SDK, and provider validation calls
- the web app should only consume API contracts, not provider adapters
- this keeps the work isolated from `packages/shared`, which is reserved for wire contracts

### 2. The public contract must be provider-neutral and text-focused

The library should target the shared subset the repo actually uses today:

- stateless text generation
- prompt-driven JSON text outputs
- optional `max_output_tokens`
- optional reasoning summaries
- optional model discovery
- provider config validation

The library must explicitly not support in v1:

- stateful Responses API usage
- hosted OpenAI tools
- multimodal input
- image generation
- audio generation
- realtime APIs

### 3. Do not expose raw provider clients

The library must not return `OpenAI` clients or provider-native response objects from its public interface.

Instead it should expose a small internal contract:

```ts
export type AiProviderId = 'openai' | 'ollama';

export type AiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AiGenerateRequest = {
  messages: AiMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningSummary?: 'none' | 'auto';
};

export type AiUsageSnapshot = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type AiGenerateResult = {
  provider: AiProviderId;
  model: string;
  outputText: string;
  status: 'completed' | 'incomplete' | 'failed';
  finishReason: 'stop' | 'length' | 'error' | 'unknown';
  requestId: string | null;
  reasoningSummary: string[];
  usage: AiUsageSnapshot | null;
  debug: {
    providerStatus: string | null;
    providerError: string | null;
  } | null;
};
```

### 4. Capabilities must be explicit

Do not infer support by provider name in later call sites.

Expose capabilities on every client:

```ts
export type AiCapabilities = {
  textGeneration: true;
  modelDiscovery: boolean;
  configValidation: true;
  reasoningSummary: boolean;
  usageMetrics: boolean;
};
```

Initial capability defaults:

- OpenAI:
  - `textGeneration: true`
  - `modelDiscovery: false`
  - `configValidation: true`
  - `reasoningSummary: true`
  - `usageMetrics: true`
- Ollama:
  - `textGeneration: true`
  - `modelDiscovery: true`
  - `configValidation: true`
  - `reasoningSummary: false` in repo v1 unless verified by live compatibility tests
  - `usageMetrics: false` unless the exact `/v1/responses` usage shape is confirmed in tests

Reason for the conservative Ollama defaults:

- Ollama documents reasoning summaries for `/v1/responses`
- the docs do not clearly commit to the exact OpenAI response item and usage object shapes this repo currently parses
- the library should default to safe degradation instead of optimistic coupling

### 5. Use the OpenAI SDK only inside the OpenAI adapter

The OpenAI adapter may use the official SDK internally because the repo already depends on it.

The Ollama adapter should not use the OpenAI SDK. It should use direct HTTP:

- native `/api/version` for version validation
- native `/api/tags` for model discovery and model validation
- compatible `/v1/responses` for generation

Reason:

- this avoids pretending Ollama is just “OpenAI with a different base URL”
- it removes the fake `apiKey: 'ollama'` sentinel requirement from the runtime layer
- it makes auth handling correct for local Ollama, protected reverse proxies, and direct hosted Ollama access

### 6. Validation is a first-class library operation

Adapters must expose:

- `validateConfig()`
- `listModels()`
- `generate()`

These methods should return or throw safe, typed results that later integration code can use without leaking secrets.

## Proposed File Layout

Create the following files:

- `apps/api/src/modules/ai/runtime/index.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.types.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.errors.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.client.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.factory.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.http.ts`
- `apps/api/src/modules/ai/runtime/openai-ai-client.ts`
- `apps/api/src/modules/ai/runtime/ollama-ai-client.ts`
- `apps/api/src/modules/ai/runtime/ollama-ai-client.mappers.ts`
- `apps/api/src/modules/ai/runtime/ollama-ai-client.version.ts`

Add tests:

- `apps/api/test/ai-runtime.factory.test.ts`
- `apps/api/test/openai-ai-client.test.ts`
- `apps/api/test/ollama-ai-client.test.ts`
- `apps/api/test/ollama-ai-client.version.test.ts`
- optional non-default live tests:
  - `apps/api/test/ollama-ai-client.compat.int.test.ts`

## Public Interfaces

### Runtime config types

```ts
export type OpenAiRuntimeConfig = {
  provider: 'openai';
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type OllamaRuntimeConfig = {
  provider: 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  timeoutMs?: number;
  minVersion?: string;
};

export type AiRuntimeConfig = OpenAiRuntimeConfig | OllamaRuntimeConfig;
```

Notes:

- `baseUrl` is optional for OpenAI to keep a test seam and allow future proxy support
- `minVersion` defaults to `0.13.3` inside the Ollama adapter
- the library does not know about encrypted values or persistence; it receives decrypted runtime config only

### Client interface

```ts
export interface AiClient {
  readonly provider: AiProviderId;
  readonly model: string;
  readonly capabilities: AiCapabilities;

  validateConfig(): Promise<AiValidationResult>;
  listModels(): Promise<AiModelDiscoveryResult>;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}
```

### Validation and discovery result shapes

```ts
export type AiValidationResult =
  | {
      ok: true;
      provider: AiProviderId;
      normalizedBaseUrl?: string;
      providerVersion?: string | null;
      availableModelIds?: string[] | null;
    }
  | {
      ok: false;
      provider: AiProviderId;
      code:
        | 'invalid_config'
        | 'auth_failed'
        | 'provider_unreachable'
        | 'unsupported_version'
        | 'model_not_found'
        | 'provider_error';
      message: string;
    };

export type AiModelInfo = {
  id: string;
  modifiedAt: string | null;
  sizeBytes: number | null;
  family: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
};

export type AiModelDiscoveryResult =
  | {
      supported: true;
      provider: AiProviderId;
      fetchedAt: string;
      models: AiModelInfo[];
    }
  | {
      supported: false;
      provider: AiProviderId;
      fetchedAt: string;
      models: [];
    };
```

## OpenAI Adapter Design

### Responsibilities

- Instantiate and own the OpenAI SDK client internally
- Map the neutral `AiGenerateRequest` into `responses.create(...)`
- Normalize OpenAI response payloads into `AiGenerateResult`
- Provide safe config validation
- Explicitly return `supported: false` for model discovery in v1

### Generation mapping

Map neutral messages to OpenAI Responses input:

- each message becomes one `input_text` item
- preserve message role order
- include `max_output_tokens`, `temperature`, and `top_p` only when set
- include `reasoning: { summary: 'auto' }` only when `request.reasoningSummary === 'auto'`

The adapter should not expose `response.output` directly. Instead it should normalize:

- `outputText` from `response.output_text ?? ''`
- `requestId` from `response.id ?? null`
- `status` from `response.status` mapped into the neutral enum
- `finishReason` from provider status where available, otherwise `unknown`
- `reasoningSummary` extracted from reasoning items when present
- `usage` mapped from OpenAI token fields

### Validation

Use a lightweight non-generation validation path:

- preferred: SDK `models.retrieve(model)`
- fallback if needed: a lightweight metadata request that does not generate content

Validation must return safe failures only:

- `Invalid OpenAI API key.`
- `Configured OpenAI model is not available to this credential.`
- `OpenAI could not be reached.`

Never return raw upstream bodies or headers.

### Model discovery

Return:

```json
{
  "supported": false,
  "provider": "openai",
  "fetchedAt": "2026-03-23T00:00:00.000Z",
  "models": []
}
```

Reason:

- this task is library-only
- the later integration task keeps OpenAI model selection out of scope and continues using `OPENAI_MODEL`

## Ollama Adapter Design

### Responsibilities

- Normalize the configured root URL
- Validate version compatibility against native `/api/version`
- Discover models through native `/api/tags`
- Generate text through compatible `/v1/responses`
- Return safe, normalized responses even when Ollama omits fields that OpenAI would usually provide

### URL normalization rules

Normalize the configured base URL to a root such as:

- `http://localhost:11434`
- `http://ollama:11434`
- `https://ollama.example.internal`

Reject:

- query strings
- fragments
- arbitrary non-root path suffixes
- unsupported protocols

Derived URLs:

- native root: `<root>/api`
- compat root: `<root>/v1`

### Auth behavior

Do not send an `Authorization` header unless an API key or bearer token is explicitly configured.

That preserves correct behavior for:

- local Ollama with no auth
- direct hosted Ollama access with bearer auth
- protected reverse proxies

### Version validation

Validation flow:

1. `GET <root>/api/version`
2. parse semver safely
3. require `>= 0.13.3`
4. `GET <root>/api/tags`
5. ensure the configured model exists in the returned list

Return safe failures:

- `Failed to reach Ollama at the configured URL.`
- `Configured Ollama instance is older than 0.13.3.`
- `Selected Ollama model is not available on the configured instance.`

### Model discovery

Use `GET <root>/api/tags`.

Map each returned model into:

- `id` from `name` or `model`
- `modifiedAt` from `modified_at`
- `sizeBytes` from `size`
- `family` from `details.family`
- `parameterSize` from `details.parameter_size`
- `quantizationLevel` from `details.quantization_level`

Ignore fields not needed by the app.

### Generation mapping

`generate()` should call `POST <root>/v1/responses`.

Request body:

- `model`
- `input` mapped from the neutral `messages`
- `max_output_tokens` when set
- `temperature` when set
- `top_p` when set

Reasoning behavior:

- if `request.reasoningSummary === 'auto'` and `capabilities.reasoningSummary === false`, omit the reasoning field entirely
- return `reasoningSummary: []`
- this preserves function without claiming a capability the repo has not verified

Usage behavior:

- if the response contains OpenAI-style `usage`, map it
- otherwise return `usage: null`

Response normalization:

- `outputText` from `output_text` when present
- if `output_text` is absent but the output items can be reduced into text safely, do so in the mapper
- `status` maps to `completed`, `incomplete`, or `failed`
- `requestId` from `id` when present
- `debug.providerStatus` from provider status fields when present
- `debug.providerError` from a sanitized provider error summary when present

## Error Model

Add typed runtime errors for internal use:

```ts
export class AiRuntimeError extends Error {
  constructor(
    readonly code:
      | 'invalid_config'
      | 'auth_failed'
      | 'provider_unreachable'
      | 'unsupported_version'
      | 'model_not_found'
      | 'provider_error'
      | 'unsupported_capability',
    message: string,
  ) {
    super(message);
  }
}
```

Rules:

- all public messages must be safe for logs and API responses
- never include API keys, tokens, raw auth headers, or raw upstream bodies
- network and parsing exceptions must be wrapped into `AiRuntimeError` before leaving adapter code

## Transport And Testability Design

### HTTP transport seam

Add a tiny HTTP abstraction for the Ollama adapter:

```ts
export type AiHttpTransport = {
  getJson(url: string, init?: RequestInit): Promise<{ status: number; json: unknown }>;
  postJson(
    url: string,
    body: unknown,
    init?: RequestInit,
  ): Promise<{ status: number; json: unknown }>;
};
```

Default implementation uses `fetch`.

Reason:

- tests can stub HTTP behavior without spinning up servers
- integration code later remains free to wrap timeouts or instrumentation separately

### OpenAI client factory seam

Add a small constructor seam:

```ts
export type OpenAiClientFactory = (config: {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
}) => {
  responses: {
    create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  models?: {
    retrieve(model: string): Promise<Record<string, unknown>>;
  };
};
```

The default factory builds the real SDK client.

Reason:

- tests can mock SDK behavior without monkey-patching module imports

## Test Plan

### Unit tests for helpers

- Ollama URL normalization accepts root URLs and rejects path/query/fragment variants
- Ollama version parser accepts `0.13.3` and rejects lower versions
- usage mapping handles missing fields safely
- reasoning-summary extraction returns stable arrays and ignores malformed items

### OpenAI adapter tests

- generates text successfully from a mocked `responses.create(...)` result
- passes `max_output_tokens`, `temperature`, and `top_p` only when specified
- requests reasoning summaries only when the neutral request asks for them
- maps usage fields into `AiUsageSnapshot`
- maps reasoning items into `reasoningSummary`
- returns `supported: false` from `listModels()`
- validates a model successfully through the client factory
- converts SDK/network failures into safe `AiRuntimeError` messages
- never includes the configured API key in thrown errors or serialized debug objects

### Ollama adapter tests

- validates a correct `0.13.3+` instance and confirms the configured model exists
- rejects malformed URLs before making HTTP requests
- rejects old Ollama versions
- rejects missing selected model
- returns discovered models mapped from `/api/tags`
- generates text through `/v1/responses`
- omits `Authorization` when no token is configured
- sends bearer auth when a token is configured
- omits reasoning request fields when reasoning capability is disabled
- returns empty `reasoningSummary` when the capability is disabled
- returns `usage: null` when the response does not include the expected usage object
- converts network, 4xx, 5xx, and malformed JSON failures into safe runtime errors

### Contract-level tests

Use one shared fixture request and assert both adapters return the same neutral shape:

- `provider`
- `model`
- `outputText`
- `status`
- `finishReason`
- `requestId`
- `reasoningSummary`
- `usage`
- `debug`

This verifies that later integration code can consume the runtime without branching on provider-specific response types.

### Optional live compatibility tests

Add a non-default suite gated behind environment variables:

- `OLLAMA_COMPAT_BASE_URL`
- `OLLAMA_COMPAT_MODEL`
- optional `OLLAMA_COMPAT_TOKEN`

These tests should:

- validate the configured Ollama instance
- run one simple `generate()` call
- verify the library still produces a neutral result

These tests must not run in default CI because the repo does not bundle Ollama in the default stack.

## Acceptance Criteria

- New library files exist under `apps/api/src/modules/ai/runtime/`
- No existing service or route uses the library yet
- The library exposes a provider-neutral `AiClient` interface
- The OpenAI adapter uses the SDK only internally
- The Ollama adapter uses direct HTTP and does not require a fake API key when auth is absent
- The library reports explicit capabilities rather than assuming parity
- Validation and discovery return safe, non-secret results
- Adapter tests cover success paths, failure paths, and secret-safety

## Suggested Multi-Agent Execution Plan

### Agent 1: Core Runtime Contract Agent

Files:

- `apps/api/src/modules/ai/runtime/ai-runtime.types.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.errors.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.client.ts`
- `apps/api/src/modules/ai/runtime/index.ts`

Tasks:

- define the neutral public contract
- define capabilities, validation results, and discovery results
- define safe runtime error types
- keep the contract provider-neutral and free of SDK types

Verification:

- compile-time type checks
- helper tests for shape stability and secret-safe error strings

### Agent 2: OpenAI Adapter Agent

Files:

- `apps/api/src/modules/ai/runtime/openai-ai-client.ts`
- `apps/api/test/openai-ai-client.test.ts`

Tasks:

- add the SDK-backed adapter
- add the client factory seam
- normalize response text, reasoning, usage, and status
- add safe validation logic

Verification:

- adapter unit tests for success, validation, and failure mapping

### Agent 3: Ollama Adapter Agent

Files:

- `apps/api/src/modules/ai/runtime/ollama-ai-client.ts`
- `apps/api/src/modules/ai/runtime/ollama-ai-client.mappers.ts`
- `apps/api/src/modules/ai/runtime/ollama-ai-client.version.ts`
- `apps/api/test/ollama-ai-client.test.ts`
- `apps/api/test/ollama-ai-client.version.test.ts`

Tasks:

- add URL normalization
- add version validation and model discovery
- add `/v1/responses` generation through HTTP
- keep auth optional
- default to conservative capability flags

Verification:

- unit tests for URL, version, discovery, generation, auth, and safe error handling

### Agent 4: Factory And Compatibility Test Agent

Files:

- `apps/api/src/modules/ai/runtime/ai-runtime.factory.ts`
- `apps/api/src/modules/ai/runtime/ai-runtime.http.ts`
- `apps/api/test/ai-runtime.factory.test.ts`
- optional `apps/api/test/ollama-ai-client.compat.int.test.ts`

Tasks:

- create the adapter factory
- wire default transport implementations
- add contract-level tests across both adapters
- add optional live Ollama compatibility smoke tests

Verification:

- targeted Vitest runs for runtime tests
- full `pnpm --filter @homelab/api test`
- `pnpm --filter @homelab/api typecheck`

## Assumptions

- The library remains internal to `apps/api` in v1.
- OpenAI model discovery remains out of scope for now.
- Ollama reasoning and usage support are treated conservatively until verified against a live supported instance.
- The later integration task will own persistence, controller, web, and caller migration work.
