import { items, pets, type PetConnection, type PetToolCall, type NixClient } from '@nix/api-client';
import {
  READ_ONLY_OPERATIONS,
  WorkspaceToolRefusal,
  workspaceToolSchema,
  type WorkspaceToolArgs,
} from '@nix/companion/tool-args';
import { canApplyWithoutAsking, hasExternalLink } from '@nix/companion/auto-apply';
import type { PreviewModel, Problem } from '@nix/structure-spec';
import { Button, Card, Text, cn, focusRing, inkWashStates } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { readActionReceipt, writeActionReceipt } from './action-receipts';
import { notifyItemChildrenChanged } from '../lib/item-children-changed';
import { PetStructurePreview } from './pet-structure-preview';
import { PetBodyEditPreview } from './pet-body-edit-preview';
import type { StructureFingerprint } from '@nix/companion';
import { readReadWithoutAsking, type PetConversationMode } from './device-preferences';

interface PreparedPreview {
  model: PreviewModel;
  fingerprint: StructureFingerprint;
}

interface ToolPreviewState {
  loading: boolean;
  arguments?: string;
  prepared?: PreparedPreview;
  error?: string;
}

type BuildLedger = readonly { nodeId: string; itemId?: string; status?: string }[];

interface BuildOutcome {
  complete: boolean;
  rootId: string | null;
  ledger: readonly { nodeId: string; itemId?: string; status: string }[];
}

const DECLINED_BY_USER = 'Declined by the user. Do not retry this change unless asked.';
/** Whether the switch may ever cover this write: the operation is allowed and none of the text
 * it would store links to another host (see `hasExternalLink`). The title is included because
 * `writeTextItems` lists only bodies, specs and property values. A note body edit also passes the
 * edited block as it will read afterwards (`model.bodyEdit.after`): the find and replace text can
 * join with what is already there into a link neither holds alone. An edit that would drop
 * formatting Markdown cannot carry always waits, so the owner sees the loss before it happens. */
function writeMayRunWithoutAsking(args: WorkspaceToolArgs, model?: PreviewModel): boolean {
  return (
    canApplyWithoutAsking(args.operation) &&
    model?.bodyEdit?.losesFormatting !== true &&
    !hasExternalLink([
      args.title,
      ...writeTextItems(args).map((item) => item.text),
      ...(model?.bodyEdit ? [model.bodyEdit.after] : []),
    ])
  );
}

/** Note body edits show the whole edited block before and after (`PetBodyEditPreview`), which
 * already includes every character the request would store. */
const BODY_EDIT_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set([
  'replace_section',
  'replace_passage',
]);

/** Receipts for a write the owner's "Apply without asking" switch ran (lane F). Stored like
 * every other receipt, so the wording survives closing and reopening the panel, and read back
 * by `ranWithoutAsking` so no card has to remember it. */
const APPLYING_WITHOUT_ASKING = 'Applying without asking…';
const DONE_WITHOUT_ASKING = 'Done without asking';
const WITHOUT_ASKING_SUFFIX = ' Ran without asking.';

function ranWithoutAsking(submitted: string | undefined): boolean {
  return (
    submitted === APPLYING_WITHOUT_ASKING ||
    submitted === DONE_WITHOUT_ASKING ||
    (submitted?.endsWith(WITHOUT_ASKING_SUFFIX) ?? false)
  );
}
const DECLINED_FOR_PROBLEMS_PREFIX = 'Declined: the design has problems.';

/** Reads, and checking a design in Design mode, never write. There is nothing here for the
 * owner to approve after the fact - only whether it ran at all, which `readReadWithoutAsking`
 * governs - so these are never shown as a card, and never load a mutation preview. */
function isAutoReadOperation(operation: WorkspaceToolArgs['operation']): boolean {
  return READ_ONLY_OPERATIONS.has(operation) || operation === 'validate_blueprint';
}

/** The base (infinitive), progressive and past forms of one read (or design check)'s sentence
 * (UX fix U3): "Search for "x"?" while pending, "Searching for "x"" while running, "Searched for
 * "x"" once done. `base` also backs the declined/failed forms - see `describeReadSentence`. */
interface ReadPhrase {
  base: string;
  progressive: string;
  past: string;
}

function readPhrase(args: WorkspaceToolArgs): ReadPhrase {
  switch (args.operation) {
    case 'list_items':
      return { base: 'List items', progressive: 'Listing items', past: 'Listed items' };
    case 'search': {
      const target = args.query ? `for "${args.query}"` : 'the workspace';
      return {
        base: `Search ${target}`,
        progressive: `Searching ${target}`,
        past: `Searched ${target}`,
      };
    }
    case 'read_item':
      return { base: 'Read an item', progressive: 'Reading an item', past: 'Read an item' };
    case 'read_note':
      return { base: 'Read a note', progressive: 'Reading a note', past: 'Read a note' };
    case 'read_structure':
      return {
        base: "Read an item's structure",
        progressive: "Reading an item's structure",
        past: "Read an item's structure",
      };
    case 'list_templates':
      return {
        base: 'List templates',
        progressive: 'Listing templates',
        past: 'Listed templates',
      };
    case 'read_template':
      return {
        base: 'Read a template',
        progressive: 'Reading a template',
        past: 'Read a template',
      };
    case 'validate_blueprint':
      return {
        base: 'Check the design',
        progressive: 'Checking the design',
        past: 'Checked the design',
      };
    default:
      return {
        base: 'Run a read-only request',
        progressive: 'Running a read-only request',
        past: 'Ran a read-only request',
      };
  }
}

