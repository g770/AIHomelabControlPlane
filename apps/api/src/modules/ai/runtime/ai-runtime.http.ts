/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the HTTP transport seam for AI runtime adapters.
 */

import { AiRuntimeError } from './ai-runtime.errors';
import type { AiHttpTransport } from './ai-runtime.types';

type FetchLike = typeof fetch;

export function createFetchAiHttpTransport(fetchImpl: FetchLike = fetch): AiHttpTransport {
  return {
    async getJson(url, init) {
      const response = await fetchImpl(url, {
        ...init,
        method: 'GET',
      });

      return parseJsonResponse(response);
    },
    async postJson(url, body, init) {
      const response = await fetchImpl(url, {
        ...init,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
        body: JSON.stringify(body),
      });

      return parseJsonResponse(response);
    },
  };
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return {
      status: response.status,
      json: {},
    };
  }

  try {
    return {
      status: response.status,
      json: JSON.parse(text) as unknown,
    };
  } catch {
    throw new AiRuntimeError('provider_error', 'AI provider returned an invalid JSON response.');
  }
}
