/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the OpenAI runtime adapter behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { OpenAiClient } from '../src/modules/ai/runtime/openai-ai-client';

describe('OpenAiClient', () => {
  it('maps generate requests and responses into the neutral result shape', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'resp_123',
      status: 'completed',
      output_text: 'Hello world',
      output: [
        {
          type: 'reasoning',
          summary: [{ text: 'Step one' }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        output_tokens_details: {
          reasoning_tokens: 2,
        },
      },
    });
    const retrieve = vi.fn().mockResolvedValue({ id: 'gpt-5-mini' });
    const client = new OpenAiClient(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5-mini',
      },
      () => ({
        responses: {
          create,
        },
        models: {
          retrieve,
        },
      }),
    );

    await expect(
      client.generate({
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'Say hello.' },
        ],
        maxOutputTokens: 128,
        temperature: 0.2,
        topP: 0.8,
        reasoningSummary: 'auto',
      }),
    ).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      outputText: 'Hello world',
      status: 'completed',
      finishReason: 'stop',
      requestId: 'resp_123',
      reasoningSummary: ['Step one'],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 2,
        totalTokens: 14,
      },
      debug: {
        providerStatus: 'completed',
        providerError: null,
      },
    });
    expect(create).toHaveBeenCalledWith({
      model: 'gpt-5-mini',
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: 'You are concise.' }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Say hello.' }],
        },
      ],
      max_output_tokens: 128,
      temperature: 0.2,
      top_p: 0.8,
      reasoning: {
        summary: 'auto',
      },
    });
    await expect(client.validateConfig()).resolves.toEqual({
      ok: true,
      provider: 'openai',
    });
    expect(retrieve).toHaveBeenCalledWith('gpt-5-mini');
  });

  it('returns safe auth validation failures', async () => {
    const client = new OpenAiClient(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5-mini',
      },
      () => ({
        responses: {
          create: vi.fn(),
        },
        models: {
          retrieve: vi.fn().mockRejectedValue({ status: 401 }),
        },
      }),
    );

    await expect(client.validateConfig()).resolves.toEqual({
      ok: false,
      provider: 'openai',
      code: 'auth_failed',
      message: 'Invalid OpenAI API key.',
    });
  });
});