function lowerFirst(text: string): string {
  return text.length ? `${text[0]?.toLowerCase() ?? ''}${text.slice(1)}` : text;
}

/** The one-line sentence a read (or a design check) is announced by, shaped by its status (UX
 * fix U3): a question while it waits for approval, present-progressive while it runs, past tense
 * once it is done, and "Didn't"/"Couldn't" once it is declined or failed - the same five-way
 * pattern for every read operation and for checking a design. */
function describeReadSentence(
  tool: PetToolCall,
  args: WorkspaceToolArgs,
  autoRun: boolean,
): string {
  const phrase = readPhrase(args);
  if (tool.status === 'pending') {
    // An auto-run read is never actually waiting on the owner, even while the server has not
    // yet turned its status to "claimed" - see `readStatusText`'s own note on the same race.
    return autoRun ? phrase.progressive : `${phrase.base}?`;
  }
  if (tool.status === 'claimed') return phrase.progressive;
  if (tool.status === 'completed') return phrase.past;
  if (tool.status === 'failed' && tool.result === DECLINED_BY_USER)
    return `Didn't ${lowerFirst(phrase.base)}`;
  return `Couldn't ${lowerFirst(phrase.base)}`;
}

function buildOutcome(text: string): BuildOutcome | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.complete !== 'boolean' ||
      !(candidate.rootId === null || typeof candidate.rootId === 'string') ||
      !Array.isArray(candidate.ledger) ||
      !candidate.ledger.every((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const ledgerEntry = entry as Record<string, unknown>;
        return (
          typeof ledgerEntry.nodeId === 'string' &&
          typeof ledgerEntry.status === 'string' &&
          (ledgerEntry.itemId === undefined || typeof ledgerEntry.itemId === 'string')
        );
      })
    )
      return undefined;
    return candidate as unknown as BuildOutcome;
  } catch {
    return undefined;
  }
}

