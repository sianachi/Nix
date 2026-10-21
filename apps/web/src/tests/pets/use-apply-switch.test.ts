import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useApplySwitch } from '../../pets/conversation/state/use-apply-switch';

const base = { workspaceId: 'w', petId: 'p', savedDefault: true, readOnly: false };

describe('useApplySwitch on (re)mount', () => {
  it('never auto-applies a write that was already waiting when the conversation loaded', () => {
    const { result, rerender } = renderHook(
      (props: { loaded: boolean; pendingToolIds: readonly string[] }) =>
        useApplySwitch({ ...base, needsDecisionIds: [], ...props }),
      { initialProps: { loaded: false, pendingToolIds: [] as readonly string[] } },
    );
    rerender({ loaded: true, pendingToolIds: ['waiting'] });
    expect(result.current.applyWithoutAsking).toBe(true);
    expect(result.current.applyExemptToolIds).toEqual(['waiting']);
    // A write that arrives after the load is covered by the switch.
    rerender({ loaded: true, pendingToolIds: ['waiting', 'later'] });
    expect(result.current.applyExemptToolIds).toEqual(['waiting']);
  });
});
