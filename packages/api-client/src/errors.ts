/**
 * Every failure that leaves this package is a NixApiError.
 *
 * Consumers branch on two typed fields and never on text:
 *
 *   - `kind` separates the classes of failure that need different UI: a
 *     problem document from Core, an HTTP response that was not a problem
 *     document, a network fault, a timeout, a caller-initiated cancellation,
 *     and a response that did not match its schema.
 *   - `code` is the stable machine-readable discriminator. For problem
 *     documents it is Core's `code` extension member, passed through verbatim.
 *     For everything else it is one of the `NixErrorCode` client codes or
 *     `http.<status>`.
 *
 * `title` and `detail` are human-facing strings. They are safe to display and
 * unsafe to switch on; nothing in the frontend may string-match them.
 *
 * Instance checks go through `isNixApiError`, which uses a registered symbol
 * rather than `instanceof`, so an error still identifies correctly if two
 * copies of this package end up in one bundle.
 */

import type { ProblemDetails } from './schemas/problem-details.js';
import type { ParseIssue } from './telemetry.js';

export const NixErrorKind = {
  /** Core answered with an RFC 9457 problem document. */
  Problem: 'problem',
  /** Non-2xx response that was not a problem document (proxy, gateway, ...). */
  Http: 'http',
  /** The request never reached a server, or the connection dropped. */
  Network: 'network',
  /** The request exceeded the configured timeout. */
  Timeout: 'timeout',
  /** An AbortSignal supplied by the caller fired. */
  Canceled: 'canceled',
  /** The response arrived but did not match its schema. */
  ResponseValidation: 'response_validation',
  /** A durable asynchronous operation reached a failed or cancelled terminal state. */
  Operation: 'operation',
} as const;

export type NixErrorKind = (typeof NixErrorKind)[keyof typeof NixErrorKind];

/** Stable codes for failures that originate on the client, not in Core. */
export const NixErrorCode = {
  Network: 'client.network',
  Timeout: 'client.timeout',
  Canceled: 'client.canceled',
  ResponseValidation: 'client.response_validation',
} as const;

export type NixErrorCode = (typeof NixErrorCode)[keyof typeof NixErrorCode];

/** Code used when a non-2xx response carried no problem document. */
export function httpStatusCode(status: number): string {
  return `http.${String(status)}`;
}

const NIX_API_ERROR = Symbol.for('nix.api-client.NixApiError');

export interface NixApiErrorOptions {
  readonly kind: NixErrorKind;
  readonly code: string;
  readonly message: string;
  readonly status?: number | undefined;
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly type?: string | undefined;
  readonly instance?: string | undefined;
  readonly traceId?: string | undefined;
  readonly validationErrors?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly issues?: readonly ParseIssue[] | undefined;
  readonly cause?: unknown;
}

const NO_VALIDATION_ERRORS: Readonly<Record<string, readonly string[]>> = Object.freeze({});
const NO_ISSUES: readonly ParseIssue[] = Object.freeze([]);

export class NixApiError extends Error {
  readonly [NIX_API_ERROR] = true;
  override readonly name = 'NixApiError';
  readonly kind: NixErrorKind;
  readonly code: string;
  readonly status: number | undefined;
  readonly title: string | undefined;
  readonly detail: string | undefined;
  /** RFC 9457 `type` URI, when Core supplied one. */
  readonly type: string | undefined;
  readonly instance: string | undefined;
  /** Correlates with the server-side trace; show it in support surfaces. */
  readonly traceId: string | undefined;
  /** Field name to messages, empty when the failure was not a validation one. */
  readonly validationErrors: Readonly<Record<string, readonly string[]>>;
  /** Schema issues, populated only for `response_validation`. */
  readonly issues: readonly ParseIssue[];

  constructor(options: NixApiErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status;
    this.title = options.title;
    this.detail = options.detail;
    this.type = options.type;
    this.instance = options.instance;
    this.traceId = options.traceId;
    this.validationErrors = options.validationErrors ?? NO_VALIDATION_ERRORS;
    this.issues = options.issues ?? NO_ISSUES;
  }

  /** Core answered with a problem document; `code` is Core's stable code. */
  static fromProblemDetails(status: number, problem: ProblemDetails): NixApiError {
    return new NixApiError({
      kind: NixErrorKind.Problem,
      code: problem.code,
      message: problem.title ?? problem.code,
      status: problem.status ?? status,
      title: problem.title,
      detail: problem.detail,
      type: problem.type,
      instance: problem.instance,
      traceId: problem.traceId,
      validationErrors: problem.errors,
    });
  }

  /** Non-2xx response without a usable problem document. */
  static fromStatus(status: number, detail?: string): NixApiError {
    return new NixApiError({
      kind: NixErrorKind.Http,
      code: httpStatusCode(status),
      message: `Request failed with status ${String(status)}`,
      status,
      detail,
    });
  }

  static network(cause: unknown): NixApiError {
    return new NixApiError({
      kind: NixErrorKind.Network,
      code: NixErrorCode.Network,
      message: 'The request did not reach the server',
      cause,
    });
  }

  static timeout(timeoutMs: number, cause: unknown): NixApiError {
    return new NixApiError({
      kind: NixErrorKind.Timeout,
      code: NixErrorCode.Timeout,
      message: `The request exceeded its ${String(timeoutMs)}ms timeout`,
      cause,
    });
  }

  static canceled(cause?: unknown): NixApiError {
    return new NixApiError({
      kind: NixErrorKind.Canceled,
      code: NixErrorCode.Canceled,
      message: 'The request was cancelled by the caller',
      cause,
    });
  }

  static responseValidation(
    operation: string,
    issues: readonly ParseIssue[],
    status: number | undefined,
  ): NixApiError {
    return new NixApiError({
      kind: NixErrorKind.ResponseValidation,
      code: NixErrorCode.ResponseValidation,
      message: `The response for ${operation} did not match its schema`,
      status,
      issues,
    });
  }

  static operation(code: string, detail: string, canceled: boolean): NixApiError {
    return new NixApiError({
      kind: canceled ? NixErrorKind.Canceled : NixErrorKind.Operation,
      code,
      message: detail,
      detail,
    });
  }
}

export function isNixApiError(error: unknown): error is NixApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Partial<Record<typeof NIX_API_ERROR, boolean>>)[NIX_API_ERROR] === true
  );
}

/** True when the failure was a caller-initiated cancellation, not a fault. */
export function isCanceledError(error: unknown): boolean {
  return isNixApiError(error) && error.kind === NixErrorKind.Canceled;
}