export function PetWorkTools({
  runtime,
  workspaceId,
  petId,
  petName = 'your pet',
  mode = 'chat',
  onChange,
  onNeedsDecisionChange,
  applyWithoutAsking = false,
  applyExemptToolIds = [],
  client,
}: {
  readonly runtime: PetConnection;
  readonly workspaceId: string;
  readonly petId: string;
  readonly petName?: string;
  readonly mode?: PetConversationMode;
  readonly onChange: (value: PetConnection) => void;
  /** Reports the ids of the pending tools that are waiting on the owner - never a read that runs
   * without asking, nor one already decided - so the header, avatar and launcher only say
   * "needs approval" when that is true. Called whenever the set changes. */
  readonly onNeedsDecisionChange?: (toolIds: readonly string[]) => void;
  /** Lane F (docs/plans/pet-tool-use-plan.md): the owner's per-conversation switch to run clean
   * writes without a click. Only `canApplyWithoutAsking` writes whose preview loaded with no
   * problems run on their own; a preview that failed, or a write with problems, still waits. */
  readonly applyWithoutAsking?: boolean;
  /** Writes that were already waiting on screen when the switch was turned on. The switch only
   * covers what arrives after it: one tap on a ghost button must not approve a card the owner
   * was in the middle of reading. */
  readonly applyExemptToolIds?: readonly string[];
  readonly client: NixClient;
}): ReactElement {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [buildLedgers, setBuildLedgers] = useState<
    Partial<Record<PetConversationMode, BuildLedger>>
  >({});
  const [readWithoutAsking, setReadWithoutAsking] = useState(() => readReadWithoutAsking());
  // Whether a pending write's own preview has problems, reported by each `PetWorkToolCard` once
  // its preview loads. A write with problems is auto-declined (see `hasProblems` below) rather
  // than shown to the owner, so it must never count towards `needsDecision` either.
  const [hasProblems, setHasProblems] = useState<Record<string, boolean>>({});
  // Whether a pending write's preview failed to load, reported by its card. Such a write can
  // never run on its own under `applyWithoutAsking`, so it counts towards `needsDecision`.
  const [previewFailed, setPreviewFailed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const changed = () => {
      setReadWithoutAsking(readReadWithoutAsking());
    };
    window.addEventListener('nix-pet-device-changed', changed);
    return () => {
      window.removeEventListener('nix-pet-device-changed', changed);
    };
  }, []);

  function decisionKey(tool: PetToolCall) {
    return `tool:${workspaceId}:${petId}:${mode}:${tool.id}`;
  }
  function appliesWithoutAsking(tool: PetToolCall) {
    return applyWithoutAsking && !applyExemptToolIds.includes(tool.id);
  }

  const needsDecision = (runtime.tools ?? [])
    .filter((tool) => {
      if (tool.status !== 'pending') return false;
      const key = decisionKey(tool);
      if (decisions[key] || readActionReceipt(key)) return false;
      if (hasProblems[tool.id]) return false;
      let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
      try {
        parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
      } catch {
        return true;
      }
      if (!parsed.success) return true;
      if (isAutoReadOperation(parsed.data.operation) && readWithoutAsking) return false;
      return !(
        appliesWithoutAsking(tool) &&
        writeMayRunWithoutAsking(parsed.data) &&
        !previewFailed[tool.id]
      );
    })
    .map((tool) => tool.id);
  const needsDecisionKey = needsDecision.join(',');
  useEffect(() => {
    onNeedsDecisionChange?.(needsDecisionKey ? needsDecisionKey.split(',') : []);
  }, [needsDecisionKey, onNeedsDecisionChange]);

  // The claim/fence/ledger contract below is security-relevant and must stay behaviourally
  // identical to how it always ran: claim on the server before any write, one approval executes
  // at most once, a fence guards every structure write, and a build ledger resumes a blueprint
  // build exactly where it left off. Only which component calls it, and how its outcome is
  // presented, may change around it.
  // Returns whether this call actually started the decision (security fix S3): a call that
  // returns early because the lock is already held, or the tool is no longer pending, returns
  // false without doing anything. `ReadActivityRow` only remembers a tool as "already auto-run"
  // once this returns true, so a second auto-run read that arrived while the first was still in
  // flight is retried once the first finishes, instead of being silently stalled forever.
  async function resolve(
    tool: PetToolCall,
    approved: boolean,
    fence?: StructureFingerprint,
    refusalResult?: string,
    reportProgress?: (completed: number, total: number) => void,
    withoutAsking = false,
  ): Promise<boolean> {
    const key = decisionKey(tool);
    if (lock.current || tool.status !== 'pending' || decisions[key] || readActionReceipt(key))
      return false;
    lock.current = true;
    // An auto-run never says the owner approved anything: its receipt names the switch from
    // the first moment, the way `readStatusText` guards an auto-run read.
    const submitted = withoutAsking
      ? APPLYING_WITHOUT_ASKING
      : approved
        ? 'Approval submitted. Waiting for confirmation.'
        : 'Declined. Waiting for confirmation.';
    // A stale poll or reopening the panel must not ask for the same decision again.
    // This receipt only hides repeat prompts; the worker claim still gates execution.
    writeActionReceipt(key, submitted);
    setDecisions((old) => ({ ...old, [key]: submitted }));
    setBusy(true);
    setError('');
    const requestId = crypto.randomUUID();
    const signal = AbortSignal.timeout(90000);
    try {
      // Claim on the server BEFORE any write. A lost claim response must never lead to execution.
      const claimed = await client.execute(
        pets.runtime({
          operation: 'tool_claim',
          workspaceId,
          petId,
          mode,
          toolId: tool.id,
          requestId,
        }),
        { signal },
      );
      onChange(claimed);
      const receipt = claimed.tools?.find((value) => value.id === tool.id);
      if (receipt?.status !== 'claimed' || receipt.claimId !== requestId)
        throw new Error('Tool was claimed elsewhere.');
      let toolResult = refusalResult ?? DECLINED_BY_USER;
      let toolSuccess = false;
      if (approved) {
        try {
          const { runWorkspaceTool, createCompanionBodies, defaultClock, defaultIds } =
            await import('@nix/companion');
          const args = workspaceToolSchema.parse(JSON.parse(tool.arguments));
          const ledger = args.operation === 'save_as_template' ? buildLedgers[mode] : undefined;
          const outcome = await runWorkspaceTool(
            {
              core: client,
              collab: client,
              bodies: createCompanionBodies(client),
              clock: defaultClock(),
              ids: defaultIds(),
            },
            workspaceId,
            tool.arguments,
            signal,
            {
              mode,
              toolId: tool.id,
              claimId: requestId,
              ...(fence === undefined ? {} : { fence }),
              ...(ledger === undefined ? {} : { buildLedger: ledger }),
              ...(reportProgress === undefined ? {} : { onProgress: reportProgress }),
            },
          );
          toolResult = outcome.text;
          toolSuccess = true;
          if (args.operation === 'build_blueprint') {
            const build = buildOutcome(outcome.text);
            if (build?.complete) setBuildLedgers((old) => ({ ...old, [mode]: build.ledger }));
          }
          if (!outcome.readOnly) {
            client.invalidate(['items']);
            for (const parent of outcome.touchedParents)
              notifyItemChildrenChanged(workspaceId, parent);
            if (args.operation === 'apply_template') client.invalidate(['templates']);
          }
        } catch (reason) {
          toolResult =
            reason instanceof WorkspaceToolRefusal
              ? reason.message
              : 'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.';
        }
      }
      const result = await client.execute(
        pets.runtime({
          operation: 'tool_result',
          workspaceId,
          petId,
          mode,
          toolId: tool.id,
          requestId,
          toolResult,
          toolSuccess,
        }),
        { signal },
      );
      onChange(result);
      if (approved && toolSuccess) {
        const args = workspaceToolSchema.parse(JSON.parse(tool.arguments));
        const build = args.operation === 'build_blueprint' ? buildOutcome(toolResult) : undefined;
        const completed = build?.ledger.filter((entry) => entry.status === 'done').length;
        const outcome =
          build === undefined
            ? args.operation === 'save_as_template'
              ? 'Template saved.'
              : 'Completed.'
            : build.complete
              ? `Built ${String(completed)} of ${String(build.ledger.length)}.`
              : `Stopped after ${String(completed)} of ${String(build.ledger.length)}.`;
        const receipt = !withoutAsking
          ? outcome
          : outcome === 'Completed.'
            ? DONE_WITHOUT_ASKING
            : outcome + WITHOUT_ASKING_SUFFIX;
        writeActionReceipt(key, receipt);
        setDecisions((old) => ({ ...old, [key]: receipt }));
      } else if (!approved) {
        // Mirrors the approved branch above: once the `tool_result` POST for a decline - a
        // plain user decline, or an automatic one sent back for a design's problems - has
        // succeeded, its receipt reads "Declined" rather than staying on the submitted message.
        writeActionReceipt(key, 'Declined');
        setDecisions((old) => ({ ...old, [key]: 'Declined' }));
      }
    } catch {
      // UX fix U23: name the recovery, not the failure - reload from the menu, then check the
      // workspace, before asking the pet again.
      setError(
        "We couldn't confirm this change. Reload the conversation from the menu and check your workspace before asking again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      setProgress((old) =>
        Object.fromEntries(Object.entries(old).filter(([id]) => id !== tool.id)),
      );
    }
    return true;
  }

  const tools = runtime.tools ?? [];
  // UX fix U16: the section - and its label - only exist when there is something to show.
  if (tools.length === 0) return <></>;

  return (
    <section aria-label={`${petName}'s activity`} className="flex flex-col gap-3">
      {tools.map((tool) => (
        <PetWorkToolCard
          key={tool.id}
          tool={tool}
          client={client}
          workspaceId={workspaceId}
          petName={petName}
          busy={busy}
          readWithoutAsking={readWithoutAsking}
          applyWithoutAsking={appliesWithoutAsking(tool)}
          progress={progress[tool.id]}
          onBuildProgress={(message) => {
            setProgress((old) => ({ ...old, [tool.id]: message }));
          }}
          onProblemsChange={(problems) => {
            setHasProblems((old) =>
              old[tool.id] === problems ? old : { ...old, [tool.id]: problems },
            );
          }}
          onPreviewFailedChange={(failed) => {
            setPreviewFailed((old) =>
              old[tool.id] === failed ? old : { ...old, [tool.id]: failed },
            );
          }}
          submitted={decisions[decisionKey(tool)] ?? readActionReceipt(decisionKey(tool))}
          onResolve={resolve}
        />
      ))}
      {error ? <Text role="alert">{error}</Text> : null}
    </section>
  );
}

