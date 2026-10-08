import { z } from 'zod';

/** Error from the API (or the network), with a code the renderer can switch on. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export interface HttpRequest<T> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  accessToken?: string;
  /** Every response is validated; the main process never trusts the network blindly. */
  schema: z.ZodType<T>;
}

export interface HttpClient {
  request<T>(request: HttpRequest<T>): Promise<T>;
}

/**
 * Talks to apps/api. Only the API base URL is configured on the client; no
 * Supabase keys of any kind are bundled into Electron.
 */
export function createHttpClient(baseUrl: string, fetchImpl: typeof fetch = fetch): HttpClient {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async request<T>({ method, path, body, accessToken, schema }: HttpRequest<T>): Promise<T> {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
      let response: Response;
      try {
        response = await fetchImpl(`${root}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
      }
      const text = await response.text();
      let json: unknown = undefined;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new ApiError(
            response.status,
            'invalid_response',
            'The server sent an invalid response.',
          );
        }
      }
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(json);
        throw parsed.success
          ? new ApiError(response.status, parsed.data.error.code, parsed.data.error.message)
          : new ApiError(response.status, 'http_error', `Request failed (${response.status})`);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          response.status,
          'invalid_response',
          'The server sent an unexpected response.',
        );
      }
      return parsed.data;
    },
  };
}
