import { beforeEach, describe, expect, it } from 'vitest';

import {
  readTabOrientation,
  storeTabOrientation,
  useTabOrientationStore,
} from '../../tabs/tab-orientation-store';

function memoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

describe('reading the stored preference', () => {
  it('defaults to horizontal when nothing is stored', () => {
    expect(readTabOrientation(memoryStorage())).toBe('horizontal');
  });

  it('defaults to horizontal when storage is unavailable', () => {
    expect(readTabOrientation(undefined)).toBe('horizontal');
  });

  it('reads a stored vertical preference back', () => {
    const storage = memoryStorage();
    storeTabOrientation(storage, 'vertical');

    expect(readTabOrientation(storage)).toBe('vertical');
  });

  it('never stores the default, so a later reader cannot tell "never chosen" from "chose it"', () => {
    const storage = memoryStorage();
    storeTabOrientation(storage, 'vertical');
    storeTabOrientation(storage, 'horizontal');

    expect(storage.getItem('nix.tab-orientation')).toBeNull();
  });
});

describe('toggling the orientation', () => {
  beforeEach(() => {
    useTabOrientationStore.setState({ orientation: 'horizontal' });
  });

  it('switches from horizontal to vertical and back', () => {
    useTabOrientationStore.getState().orientationToggled();
    expect(useTabOrientationStore.getState().orientation).toBe('vertical');

    useTabOrientationStore.getState().orientationToggled();
    expect(useTabOrientationStore.getState().orientation).toBe('horizontal');
  });
});
