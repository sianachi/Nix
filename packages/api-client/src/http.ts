/**
 * The one axios instance for the entire frontend.
 *
 * axios is an implementation detail that stops here. Nothing outside this file
 * imports it, and the instance itself is never returned: `createHttpTransport`
 * hands back an `HttpTransport` - a capability with two of our own types on it
 * - so no consumer can reach for an interceptor, mutate defaults, or make a
 * request that skips the auth, error and cache layers stacked on top.
 *
 * The transport is deliberately dumb. It performs a request and reports what
 * came back, including non-2xx statuses, because the auth layer above it needs
 * to see a 401 before anyone turns it into an error. Only transport-level
 * failures - no connection, timeout, cancellation - are thrown here, already
 * mapped onto NixApiError so callers never touch an AxiosError.
 *
 * `withErrorMapping` is the layer that turns non-2xx responses into typed
 * errors. Stack order, outermost first: error mapping, authentication,
 * transport - so a refreshed 401 retry happens before anything becomes an
 * error, exactly as the engineering plan specifies.
 */

import axios, { type AxiosInstance } from 'axios';
import { NixApiError } from './errors.js';
import { parseAtBoundary } from './parse.js';
import { problemDetailsSchema } from './schemas/problem-details.js';
import { report, type NixTelemetry } from './telemetry.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type QueryValue = string | number | boolean;

export interface HttpRequest {
  readonly method: HttpMethod;
  /** Path relative to the configured base URL; must start with `/`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue | undefined>> | undefined;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Cancellation is plumbed through every layer; nothing is unabortable. */
  readonly signal?: AbortSignal | undefined;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON, or `undefined` for an empty body such as 204 No Content. */
  readonly body: unknown;
}

/** The only capability the rest of the package has to reach the network. */
export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpTransportOptions {
  /** Absolute base URL of Core, e.g. `https://api.nix.example/v1`. */
  readonly baseUrl: string;
  /** Whole-request budget. Defaults to 15 seconds. */
  readonly timeoutMs?: number | undefined;
  readonly defaultHeaders?: Readonly<Record<string, string>> | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const JSON_CONTENT_TYPE = 'application/json';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

function headerValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = (value as readonly unknown[])
      .map(headerValue)
      .filter((part) => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(', ');
  }
  return undefined;
}

function toHeaderRecord(headers: unknown): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  if (typeof headers !== 'object' || headers === null) return record;
  for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
    const value = headerValue(raw);
    if (value === undefined) continue;
    record[name.toLowerCase()] = value;
  }
  return record;
}

function toParams(
  query: Readonly<Record<string, QueryValue | undefined>> | undefined,
): Record<string, string> | undefined {
  if (query === undefined) return undefined;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params[name] = String(value);
  }
  return params;
}

function toTransportError(
  error: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): NixApiError {
  if (signal?.aborted === true || axios.isCancel(error)) return NixApiError.canceled(error);
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return NixApiError.timeout(timeoutMs, error);
    }
    return NixApiError.network(error);
  }
  return NixApiError.network(error);
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const instance: AxiosInstance = axios.create({
    baseURL: options.baseUrl,
    timeout: timeoutMs,
    // Bearer tokens only; the client never relies on ambient cookies.
    withCredentials: false,
    // Statuses are data at this layer - see the header comment.
    validateStatus: () => true,
    // Makes a timeout surface as ETIMEDOUT rather than a generic abort.
    transitional: { clarifyTimeoutError: true },
    headers: { Accept: `${JSON_CONTENT_TYPE}, ${PROBLEM_CONTENT_TYPE}` },
  });

  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      if (!request.path.startsWith('/')) {
        throw new TypeError(
          `Request path must be relative to the base URL and start with "/": ${request.path}`,
        );
      }
      const headers: Record<string, string> = { ...options.defaultHeaders, ...request.headers };
      if (request.body !== undefined) headers['Content-Type'] = JSON_CONTENT_TYPE;

      try {
        const response = await instance.request({
          method: request.method,
          url: request.path,
          params: toParams(request.query),
          data: request.body,
          headers,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        return {
          status: response.status,
          headers: toHeaderRecord(response.headers),
          body: response.data === '' || response.data === null ? undefined : response.data,
        };
      } catch (error) {
        throw toTransportError(error, timeoutMs, request.signal);
      }
    },
  };
}

/**
 * Turns non-2xx responses into typed errors.
 *
 * A body sent as `application/problem+json` is parsed with the problem-details
 * schema, so the stable `code` survives onto the error. A problem document
 * that fails to parse is a broken contract: the parse boundary emits telemetry
 * and the caller still receives a usable `http.<status>` error rather than a
 * validation error about the error.
 */
export function withErrorMapping(
  inner: HttpTransport,
  telemetry: NixTelemetry | undefined,
): HttpTransport {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      let response: HttpResponse;
      try {
        response = await inner.send(request);
      } catch (error) {
        if (error instanceof NixApiError && error.kind !== 'canceled') {
          report(telemetry?.onRequestError, {
            method: request.method,
            path: request.path,
            status: error.status,
            code: error.code,
            kind: error.kind,
          });
        }
        throw error;
      }

      if (response.status >= 200 && response.status < 300) return response;

      const error = toResponseError(request, response, telemetry);
      report(telemetry?.onRequestError, {
        method: request.method,
        path: request.path,
        status: response.status,
        code: error.code,
        kind: error.kind,
      });
      throw error;
    },
  };
}

function toResponseError(
  request: HttpRequest,
  response: HttpResponse,
  telemetry: NixTelemetry | undefined,
): NixApiError {
  const contentType = response.headers['content-type'] ?? '';
  if (!contentType.includes(PROBLEM_CONTENT_TYPE)) return NixApiError.fromStatus(response.status);
  try {
    const problem = parseAtBoundary(problemDetailsSchema, response.body, {
      operation: `${request.method} ${request.path} (problem details)`,
      status: response.status,
      telemetry,
    });
    return NixApiError.fromProblemDetails(response.status, problem);
  } catch {
    return NixApiError.fromStatus(response.status);
  }
}
