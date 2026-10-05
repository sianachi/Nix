import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { clearPetDrafts, usePetDraft } from '../../pets/pet-drafts';
afterEach(clearPetDrafts);
it('shares the draft across surfaces, isolates workspace and mode, and clears it for sign-out', () => {
  const a = renderHook(() => usePetDraft('workspace', 'pet', 'chat'));
  act(() => {
    a.result.current[1]('Private draft');
  });
  const b = renderHook(() => usePetDraft('workspace', 'pet', 'chat'));
  const other = renderHook(() => usePetDraft('other', 'pet', 'chat'));
  const consult = renderHook(() => usePetDraft('workspace', 'pet', 'consult'));
  expect(b.result.current[0]).toBe('Private draft');
  expect(other.result.current[0]).toBe('');
  expect(consult.result.current[0]).toBe('');
  act(clearPetDrafts);
  expect(a.result.current[0]).toBe('');
  expect(b.result.current[0]).toBe('');
});
