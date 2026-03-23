/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies Ollama URL and version helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  isOllamaVersionSupported,
  normalizeOllamaBaseUrl,
  parseOllamaVersion,
} from '../src/modules/ai/runtime/ollama-ai-client.version';

describe('ollama-ai-client.version', () => {
  it('normalizes root URLs', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeOllamaBaseUrl('https://ollama.internal')).toBe('https://ollama.internal');
  });

  it('rejects URLs with extra path/query state', () => {
    expect(() => normalizeOllamaBaseUrl('http://localhost:11434/api')).toThrow(
      'Ollama URLs must point to the server root without extra path segments.',
    );
    expect(() => normalizeOllamaBaseUrl('http://localhost:11434?x=1')).toThrow(
      'Ollama URLs cannot include query strings or fragments.',
    );
  });

  it('parses semver-style versions and enforces minimum support', () => {
    expect(parseOllamaVersion('v0.13.3')).toEqual({ major: 0, minor: 13, patch: 3 });
    expect(isOllamaVersionSupported('0.13.3')).toBe(true);
    expect(isOllamaVersionSupported('0.14.0')).toBe(true);
    expect(isOllamaVersionSupported('0.13.2')).toBe(false);
  });
});
