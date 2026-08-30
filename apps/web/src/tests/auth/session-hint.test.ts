import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetSession, hasSessionHint, rememberSession } from '../../auth/session-hint';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the session restoration hint', () => {
  it('remembers only that a restore is worth attempting, never a token', () => {
    rememberSession();

    expect(hasSessionHint()).toBe(true);
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).not.toMatch(/token/i);

    forgetSession();
    expect(hasSessionHint()).toBe(false);
  });

  it('falls back to no hint when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });

    expect(hasSessionHint()).toBe(false);
  });
});
