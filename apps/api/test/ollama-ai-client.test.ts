/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the Ollama runtime adapter behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { OllamaAiClient } from '../src/modules/ai/runtime/ollama-ai-client';

describe('OllamaAiClient', () => {
  it('validates version/model presence and discovers models', async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: { version: '0.13.3' },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          models: [
            {
              name: 'qwen3:8b',
              modified_at: '2026-03-23T00:00:00.000Z',
              size: 42,
              details: {
                family: 'qwen3',
                parameter_size: '8B',
                quantization_level: 'Q4_K_M',
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { version: '0.13.3' },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          models: [
            {
              name: 'qwen3:8b',
              modified_at: '2026-03-23T00:00:00.000Z',
              size: 42,
              details: {
                family: 'qwen3',
                parameter_size: '8B',
                quantization_level: 'Q4_K_M',
              },
            },
          ],
        },
      });
    const postJson = vi.fn();
    const client = new OllamaAiClient(
      {
        provider: 'ollama',
        baseUrl: 'http://ollama:11434',
        model: 'qwen3:8b',
      },
      {
        getJson,
        postJson,
      },
    );

    await expect(client.validateConfig()).resolves.toEqual({
      ok: true,
      provider: 'ollama',
      normalizedBaseUrl: 'http://ollama:11434',
      providerVersion: '0.13.3',
      availableModelIds: ['qwen3:8b'],
    });
    await expect(client.listModels()).resolves.toEqual({
      supported: true,
      provider: 'ollama',
      fetchedAt: expect.any(String),
      models: [
        {
          id: 'qwen3:8b',
          modifiedAt: '2026-03-23T00:00:00.000Z',
          sizeBytes: 42,
          family: 'qwen3',
          parameterSize: '8B',
          quantizationLevel: 'Q4_K_M',
        },
      ],
    });
    expect(getJson).toHaveBeenNthCalledWith(1, 'http://ollama:11434/api/version', {
      headers: undefined,
    });
    expect(getJson).toHaveBeenNthCalledWith(3, 'http://ollama:11434/api/version', {
      headers: undefined,
    });
  });

  it('omits auth headers when no token is configured and maps generate output safely', async () => {
    const getJson = vi.fn();
    const postJson = vi.fn().mockResolvedValue({
      status: 200,
      json: {
        id: 'resp_ollama',
        status: 'completed',
        output_text: 'Hello from Ollama',
      },
    });
    const client = new OllamaAiClient(
      {
        provider: 'ollama',
        baseUrl: 'http://ollama:11434',
        model: 'qwen3:8b',
      },
      {
        getJson,
        postJson,
      },
    );

    await expect(
      client.generate({
        messages: [{ role: 'user', content: 'Hello' }],
        reasoningSummary: 'auto',
      }),
    ).resolves.toEqual({
      provider: 'ollama',
      model: 'qwen3:8b',
      outputText: 'Hello from Ollama',
      status: 'completed',
      finishReason: 'stop',
      requestId: 'resp_ollama',
      reasoningSummary: [],
      usage: null,
      debug: {
        providerStatus: 'completed',
        providerError: null,
      },
    });
    expect(postJson).toHaveBeenCalledWith(
      'http://ollama:11434/v1/responses',
      {
        model: 'qwen3:8b',
        input: [{ role: 'user', content: 'Hello' }],
      },
      {
        headers: undefined,
      },
    );
  });

  it('sends bearer auth when a token is configured and returns safe validation failures', async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: { version: '0.13.2' },
      });
    const client = new OllamaAiClient(
      {
        provider: 'ollama',
        baseUrl: 'http://ollama:11434',
        model: 'qwen3:8b',
        apiKey: 'ollama-token',
      },
      {
        getJson,
        postJson: vi.fn(),
      },
    );

    await expect(client.validateConfig()).resolves.toEqual({
      ok: false,
      provider: 'ollama',
      code: 'unsupported_version',
      message: 'Configured Ollama instance is older than 0.13.3.',
    });
    expect(getJson).toHaveBeenCalledWith('http://ollama:11434/api/version', {
      headers: {
        Authorization: 'Bearer ollama-token',
      },
    });
  });

  it('surfaces unsupported-version errors when discovering models', async () => {
    const client = new OllamaAiClient(
      {
        provider: 'ollama',
        baseUrl: 'http://ollama:11434',
        model: 'qwen3.5:latest',
      },
      {
        getJson: vi.fn().mockResolvedValue({
          status: 200,
          json: { version: '0.13.2' },
        }),
        postJson: vi.fn(),
      },
    );

    await expect(client.listModels()).rejects.toMatchObject({
      code: 'unsupported_version',
      message: 'Configured Ollama instance is older than 0.13.3.',
    });
  });
});
