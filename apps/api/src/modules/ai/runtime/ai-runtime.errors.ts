/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module defines safe runtime error wrappers for provider adapters.
 */

export type AiRuntimeErrorCode =
  | 'invalid_config'
  | 'auth_failed'
  | 'provider_unreachable'
  | 'unsupported_version'
  | 'model_not_found'
  | 'provider_error'
  | 'unsupported_capability';

export class AiRuntimeError extends Error {
  constructor(
    readonly code: AiRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiRuntimeError';
  }
}

export function isAiRuntimeError(error: unknown): error is AiRuntimeError {
  return error instanceof AiRuntimeError;
}

export function toAiRuntimeError(
  error: unknown,
  fallbackCode: AiRuntimeErrorCode,
  fallbackMessage: string,
) {
  if (isAiRuntimeError(error)) {
    return error;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new AiRuntimeError('provider_unreachable', fallbackMessage);
  }

  return new AiRuntimeError(fallbackCode, fallbackMessage);
}
