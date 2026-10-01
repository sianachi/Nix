import {
  isCanceledError,
  principal as principalResource,
  type CurrentPrincipal,
} from '@nix/api-client';
import { useEffect, useMemo, useState } from 'react';

import { useOptionalApiClient } from '../../api/api-client-provider';
import type { ViewFilterRule } from './container-model';
import { ME_TOKEN, type RuleContext } from './filter-rules';
import { readerToday } from './timestamps';

const PRINCIPAL_KEY = ['me'] as const;

/**
 * What the client-side rules need from outside the item: the reader's day, and who `me` is.
 *
 * **The principal is only asked for when a rule says `me`.** Every container view evaluates rules,
 * and most never name a person; a request per view mount for an answer nothing reads is a request
 * the shell has usually already made, so the cached answer is read first and the network is the
 * fallback.
 */
export function useRuleContext(rules: readonly ViewFilterRule[]): RuleContext {
  // Optional, because a view rendered with no client above it - a story, a component test - still
  // evaluates every rule but `me`, which then resolves to nobody.
  const client = useOptionalApiClient();
  const needsPrincipal = rules.some((rule) => rule.value === ME_TOKEN);

  const [principalId, setPrincipalId] = useState<string | null>(
    () => client?.cache.peek<CurrentPrincipal>(PRINCIPAL_KEY)?.data.id ?? null,
  );

  useEffect(() => {
    if (client === null || !needsPrincipal || principalId !== null) return;

    const controller = new AbortController();
    client
      .query(principalResource.currentPrincipal(), { signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) setPrincipalId(loaded.id);
      })
      .catch((reason: unknown) => {
        // Unknown stays unknown: `me` then matches nothing, which is the honest answer to a rule
        // about a person this screen could not identify. Cancellation is the unmount, not a failure.
        if (!isCanceledError(reason)) setPrincipalId(null);
      });

    return () => {
      controller.abort();
    };
  }, [client, needsPrincipal, principalId]);

  // The day is read per render and memoised by its text, so the context's identity - an input to
  // the filter pipeline - only changes when the date does.
  const today = readerToday();
  return useMemo(() => ({ today, principalId }), [today, principalId]);
}
