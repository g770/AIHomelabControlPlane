/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module creates provider-specific AI clients behind a neutral contract.
 */

import { OpenAiClient } from './openai-ai-client';
import { OllamaAiClient } from './ollama-ai-client';
import type { AiRuntimeConfig, OpenAiClientFactory, AiHttpTransport } from './ai-runtime.types';

export function createAiRuntimeClient(
  config: AiRuntimeConfig,
  dependencies: {
    openAiClientFactory?: OpenAiClientFactory;
    httpTransport?: AiHttpTransport;
  } = {},
) {
  if (config.provider === 'openai') {
    return new OpenAiClient(config, dependencies.openAiClientFactory);
  }

  return new OllamaAiClient(config, dependencies.httpTransport);
}
