/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the AI runtime factory behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAiRuntimeClient } from '../src/modules/ai/runtime/ai-runtime.factory';

describe('createAiRuntimeClient', () => {
  it('creates an OpenAI client for openai configs', () => {
    const create = vi.fn();
    const client = createAiRuntimeClient(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5-mini',
      },
      {
        openAiClientFactory: () => ({
          responses: {
            create,
          },
          models: {
            retrieve: vi.fn(),
          },
        }),
      },
    );

    expect(client.provider).toBe('openai');
    expect(client.model).toBe('gpt-5-mini');
  });

  it('creates an Ollama client for ollama configs', () => {
    const client = createAiRuntimeClient(
      {
        provider: 'ollama',
        baseUrl: 'http://ollama:11434',
        model: 'qwen3:8b',
      },
      {
        httpTransport: {
          getJson: vi.fn(),
          postJson: vi.fn(),
        },
      },
    );

    expect(client.provider).toBe('ollama');
    expect(client.model).toBe('qwen3:8b');
  });
});
