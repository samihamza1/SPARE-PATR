import { errorResponseSchema } from '@autoparts/shared';
import type { ErrorCode } from '@autoparts/shared';

/** Same-origin `/api` (proxied by Vite in development); override with VITE_API_URL. */
const BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export type ApiErrorCode = ErrorCode | 'network';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(code);
    this.name = 'ApiRequestError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

/** JSON fetch with the session cookie. Errors carry the API's stable error code. */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } catch {
    throw new ApiRequestError(0, 'network');
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(data);
    if (!parsed.success) throw new ApiRequestError(res.status, 'server.error');
    throw new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.issues ?? []);
  }
  return data as T;
}

export const isUnauthenticated = (error: unknown): boolean =>
  error instanceof ApiRequestError && error.status === 401;