type Resolver = (
  tool: PetToolCall,
  approved: boolean,
  fence?: StructureFingerprint,
  refusalResult?: string,
  reportProgress?: (completed: number, total: number) => void,
  withoutAsking?: boolean,
) => Promise<boolean>;

/** One line: an icon-free status word or two, next to what happened. Used for every read (and
 * design check) - which never need a decision - and for a write once it has one, so a long turn
 * reads as a list of outcomes rather than a stack of forms. */
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
    <div className="flex flex-col gap-1 border-b border-divider py-2 last:border-b-0">
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
              className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words"
            >
              {details}
            </Text>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function readStatusText(tool: PetToolCall, autoRun: boolean, submitted: string | undefined) {
  if (tool.status === 'pending') {
    // An auto-run keeps its own running label even once its (identical, internal) submission
    // receipt exists - that receipt is bookkeeping against a repeat prompt, not something the
    // owner asked for, so it never gets to say so on their behalf.
    if (autoRun) return 'Running…';
    if (submitted) return submitted;
    return 'Waiting for your approval';
  }
  if (tool.status === 'claimed') return 'Running…';
  if (tool.status === 'completed') return 'Done';
  if (tool.status === 'failed') return tool.result === DECLINED_BY_USER ? 'Declined' : 'Failed';
  return 'Stopped';
}

