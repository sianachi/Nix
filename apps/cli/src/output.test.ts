import { describe, expect, it } from 'vitest';
import { NixApiError } from '@nix/api-client';
import { ExitCode, outputOptions, printError, printResult, toFailure } from './output.ts';

describe('printResult', () => {
  it('emits compact JSON when stdout is not a terminal', () => {
    let out = '';
    printResult({ a: 1 }, outputOptions(false, { isTTY: false }), (line) => (out += line));
    expect(out).toBe('{"a":1}\n');
  });

  it('pretty-prints when stdout is a terminal and --json was not asked for', () => {
    let out = '';
    printResult({ a: 1 }, outputOptions(false, { isTTY: true }), (line) => (out += line));
    expect(out).toBe('{\n  "a": 1\n}\n');
  });

  it('stays compact on a terminal when --json is forced', () => {
    let out = '';
    printResult({ a: 1 }, outputOptions(true, { isTTY: true }), (line) => (out += line));
    expect(out).toBe('{"a":1}\n');
  });
});

describe('toFailure', () => {
  it('maps a 404 problem to the not-found code and keeps Core its own words', () => {
    const error = NixApiError.fromProblemDetails(404, {
      code: 'items.not_found',
      title: 'Not found',
      detail: 'No item 123 is visible.',
    });
    expect(toFailure(error)).toEqual({
      message: 'No item 123 is visible.',
      code: ExitCode.NotFound,
    });
  });

  it('maps a 403 to the refused code', () => {
    const error = NixApiError.fromProblemDetails(403, {
      code: 'auth.insufficient_scope',
      detail: 'Out of scope.',
    });
    expect(toFailure(error).code).toBe(ExitCode.Refused);
  });

  it('maps a 401 to the refused code', () => {
    const error = NixApiError.fromProblemDetails(401, {
      code: 'auth.token_revoked',
      detail: 'Revoked.',
    });
    expect(toFailure(error).code).toBe(ExitCode.Refused);
  });

  it('gives a plain error the general code and its own message', () => {
    expect(toFailure(new Error('boom'))).toEqual({ message: 'boom', code: ExitCode.General });
  });
});

describe('printError', () => {
  it('writes the message to the error stream and returns the code', () => {
    let err = '';
    const code = printError(new Error('nope'), (line) => (err += line));
    expect(err).toBe('nope\n');
    expect(code).toBe(ExitCode.General);
  });
});
