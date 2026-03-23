/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module provides shared runtime request/response helpers.
 */

import { AiRuntimeError } from './ai-runtime.errors';
import type { AiGenerateRequest, AiUsageSnapshot } from './ai-runtime.types';

export function validateGenerateRequest(request: AiGenerateRequest): AiGenerateRequest {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AiRuntimeError('invalid_config', 'AI request must include at least one message.');
  }

  const messages = request.messages
    .map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content.trim() : '',
    }))
    .filter((message) => message.content.length > 0);

  if (messages.length === 0) {
    throw new AiRuntimeError('invalid_config', 'AI request must include at least one message.');
  }

  return {
    ...request,
    messages,
  };
}

export function buildMessageInput(messages: AiGenerateRequest['messages']) {
  return messages.map((message) => ({
    role: message.role,
    content: [
      {
        type: 'input_text',
        text: message.content,
      },
    ],
  }));
}

export function parseUsageSnapshot(value: unknown): AiUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const usage = value as Record<string, unknown>;
  return {
    inputTokens: toNumberOrNull(usage.input_tokens),
    outputTokens: toNumberOrNull(usage.output_tokens),
    reasoningTokens: toNumberOrNullFromDetails(usage.output_tokens_details),
    totalTokens: toNumberOrNull(usage.total_tokens),
  };
}

export function normalizeStatus(status: unknown): 'completed' | 'incomplete' | 'failed' {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'incomplete') {
    return 'incomplete';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'completed';
}

export function normalizeFinishReason(
  status: unknown,
  providerError: unknown,
): 'stop' | 'length' | 'error' | 'unknown' {
  if (status === 'completed') {
    return 'stop';
  }
  if (status === 'incomplete') {
    return 'length';
  }
  if (status === 'failed' || providerError) {
    return 'error';
  }
  return 'unknown';
}

export function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNumberOrNullFromDetails(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const details = value as Record<string, unknown>;
  return toNumberOrNull(details.reasoning_tokens);
}
