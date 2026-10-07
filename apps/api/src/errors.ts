import type { ErrorCode } from '@autoparts/shared';

/** An error with a stable, translatable code (invariant 8: the UI owns the wording). */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    /** Field-level problems, shaped like schema validation issues (path, message key). */
    readonly issues?: readonly { path: string; message: string }[],
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export const unauthenticated = () => new ApiError(401, 'auth.unauthenticated');
export const forbidden = () => new ApiError(403, 'auth.forbidden');
export const notFound = () => new ApiError(404, 'resource.not_found');
export const conflict = () => new ApiError(409, 'resource.conflict');
