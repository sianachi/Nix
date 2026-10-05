import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useCanHover, useCoarsePointer } from '../../layout/viewport';
import { stubViewport } from '../stub-viewport';

function stubPointer(coarse: boolean): void {
  globalThis.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: query.includes('coarse') ? coarse : query.includes('hover') ? !coarse : true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

describe('pointer facts, asked apart from width', () => {
  afterEach(() => {
    stubViewport(true);
  });

  it('reports a mouse as fine and able to hover', () => {
    stubViewport(true);

    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false);
    expect(renderHook(() => useCanHover()).result.current).toBe(true);
  });

  it('reports a touch screen as coarse and unable to hover, whatever its width', () => {
    stubPointer(true);

    expect(renderHook(() => useCoarsePointer()).result.current).toBe(true);
    expect(renderHook(() => useCanHover()).result.current).toBe(false);
  });
});
