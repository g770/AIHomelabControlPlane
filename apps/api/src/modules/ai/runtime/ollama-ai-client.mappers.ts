/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module maps Ollama payloads into neutral runtime structures.
 */

import type { AiModelInfo, AiUsageSnapshot } from './ai-runtime.types';

export function mapOllamaModels(value: unknown): AiModelInfo[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.models)) {
    return [];
  }

  return envelope.models
    .map((model) => mapOllamaModel(model))
    .filter((model): model is AiModelInfo => model !== null);
}

export function mapOllamaOutputText(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  const envelope = value as Record<string, unknown>;
  if (typeof envelope.output_text === 'string') {
    return envelope.output_text;
  }

  if (!Array.isArray(envelope.output)) {
    return '';
  }

  const textParts: string[] = [];
  for (const item of envelope.output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (record.type === 'output_text' && typeof record.text === 'string') {
      textParts.push(record.text);
      continue;
    }

    if (!Array.isArray(record.content)) {
      continue;
    }

    for (const contentItem of record.content) {
      if (
        contentItem &&
        typeof contentItem === 'object' &&
        !Array.isArray(contentItem) &&
        typeof (contentItem as Record<string, unknown>).text === 'string'
      ) {
        textParts.push((contentItem as Record<string, unknown>).text as string);
      }
    }
  }

  return textParts.join('').trim();
}

export function mapOllamaUsage(value: unknown): AiUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const usage = value as Record<string, unknown>;
  return {
    inputTokens: toNumberOrNull(usage.input_tokens),
    outputTokens: toNumberOrNull(usage.output_tokens),
    reasoningTokens: null,
    totalTokens: toNumberOrNull(usage.total_tokens),
  };
}

export function extractOllamaErrorSummary(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const error = value as Record<string, unknown>;
  return typeof error.message === 'string'
    ? error.message
    : typeof error.error === 'string'
      ? error.error
      : null;
}

function mapOllamaModel(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const model = value as Record<string, unknown>;
  const details =
    model.details && typeof model.details === 'object' && !Array.isArray(model.details)
      ? (model.details as Record<string, unknown>)
      : null;
  const id =
    typeof model.name === 'string'
      ? model.name
      : typeof model.model === 'string'
        ? model.model
        : null;

  if (!id) {
    return null;
  }

  return {
    id,
    modifiedAt: typeof model.modified_at === 'string' ? model.modified_at : null,
    sizeBytes: toNumberOrNull(model.size),
    family: typeof details?.family === 'string' ? details.family : null,
    parameterSize: typeof details?.parameter_size === 'string' ? details.parameter_size : null,
    quantizationLevel:
      typeof details?.quantization_level === 'string' ? details.quantization_level : null,
  };
}

function toNumberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
