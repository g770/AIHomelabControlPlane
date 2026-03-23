/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module provides Ollama URL and version helpers.
 */

import { AiRuntimeError } from './ai-runtime.errors';

export const MIN_OLLAMA_VERSION = '0.13.3';

export function normalizeOllamaBaseUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new AiRuntimeError('invalid_config', 'Enter an Ollama base URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AiRuntimeError('invalid_config', 'Enter a valid Ollama base URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiRuntimeError('invalid_config', 'Ollama URLs must use http or https.');
  }
  if (parsed.search || parsed.hash) {
    throw new AiRuntimeError(
      'invalid_config',
      'Ollama URLs cannot include query strings or fragments.',
    );
  }
  if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new AiRuntimeError(
      'invalid_config',
      'Ollama URLs must point to the server root without extra path segments.',
    );
  }

  parsed.pathname = '';
  return parsed.toString().replace(/\/$/, '');
}

export function parseOllamaVersion(input: string) {
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isOllamaVersionSupported(
  currentVersion: string,
  minimumVersion: string = MIN_OLLAMA_VERSION,
) {
  const current = parseOllamaVersion(currentVersion);
  const minimum = parseOllamaVersion(minimumVersion);
  if (!current || !minimum) {
    return false;
  }

  if (current.major !== minimum.major) {
    return current.major > minimum.major;
  }
  if (current.minor !== minimum.minor) {
    return current.minor > minimum.minor;
  }
  return current.patch >= minimum.patch;
}
