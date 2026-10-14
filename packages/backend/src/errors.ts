/**
 * Domain errors. Services throw these; the API and signaling layers translate
 * them into HTTP statuses / protocol error frames. Messages are safe to show to
 * the caller: they never include secrets or another user's data.
 */
export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  /** Right password, but the account's email is not confirmed yet. */
  | 'email_not_confirmed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'expired'
  | 'rate_limited'
  | 'unavailable';

const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  email_not_confirmed: 403,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  expired: 410,
  rate_limited: 429,
  unavailable: 503,
};

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: { retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = HTTP_STATUS[code];
  }
}

export const badRequest = (message: string) => new AppError('bad_request', message);
export const unauthenticated = (message = 'Authentication required') =>
  new AppError('unauthenticated', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError('forbidden', message);
/**
 * Use for resources the caller may not see, too: answering 404 instead of 403
 * avoids confirming that another user's device or session exists.
 */
export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const conflict = (message: string) => new AppError('conflict', message);
export const invalidState = (message: string) => new AppError('invalid_state', message);
export const expired = (message: string) => new AppError('expired', message);
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError('rate_limited', 'Too many attempts. Try again later.', { retryAfterSeconds });

/** Postgres SQLSTATE codes we translate. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  insufficientPrivilege: '42501',
  invalidTextRepresentation: '22P02',
} as const;

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
