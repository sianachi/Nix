import { items, pets, type PetConnection, type PetToolCall, type NixClient } from '@nix/api-client';
import {
  READ_ONLY_OPERATIONS,
  WorkspaceToolRefusal,
  workspaceToolSchema,
} from '@nix/companion/tool-args';
import type { PreviewModel, Problem } from '@nix/structure-spec';
import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { readActionReceipt, writeActionReceipt } from './action-receipts';
import { notifyItemChildrenChanged } from '../lib/item-children-changed';
import { PetStructurePreview } from './pet-structure-preview';
import type { StructureFingerprint } from '@nix/companion';
import type { PetConversationMode } from './device-preferences';

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

const AUTO_RUN_OPERATIONS = new Set(['validate_blueprint']);

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
  mode = 'chat',
  onChange,
  client,
}: {
  readonly runtime: PetConnection;
  readonly workspaceId: string;
  readonly petId: string;
  readonly mode?: PetConversationMode;
  readonly onChange: (value: PetConnection) => void;
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

  function decisionKey(tool: PetToolCall) {
    return `tool:${workspaceId}:${petId}:${mode}:${tool.id}`;
  }

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
      let toolResult =
        refusalResult ?? 'Declined by the user. Do not retry this change unless asked.';
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
          busy={busy}
          mode={mode}
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

function PetWorkToolCard({
  tool,
  client,
  workspaceId,
  busy,
  mode,
  progress,
  onBuildProgress,
  submitted,
  onResolve,
}: {
  readonly tool: PetToolCall;
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly busy: boolean;
  readonly mode: PetConversationMode;
  readonly progress: string | undefined;
  readonly onBuildProgress: (message: string) => void;
  readonly submitted?: string;
  readonly onResolve: (
    tool: PetToolCall,
    approved: boolean,
    fence?: StructureFingerprint,
    refusalResult?: string,
    reportProgress?: (completed: number, total: number) => void,
  ) => Promise<void>;
}): ReactElement {
  const [state, setState] = useState<ToolPreviewState>({ loading: true });
  const autoRunKey = useRef('');
  let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
  try {
    parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
  } catch {
    parsed = workspaceToolSchema.safeParse(null);
  }

  useEffect(() => {
    const controller = new AbortController();
    let current: ReturnType<typeof workspaceToolSchema.safeParse>;
    try {
      current = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
    } catch {
      current = workspaceToolSchema.safeParse(null);
    }
    if (!current.success) {
      return () => {
        controller.abort();
      };
    }
    if (AUTO_RUN_OPERATIONS.has(current.data.operation) && mode === 'consult') {
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
  }, [tool.arguments, workspaceId, client, mode]);

  const args = parsed.success ? parsed.data : undefined;
  const currentPreview = state.arguments === tool.arguments;
  const model = currentPreview ? state.prepared?.model : undefined;
  const problems = model?.problems ?? [];
  const problemResult = `Declined: the design has problems.\n${problems
    .map((problem: Problem) => `${problem.path}: ${problem.message}`)
    .join('\n')}`.slice(0, 16000);
  const itemId = args?.itemId && z.uuid().safeParse(args.itemId).success ? args.itemId : undefined;
  const parentId =
    args?.parentId && z.uuid().safeParse(args.parentId).success ? args.parentId : undefined;
  const autoValidate =
    mode === 'consult' && args !== undefined && AUTO_RUN_OPERATIONS.has(args.operation);

  useEffect(() => {
    const key = `${mode}:${tool.id}`;
    if (
      !autoValidate ||
      tool.status !== 'pending' ||
      submitted ||
      busy ||
      autoRunKey.current === key
    )
      return;
    autoRunKey.current = key;
    void onResolve(tool, true);
  }, [autoValidate, mode, tool, submitted, busy, onResolve]);

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

  return (
    <div className="flex flex-col gap-2 rounded border border-divider p-3">
      <Text variant="h3" as="h3">
        {parsed.success ? 'Proposed action' : 'Unsupported tool request'}
      </Text>
      {model ? <PetStructurePreview model={model} /> : null}
      {(!currentPreview || state.loading) && parsed.success ? (
        <Text variant="note">Preparing the preview...</Text>
      ) : null}
      {autoValidate && tool.status === 'pending' ? (
        <Text variant="note" role="status">
          Checking the design (no workspace access).
        </Text>
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
      {args?.markdown ? (
        <Text variant="note" className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
          {args.markdown}
        </Text>
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
      {args ? (
        <Text variant="note" tone="muted">
          {READ_ONLY_OPERATIONS.has(args.operation)
            ? 'Approval sends the retrieved workspace content to ChatGPT.'
            : 'Approval applies this change using your Nix permissions.'}
        </Text>
      ) : null}
      <Text variant="note" role="status">
        {tool.status === 'claimed'
          ? 'Claimed for execution. Do not repeat this change.'
          : tool.status === 'pending' && submitted
            ? submitted
            : tool.status === 'failed' &&
                tool.result === 'Declined by the user. Do not retry this change unless asked.'
              ? 'Declined'
              : tool.status}
      </Text>
      {tool.result ? (
        <details>
          <summary>
            <Text variant="note">Result details</Text>
          </summary>
          <Text variant="note" className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
            {tool.result}
          </Text>
        </details>
      ) : null}
      {incompleteBuild && !incompleteBuild.complete ? (
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
      ) : null}
      {tool.status === 'pending' && !submitted && !autoValidate ? (
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
          {problems.length ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void onResolve(tool, false, undefined, problemResult);
              }}
            >
              Send problems to pet
            </Button>
          ) : null}
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
    </div>
  );
}
