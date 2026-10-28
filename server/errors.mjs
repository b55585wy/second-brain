export class ApiError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function fail(status, code, message, retryable = false) {
  throw new ApiError(status, code, message, retryable);
}

export function requireValue(condition, message, code = 'VALIDATION_ERROR') {
  if (!condition) fail(422, code, message);
}

export function publicError(error) {
  if (error instanceof ApiError) {
    const aliases = { UPSTREAM_UNAUTHORIZED: ['SCOPE_FORBIDDEN', 403], UPSTREAM_FORBIDDEN: ['SCOPE_FORBIDDEN', 403], UPSTREAM_RATE_LIMITED: ['RATE_LIMITED', 429],
      UPSTREAM_HTTP_ERROR: ['UPSTREAM_ERROR', 502], UPSTREAM_INVALID_RESPONSE: ['UPSTREAM_ERROR', 502], UPSTREAM_TOO_LARGE: ['UPSTREAM_ERROR', 502],
      UPSTREAM_UNAVAILABLE: ['CONNECTION_UNAVAILABLE', 503], UNSAFE_PROVIDER_URL: ['VALIDATION_ERROR', 422] };
    const [code, status] = aliases[error.code] ?? [error.code, error.status];
    return { status, body: { error: {
      code, message: error.message, retryable: error.retryable,
    } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: '本地服务处理失败，请重试。', retryable: false } } };
}