/** A read, or a design check, running or done. Never a card: there is nothing here for the
 * owner to approve, only whether it ran. */
function ReadActivityRow({
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
function WriteReceiptRow({
  tool,
  headline,
  problems,
  petName,
  submitted,
  progress,
  cleanup,
  applied,
}: {
  readonly tool: PetToolCall;
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
          : tool.result || undefined
      }
      detailsLabel={
        declinedForProblems ? 'Show problems' : applied ? 'What was applied' : 'Result details'
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

/** One piece of text a pending write would store, with a human label derived from where it sits
 * in the parsed request (security fix S1). */
interface WriteTextItem {
  label: string;
  text: string;
}

const WRITE_TEXT_ARRAY_NOUNS: Record<string, string> = {
  entries: 'Entry',
  fields: 'Field',
  inputs: 'Input',
  pages: 'Page',
  blocks: 'Question',
  views: 'View',
  rules: 'Rule',
};

const WRITE_TEXT_KEY_WORDS: Record<string, string> = {
  markdown: 'body',
  body: 'body',
  help: 'help',
  description: 'description',
  message: 'confirmation message',
  paragraph: 'paragraph',
  heading: 'heading',
  formula: 'formula',
  why: 'why',
  default: 'default',
  title: 'title',
  label: 'label',
  value: 'value',
  query: 'query',
};

function writeTextWord(key: string): string {
  return WRITE_TEXT_KEY_WORDS[key] ?? key.replaceAll(/([A-Z])/g, ' $1').toLowerCase();
}

/** The `label`/`title`/`field`/`heading` a spec array item names itself by, so a nested string
 * (a field's help, a question's confirmation copy) can be labelled by what it belongs to rather
 * than by its position alone. */
function writeTextItemName(record: Record<string, unknown>): string | undefined {
  for (const key of ['label', 'title', 'field', 'heading']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Walks a parsed spec (or the property values of a `set_properties` request) and collects every
 * non-empty string value in it, each with a plain-language label built from its path - "Entry 3
 * body", "Field help: Status" - falling back to a capitalized key name. Security fix S1: nothing
 * a pending write would store may stay off this list, so every string leaf is collected, not just
 * the ones a specific operation is known to care about. */
function collectWriteText(
  value: unknown,
  key: string | undefined,
  arrayNoun: string | undefined,
  itemName: string | undefined,
  out: WriteTextItem[],
): void {
  if (typeof value === 'string') {
    if (!value.trim() || key === undefined) return;
    const word = writeTextWord(key);
    const label =
      itemName !== undefined
        ? `${arrayNoun ?? 'Item'} ${word}: ${itemName}`
        : word.charAt(0).toUpperCase() + word.slice(1);
    out.push({ label, text: value });
    return;
  }
  if (Array.isArray(value)) {
    const noun = key !== undefined ? WRITE_TEXT_ARRAY_NOUNS[key] : undefined;
    value.forEach((item) => {
      const name =
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? writeTextItemName(item as Record<string, unknown>)
          : undefined;
      collectWriteText(item, undefined, noun, name, out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      collectWriteText(nestedValue, nestedKey, arrayNoun, itemName, out);
    }
  }
}

const WRITE_TEXT_SPEC_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set([
  'create_structured',
  'add_view',
  'create_entries',
  'add_fields',
  'edit_form',
  'set_recurrence',
  'apply_template',
  'build_blueprint',
  'save_as_template',
]);

/** Every piece of text a pending write would store, for the section that shows it in full before
 * Approve (security fix S1). */
function writeTextItems(args: WorkspaceToolArgs): WriteTextItem[] {
  const out: WriteTextItem[] = [];
  if (WRITE_TEXT_SPEC_OPERATIONS.has(args.operation) && args.specJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(args.specJson);
      collectWriteText(parsed, undefined, undefined, undefined, out);
    } catch {
      // Invalid JSON is already surfaced as a problem elsewhere; there is nothing to list here.
    }
  }
  if (args.operation === 'set_properties' && args.propertiesJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(args.propertiesJson);
      collectWriteText(parsed, undefined, undefined, undefined, out);
    } catch {
      // ditto
    }
  }
  if (args.markdown.trim()) {
    out.push({
      label:
        args.operation === 'append_note'
          ? 'Added note text'
          : args.operation === 'replace_section'
            ? 'New section text'
            : args.operation === 'replace_passage'
              ? 'Replacement text'
              : 'Note body',
      text: args.markdown,
    });
  }
  return out;
}

/** Security fix S1: every string a pending write would store, in a focusable scroll region so
 * nothing here can hide or truncate behind a click before Approve. */
function WriteTextSection({
  items,
}: {
  readonly items: readonly WriteTextItem[];
}): ReactElement | null {
  if (items.length === 0) return null;
  // Each scroll box is a region, and regions need distinct names: a repeated label (two node
  // titles in a blueprint, say) is numbered so every box can be told apart.
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.label, (totals.get(item.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = items.map((item) => {
    const total = totals.get(item.label) ?? 1;
    if (total === 1) return item.label;
    const position = (seen.get(item.label) ?? 0) + 1;
    seen.set(item.label, position);
    return `${item.label} ${String(position)} of ${String(total)}`;
  });
  return (
    <div className="flex flex-col gap-3">
      <Text variant="note" tone="muted">
        Text this change will write
      </Text>
      {items.map((item, index) => {
        const lineCount = item.text.split('\n').length;
        const name = names[index] ?? item.label;
        return (
          <div key={`${item.label}:${String(index)}`} className="flex flex-col gap-1">
            <Text variant="note" tone="muted">
              {name} ({String(lineCount)} line{lineCount === 1 ? '' : 's'})
            </Text>
            <div
              role="region"
              aria-label={name}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
              tabIndex={0}
              className={cn(
                'max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded border border-divider p-2',
                focusRing,
              )}
            >
              <Text variant="note">{item.text}</Text>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (Array.isArray(value)) return value.map((entry) => formatPropertyValue(entry)).join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value);
}

/** UX fix U15: a `set_properties` request's values as a plain key/value list, alongside (never
 * instead of) `WriteTextSection`'s full text of every string among them. */
function PropertyValueList({
  propertiesJson,
}: {
  readonly propertiesJson: string;
}): ReactElement | null {
  let entries: [string, unknown][] = [];
  try {
    const parsed: unknown = propertiesJson.trim() ? JSON.parse(propertiesJson) : undefined;
    if (
      parsed !== undefined &&
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      entries = Object.entries(parsed as Record<string, unknown>);
    }
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex flex-wrap gap-2">
          <Text as="dt" variant="note" tone="muted">
            {key}
          </Text>
          <Text as="dd" variant="note">
            {formatPropertyValue(value)}
          </Text>
        </div>
      ))}
    </dl>
  );
}

function PetWorkToolCard({
  tool,
  client,
  workspaceId,
  petName,
  busy,
  readWithoutAsking,
  applyWithoutAsking,
  progress,
  onBuildProgress,
  onProblemsChange,
  onPreviewFailedChange,
  submitted,
  onResolve,
}: {
  readonly tool: PetToolCall;
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly petName: string;
  readonly busy: boolean;
  readonly readWithoutAsking: boolean;
  readonly applyWithoutAsking: boolean;
  readonly progress: string | undefined;
  readonly onBuildProgress: (message: string) => void;
  /** Reports whether this tool's own preview has problems, so the owner-facing `needsDecision`
   * count in `PetWorkTools` never includes a write that is about to be auto-declined. */
  readonly onProblemsChange: (hasProblems: boolean) => void;
  /** Reports whether this write's preview failed to load, so `needsDecision` still counts it
   * while `applyWithoutAsking` is on: nothing runs on its own without a clean preview. Also true
   * once a loaded preview shows a note body edit whose resulting text links to another host,
   * which only the preview can tell (`writeMayRunWithoutAsking` with the model). */
  readonly onPreviewFailedChange: (failed: boolean) => void;
  readonly submitted?: string;
  readonly onResolve: Resolver;
}): ReactElement {
  const [state, setState] = useState<ToolPreviewState>({ loading: true });
  const autoDeclineKey = useRef('');
  // Set only once `onResolve` actually started this write on its own (the S3 pattern
  // `ReadActivityRow` follows). The receipt, not this ref, carries "without asking" into the UI.
  const autoApplyKey = useRef('');
  let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
  try {
    parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
  } catch {
    parsed = workspaceToolSchema.safeParse(null);
  }
  const args = parsed.success ? parsed.data : undefined;
  const isReadOp = args !== undefined && isAutoReadOperation(args.operation);

  useEffect(() => {
    const controller = new AbortController();
    let current: ReturnType<typeof workspaceToolSchema.safeParse>;
    try {
      current = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
    } catch {
      current = workspaceToolSchema.safeParse(null);
    }
    // Reads (and design checks) never need a mutation preview - they have nothing to approve,
    // only whether they ran - so the preview-only `@nix/companion` chunk is never fetched for
    // them at all.
    if (!current.success || isAutoReadOperation(current.data.operation)) {
      return () => {
        controller.abort();
      };
    }
    void (async () => {
      try {
        // Keep the yjs-bearing companion package out of the initial web bundle. The card displays
        // an explicit loading state while this preview-only dependency is fetched.
        const {
          createCompanionBodies,
          defaultClock,
          defaultIds,
          describeToolCall,
          loadPreviewContext,
        } = await import('@nix/companion');
        const ports = {
          core: client,
          collab: client,
          bodies: createCompanionBodies(client),
          clock: defaultClock(),
          ids: defaultIds(),
        };
        const context = await loadPreviewContext(
          ports,
          workspaceId,
          current.data,
          controller.signal,
        );
        const model = describeToolCall(current.data, context);
        if (!controller.signal.aborted)
          setState({
            loading: false,
            arguments: tool.arguments,
            prepared: { model, fingerprint: context.fingerprint },
          });
      } catch {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            arguments: tool.arguments,
            error: 'The preview could not be loaded. Decline and ask the pet to try again.',
          });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [tool.arguments, workspaceId, client]);

  const currentPreview = state.arguments === tool.arguments;
  const model = currentPreview ? state.prepared?.model : undefined;
  const problems = model?.problems ?? [];
  const problemResult = `${DECLINED_FOR_PROBLEMS_PREFIX}\n${problems
    .map((problem: Problem) => `${problem.path}: ${problem.message}`)
    .join('\n')}`.slice(0, 16000);
  const itemId = args?.itemId && z.uuid().safeParse(args.itemId).success ? args.itemId : undefined;
  const parentId =
    args?.parentId && z.uuid().safeParse(args.parentId).success ? args.parentId : undefined;
  const autoRun = isReadOp && readWithoutAsking;

  // Invalid writes go straight back to the pet: once a structure write's preview proves it has
  // problems, decline it automatically, once per tool id, in both modes, rather than making the
  // owner click through a request that cannot run.
  const hasProblems = !isReadOp && tool.status === 'pending' && problems.length > 0 && !submitted;
  useEffect(() => {
    onProblemsChange(hasProblems);
  }, [hasProblems, onProblemsChange]);
  useEffect(() => {
    if (!hasProblems || busy || autoDeclineKey.current === tool.id) return;
    // Only remembered once the decline actually started (security fix S3, as for auto-run
    // reads): a decline that lost the lock to another tool is retried once `busy` clears.
    void (async () => {
      const started = await onResolve(tool, false, undefined, problemResult);
      if (started) autoDeclineKey.current = tool.id;
    })();
  }, [hasProblems, busy, tool, problemResult, onResolve]);

  const previewFailed =
    !isReadOp &&
    currentPreview &&
    !state.loading &&
    (Boolean(state.error) ||
      (args !== undefined && model !== undefined && !writeMayRunWithoutAsking(args, model)));
  useEffect(() => {
    onPreviewFailedChange(previewFailed);
  }, [previewFailed, onPreviewFailedChange]);

  // Lane F: with the owner's switch on, a clean write runs exactly as a click on "Approve
  // request" would - same fence, same build progress, same single-flight lock in `resolve` -
  // once its preview has loaded with no problems. The gate below mirrors the button's own
  // `disabled` expression so the switch can never run what the button could not.
  const canAutoApply =
    applyWithoutAsking &&
    !isReadOp &&
    args !== undefined &&
    tool.status === 'pending' &&
    !submitted &&
    currentPreview &&
    !state.loading &&
    model !== undefined &&
    writeMayRunWithoutAsking(args, model) &&
    problems.length === 0 &&
    !state.error;
  useEffect(() => {
    if (!canAutoApply || busy || autoApplyKey.current === tool.id) return;
    const isBuild = args.operation === 'build_blueprint';
    if (isBuild) onBuildProgress('Building the draft...');
    void (async () => {
      const started = await onResolve(
        tool,
        true,
        state.prepared?.fingerprint,
        undefined,
        isBuild
          ? (completed, total) => {
              onBuildProgress(`Building ${String(completed)} of ${String(total)}...`);
            }
          : undefined,
        true,
      );
      if (started) autoApplyKey.current = tool.id;
    })();
  }, [canAutoApply, busy, tool, args, state.prepared, onResolve, onBuildProgress]);

  const incompleteBuild =
    args?.operation === 'build_blueprint' && tool.result ? buildOutcome(tool.result) : undefined;
  const incompleteRootId =
    incompleteBuild?.rootId && z.uuid().safeParse(incompleteBuild.rootId).success
      ? incompleteBuild.rootId
      : undefined;
  const [cleanupStatus, setCleanupStatus] = useState('');
  const [cleanupBusy, setCleanupBusy] = useState(false);

  async function moveIncompleteDraftToTrash(rootId: string): Promise<void> {
    if (!window.confirm('Move the incomplete draft to Trash? It can be restored later.')) return;
    setCleanupBusy(true);
    setCleanupStatus('');
    try {
      const source = await client.query(items.itemById(rootId), { forceRefresh: true });
      if (source.workspaceId !== workspaceId)
        throw new Error('This draft is outside the current workspace.');
      await client.execute(items.deleteItem(workspaceId, rootId), { forceRefresh: true });
      client.invalidate(['items']);
      notifyItemChildrenChanged(workspaceId, source.parentId);
      setCleanupStatus('Incomplete draft moved to Trash.');
    } catch {
      setCleanupStatus('The incomplete draft could not be moved to Trash. Inspect Nix first.');
    } finally {
      setCleanupBusy(false);
    }
  }

  const cleanup =
    incompleteBuild && !incompleteBuild.complete ? (
      <div className="flex flex-col gap-2">
        <Text variant="note" role="status">
          Stopped after{' '}
          {String(incompleteBuild.ledger.filter((entry) => entry.status === 'done').length)} of{' '}
          {String(incompleteBuild.ledger.length)}. The draft is incomplete.
        </Text>
        {incompleteRootId ? (
          <Button
            variant="ghost"
            disabled={cleanupBusy}
            onClick={() => void moveIncompleteDraftToTrash(incompleteRootId)}
          >
            {cleanupBusy ? 'Moving draft to Trash...' : 'Move draft to trash'}
          </Button>
        ) : null}
        {cleanupStatus ? (
          <Text variant="note" role="status">
            {cleanupStatus}
          </Text>
        ) : null}
      </div>
    ) : null;

  if (isReadOp) {
    return (
      <ReadActivityRow
        tool={tool}
        args={args}
        busy={busy}
        autoRun={autoRun}
        submitted={submitted}
        onResolve={onResolve}
      />
    );
  }

  // A write op collapses to a one-line receipt once it has an outcome (a decision, a claim, a
  // problem it is being sent back for), rather than staying a card. The full card below is only
  // for a write still awaiting a first, real decision.
  // A body edit's comparison already shows the whole new block, so its raw replacement text is
  // only listed when there is no comparison to show.
  const textItems = args
    ? writeTextItems(args).filter(
        () => !(model?.bodyEdit && BODY_EDIT_OPERATIONS.has(args.operation)),
      )
    : [];
  const isCompactWrite =
    args !== undefined && (tool.status !== 'pending' || Boolean(submitted) || problems.length > 0);
  if (isCompactWrite) {
    const applied =
      ranWithoutAsking(submitted) && model ? (
        <div className="flex flex-col gap-2">
          <PetStructurePreview model={model} captureSummary={false} />
          {model.bodyEdit ? <PetBodyEditPreview edit={model.bodyEdit} /> : null}
          <WriteTextSection items={textItems} />
        </div>
      ) : undefined;
    return (
      <WriteReceiptRow
        applied={applied}
        tool={tool}
        headline={model?.headline ?? (state.loading ? 'Preparing a summary…' : 'This change')}
        problems={problems}
        petName={petName}
        submitted={submitted}
        progress={progress}
        cleanup={cleanup}
      />
    );
  }

  return (
    <Card
      title={parsed.success ? 'Approve this change?' : 'Unsupported tool request'}
      headingLevel={3}
    >
      {model ? (
        <PetStructurePreview
          model={model}
          captureSummary={args?.operation === 'save_as_template'}
          // Security fix S1: a pending card never folds any part of the tree it is being asked
          // to approve - "Show N more", "Why", and warnings all stay open. Folding is fine again
          // once the write has an outcome, on `WriteReceiptRow`'s own receipt.
          pending
        />
      ) : null}
      {model?.bodyEdit ? <PetBodyEditPreview edit={model.bodyEdit} /> : null}
      {!currentPreview || state.loading ? (
        <Text variant="note">Preparing the preview...</Text>
      ) : null}
      {progress ? (
        <Text variant="note" role="status">
          {progress}
        </Text>
      ) : null}
      {currentPreview && state.error ? (
        <Text variant="note" role="alert">
          {state.error}
        </Text>
      ) : null}
      {!parsed.success ? (
        <Text variant="note">
          This request is unsupported. Decline it so the companion can try a supported operation.
        </Text>
      ) : null}
      {args?.operation === 'set_properties' ? (
        <PropertyValueList propertiesJson={args.propertiesJson} />
      ) : null}
      <WriteTextSection items={textItems} />
      {itemId ? (
        <Link className={cn('underline', focusRing)} to={`/w/${workspaceId}?item=${itemId}`}>
          Inspect target item
        </Link>
      ) : null}
      {parentId ? (
        <Link className={cn('underline', focusRing)} to={`/w/${workspaceId}?item=${parentId}`}>
          Inspect destination
        </Link>
      ) : null}
      <Text variant="note" tone="muted">
        Approval applies this change using your Nix permissions.
      </Text>
      {cleanup}
      {tool.status === 'pending' && !submitted ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={
              busy ||
              !parsed.success ||
              !currentPreview ||
              state.loading ||
              !model ||
              problems.length > 0 ||
              Boolean(state.error)
            }
            onClick={() => {
              const isBuild = args?.operation === 'build_blueprint';
              if (isBuild) onBuildProgress('Building the draft...');
              void onResolve(
                tool,
                true,
                currentPreview ? state.prepared?.fingerprint : undefined,
                undefined,
                isBuild
                  ? (completed, total) => {
                      onBuildProgress(`Building ${String(completed)} of ${String(total)}...`);
                    }
                  : undefined,
              );
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
      ) : null}
    </Card>
  );
}
