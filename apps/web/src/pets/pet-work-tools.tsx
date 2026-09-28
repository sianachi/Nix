import { items, pets, type PetConnection, type PetToolCall, type NixClient } from '@nix/api-client';
import {
  READ_ONLY_OPERATIONS,
  WorkspaceToolRefusal,
  workspaceToolSchema,
  type WorkspaceToolArgs,
} from '@nix/companion/tool-args';
import type { PreviewModel, Problem } from '@nix/structure-spec';
import { Button, Card, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { readActionReceipt, writeActionReceipt } from './action-receipts';
import { notifyItemChildrenChanged } from '../lib/item-children-changed';
import { PetStructurePreview } from './pet-structure-preview';
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
const DECLINED_FOR_PROBLEMS_PREFIX = 'Declined: the design has problems.';

/** Reads, and checking a design in Design mode, never write. There is nothing here for the
 * owner to approve after the fact - only whether it ran at all, which `readReadWithoutAsking`
 * governs - so these are never shown as a card, and never load a mutation preview. */
function isAutoReadOperation(operation: WorkspaceToolArgs['operation']): boolean {
  return READ_ONLY_OPERATIONS.has(operation) || operation === 'validate_blueprint';
}

/** The one-line sentence a read (or a design check) is announced by, before its result is
 * known. Plain and specific enough that a person scanning a long turn can tell what happened
 * without opening anything. */
function describeReadOperation(args: WorkspaceToolArgs): string {
  switch (args.operation) {
    case 'list_items':
      return 'Listed items';
    case 'search':
      return args.query ? `Searched for "${args.query}"` : 'Searched the workspace';
    case 'read_item':
      return 'Read an item';
    case 'read_note':
      return 'Read a note';
    case 'read_structure':
      return "Read an item's structure";
    case 'list_templates':
      return 'Listed templates';
    case 'read_template':
      return 'Read a template';
    case 'validate_blueprint':
      return 'Checked the design';
    default:
      return 'Ran a read-only request';
  }
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

  const needsDecision = (runtime.tools ?? [])
    .filter((tool) => {
      if (tool.status !== 'pending') return false;
      const key = decisionKey(tool);
      if (decisions[key] || readActionReceipt(key)) return false;
      let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
      try {
        parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
      } catch {
        return true;
      }
      return !(parsed.success && isAutoReadOperation(parsed.data.operation) && readWithoutAsking);
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
  async function resolve(
    tool: PetToolCall,
    approved: boolean,
    fence?: StructureFingerprint,
    refusalResult?: string,
    reportProgress?: (completed: number, total: number) => void,
  ) {
    const key = decisionKey(tool);
    if (lock.current || tool.status !== 'pending' || decisions[key] || readActionReceipt(key))
      return;
    lock.current = true;
    const submitted = approved
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
        const receipt =
          build === undefined
            ? args.operation === 'save_as_template'
              ? 'Template saved.'
              : 'Completed.'
            : build.complete
              ? `Built ${String(completed)} of ${String(build.ledger.length)}.`
              : `Stopped after ${String(completed)} of ${String(build.ledger.length)}.`;
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
      setError(
        'The operation could not be confirmed. Refresh and inspect Nix before asking for this change again.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
      setProgress((old) =>
        Object.fromEntries(Object.entries(old).filter(([id]) => id !== tool.id)),
      );
    }
  }

  return (
    <section aria-label="Nix work requests" className="flex flex-col gap-3">
      {(runtime.tools ?? []).map((tool) => (
        <PetWorkToolCard
          key={tool.id}
          tool={tool}
          client={client}
          workspaceId={workspaceId}
          petName={petName}
          busy={busy}
          readWithoutAsking={readWithoutAsking}
          progress={progress[tool.id]}
          onBuildProgress={(message) => {
            setProgress((old) => ({ ...old, [tool.id]: message }));
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
) => Promise<void>;

/** One line: an icon-free status word or two, next to what happened. Used for every read (and
 * design check) - which never need a decision - and for a write once it has one, so a long turn
 * reads as a list of outcomes rather than a stack of forms. */
function ActivityRow({
  sentence,
  status,
  details,
  actions,
}: {
  readonly sentence: string;
  readonly status: string;
  readonly details: string | undefined;
  readonly actions: ReactElement | undefined;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1 border-b border-divider py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text variant="bodySmall">{sentence}</Text>
        <Text variant="note" role="status" tone="muted">
          {status}
        </Text>
      </div>
      {actions}
      {details ? (
        <details>
          <summary>
            <Text as="span" variant="note">
              Result details
            </Text>
          </summary>
          <Text variant="note" className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
            {details}
          </Text>
        </details>
      ) : null}
    </div>
  );
}

function runningLabel(args: WorkspaceToolArgs): string {
  return args.operation === 'validate_blueprint'
    ? 'Checking the design (no workspace access).'
    : 'Running…';
}

function readStatusText(
  tool: PetToolCall,
  args: WorkspaceToolArgs,
  autoRun: boolean,
  submitted: string | undefined,
) {
  if (tool.status === 'pending') {
    // An auto-run keeps its own running label even once its (identical, internal) submission
    // receipt exists - that receipt is bookkeeping against a repeat prompt, not something the
    // owner asked for, so it never gets to say so on their behalf.
    if (autoRun) return runningLabel(args);
    if (submitted) return submitted;
    return 'Waiting for your approval';
  }
  if (tool.status === 'claimed') return runningLabel(args);
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
    if (!autoRun || tool.status !== 'pending' || submitted || busy || autoRunKey.current === tool.id)
      return;
    autoRunKey.current = tool.id;
    void onResolve(tool, true);
  }, [autoRun, tool, submitted, busy, onResolve]);

  const needsClick = !autoRun && tool.status === 'pending' && !submitted;
  return (
    <ActivityRow
      sentence={describeReadOperation(args)}
      status={readStatusText(tool, args, autoRun, submitted)}
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

/** A write once it has an outcome: approved and run, declined, or auto-declined because its
 * preview had problems. The full approval card (rendered inline in `PetWorkToolCard` below) only
 * shows before that - see `isCompactWrite`. */
function WriteReceiptRow({
  tool,
  problems,
  petName,
  submitted,
  progress,
  cleanup,
}: {
  readonly tool: PetToolCall;
  readonly problems: readonly Problem[];
  readonly petName: string;
  readonly submitted: string | undefined;
  readonly progress: string | undefined;
  readonly cleanup: ReactElement | null | undefined;
}): ReactElement {
  const declinedForProblems = tool.result.startsWith(DECLINED_FOR_PROBLEMS_PREFIX);
  const status = declinedForProblems
    ? `Sent ${String(problems.length)} problem${problems.length === 1 ? '' : 's'} back to ${petName}`
    : tool.status === 'claimed'
      ? 'Claimed for execution. Do not repeat this change.'
      : tool.status === 'pending' && submitted
        ? submitted
        : tool.status === 'failed' && tool.result === DECLINED_BY_USER
          ? 'Declined'
          : tool.status === 'completed' && submitted
            ? submitted
            : tool.status;
  return (
    <ActivityRow
      sentence="Proposed action"
      status={status}
      details={
        declinedForProblems
          ? problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n')
          : tool.result || undefined
      }
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

function PetWorkToolCard({
  tool,
  client,
  workspaceId,
  petName,
  busy,
  readWithoutAsking,
  progress,
  onBuildProgress,
  submitted,
  onResolve,
}: {
  readonly tool: PetToolCall;
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly petName: string;
  readonly busy: boolean;
  readonly readWithoutAsking: boolean;
  readonly progress: string | undefined;
  readonly onBuildProgress: (message: string) => void;
  readonly submitted?: string;
  readonly onResolve: Resolver;
}): ReactElement {
  const [state, setState] = useState<ToolPreviewState>({ loading: true });
  const autoDeclineKey = useRef('');
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
    if (!hasProblems || busy || autoDeclineKey.current === tool.id) return;
    autoDeclineKey.current = tool.id;
    void onResolve(tool, false, undefined, problemResult);
  }, [hasProblems, busy, tool, problemResult, onResolve]);

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
  const isCompactWrite =
    args !== undefined && (tool.status !== 'pending' || Boolean(submitted) || problems.length > 0);
  if (isCompactWrite) {
    return (
      <WriteReceiptRow
        tool={tool}
        problems={problems}
        petName={petName}
        submitted={submitted}
        progress={progress}
        cleanup={cleanup}
      />
    );
  }

  return (
    <Card title={parsed.success ? 'Proposed action' : 'Unsupported tool request'} headingLevel={3}>
      {model ? <PetStructurePreview model={model} captureSummary={args?.operation === 'save_as_template'} /> : null}
      {!currentPreview || state.loading ? <Text variant="note">Preparing the preview...</Text> : null}
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
      {args?.markdown ? (
        // Security fix M3: a pending approval never folds or collapses the write it is being
        // asked to approve, however long - the owner must see everything it would write before
        // deciding, not a 300-character preview behind a click. Folding stays allowed only on
        // the compact receipt a write gets once it already has an outcome - see
        // `WriteReceiptRow`'s own "Result details" disclosure.
        <>
          <Text variant="note" className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
            {args.markdown}
          </Text>
          <Text variant="note" tone="muted">
            {args.markdown.length.toLocaleString('en-US')} characters
          </Text>
        </>
      ) : null}
      {args?.propertiesJson ? (
        <Text variant="note" className="whitespace-pre-wrap break-words">
          {args.propertiesJson}
        </Text>
      ) : null}
      {itemId ? (
        <Link className="underline" to={`/w/${workspaceId}?item=${itemId}`}>
          Inspect target item
        </Link>
      ) : null}
      {parentId ? (
        <Link className="underline" to={`/w/${workspaceId}?item=${parentId}`}>
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
