import type { PetToolCall } from '@nix/api-client';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import type { StructureFingerprint } from '@nix/companion';
import type { Problem } from '@nix/structure-spec';
import { Button, Text, cn, focusRing, inkWashStates } from '@nix/ui';
import { useEffect, useRef, type ReactElement } from 'react';
import type { EditedRequest } from '../approval/edit-request';
import {
  APPLYING_WITHOUT_ASKING,
  DECLINED_BY_USER,
  DECLINED_FOR_PROBLEMS_PREFIX,
  DONE_WITHOUT_ASKING,
  NOT_RUN,
  ranWithoutAsking,
} from './receipts';
import { describeReadSentence, readStatusText } from './read-sentence';

export type Resolver = (
  tool: PetToolCall,
  approved: boolean,
  fence?: StructureFingerprint,
  refusalResult?: string,
  reportProgress?: (completed: number, total: number) => void,
  withoutAsking?: boolean,
  refusalQuotesLockedContent?: boolean,
  edited?: EditedRequest,
) => Promise<boolean>;

/** One line: an icon-free status word or two, next to what happened. Used for every read - which
 * never needs a decision - and for a write once it has one, so a long turn reads as a list of
 * outcomes rather than a stack of forms. */
function ActivityRow({
  sentence,
  status,
  details,
  detailsLabel = 'Result details',
  detailsExtra,
  actions,
}: {
  readonly sentence: string;
  readonly status: string;
  readonly details: string | undefined;
  readonly detailsLabel?: string;
  /** Shown above the text details, inside the same disclosure. */
  readonly detailsExtra?: ReactElement | undefined;
  readonly actions: ReactElement | undefined;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-divider py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text variant="bodySmall">{sentence}</Text>
        {/* UX fix U16: this word already sits beside its own sentence, which the row re-renders
         * whenever it changes - a second live-region announcement here was redundant noise. */}
        <Text variant="note" tone="muted">
          {status}
        </Text>
      </div>
      {actions}
      {details || detailsExtra ? (
        <details>
          <summary className={cn('cursor-default rounded', focusRing, inkWashStates)}>
            <Text as="span" variant="note">
              {detailsLabel}
            </Text>
          </summary>
          {detailsExtra}
          {details ? (
            <Text
              variant="note"
              className="max-h-60 overflow-y-auto overscroll-contain whitespace-pre-wrap wrap-anywhere"
            >
              {details}
            </Text>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/** A read, running or done. Never a card: there is nothing here for the
 * owner to approve, only whether it ran. */
export function ReadActivityRow({
  tool,
  args,
  busy,
  autoRun,
  submitted,
  onResolve,
}: {
  readonly tool: PetToolCall;
  readonly args: WorkspaceToolArgs;
  readonly busy: boolean;
  readonly autoRun: boolean;
  readonly submitted: string | undefined;
  readonly onResolve: Resolver;
}): ReactElement {
  const autoRunKey = useRef('');
  useEffect(() => {
    if (
      !autoRun ||
      tool.status !== 'pending' ||
      submitted ||
      busy ||
      autoRunKey.current === tool.id
    )
      return;
    // Security fix S3: only remember this tool as auto-run once `onResolve` actually started it.
    // A second auto-run read that arrives while the first is still claiming returns early (the
    // lock is held) without ever running - if the key were set beforehand, that second read would
    // never be retried. Leaving it unset here lets this effect fire again once `busy` clears.
    void (async () => {
      const started = await onResolve(tool, true);
      if (started) autoRunKey.current = tool.id;
    })();
  }, [autoRun, tool, submitted, busy, onResolve]);

  const needsClick = !autoRun && tool.status === 'pending' && !submitted;
  return (
    <ActivityRow
      sentence={describeReadSentence(tool, args, autoRun)}
      status={readStatusText(tool, autoRun, submitted)}
      details={tool.result || undefined}
      actions={
        needsClick ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void onResolve(tool, true);
              }}
            >
              Approve request
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void onResolve(tool, false);
              }}
            >
              Decline request
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}

/** UX fix U14: the status word a write's receipt shows, mapped from `tool.status` rather than a
 * raw enum - "Done", never "completed"; "Stopped", never "interrupted" - and never the richer
 * internal receipt text a build or a template save also tracks for its own bookkeeping. */
function writeStatusText(
  tool: PetToolCall,
  declinedForProblems: boolean,
  problemCount: number,
  petName: string,
  submitted: string | undefined,
): string {
  if (declinedForProblems)
    return `Sent ${String(problemCount)} problem${problemCount === 1 ? '' : 's'} back to ${petName}`;
  // The receipt says so when the owner's switch, not a click, let this run: a long turn must
  // stay readable as "what ran on its own" against "what I approved", also after reopening.
  const withoutAsking = ranWithoutAsking(submitted);
  switch (tool.status) {
    case 'pending':
      return submitted ?? 'Waiting for your approval';
    case 'claimed':
      return withoutAsking ? APPLYING_WITHOUT_ASKING : 'Applying…';
    case 'completed':
      return withoutAsking ? (submitted ?? DONE_WITHOUT_ASKING) : 'Done';
    case 'failed':
      if (tool.result === DECLINED_BY_USER) return 'Declined';
      if (submitted === NOT_RUN) return NOT_RUN;
      return withoutAsking
        ? "Didn't finish (ran without asking) - check your workspace before retrying"
        : "Didn't finish - check your workspace before retrying";
    case 'interrupted':
      return 'Stopped';
  }
}

/** A write once it has an outcome: approved and run, declined, or auto-declined because its
 * preview had problems. The full approval card (rendered inline in `PetWorkToolCard` below) only
 * shows before that - see `isCompactWrite`. */
export function WriteReceiptRow({
  tool,
  headline,
  problems,
  petName,
  submitted,
  progress,
  cleanup,
  applied,
  ownerReason,
}: {
  readonly tool: PetToolCall;
  /** For a write that was not run: why, in the owner's words. */
  readonly ownerReason?: string | undefined;
  readonly headline: string;
  readonly problems: readonly Problem[];
  /** What a write that ran without asking stored, so the owner can still read it afterwards:
   * the preview they would have approved and every text it carried. */
  readonly applied?: ReactElement | undefined;
  readonly petName: string;
  readonly submitted: string | undefined;
  readonly progress: string | undefined;
  readonly cleanup: ReactElement | null | undefined;
}): ReactElement {
  const declinedForProblems = tool.result.startsWith(DECLINED_FOR_PROBLEMS_PREFIX);
  return (
    <ActivityRow
      sentence={headline}
      status={writeStatusText(tool, declinedForProblems, problems.length, petName, submitted)}
      details={
        declinedForProblems
          ? problems.map((problem) => problem.message).join('\n')
          : submitted === NOT_RUN
            ? ownerReason
            : tool.result || undefined
      }
      detailsLabel={
        declinedForProblems
          ? 'Show problems'
          : submitted === NOT_RUN
            ? 'Why it did not run'
            : applied
              ? 'What was applied'
              : 'Result details'
      }
      detailsExtra={applied}
      actions={
        progress || cleanup ? (
          <div className="flex flex-col gap-2">
            {progress ? (
              <Text variant="note" role="status">
                {progress}
              </Text>
            ) : null}
            {cleanup}
          </div>
        ) : undefined
      }
    />
  );
}
