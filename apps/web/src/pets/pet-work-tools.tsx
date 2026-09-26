import { pets, type PetConnection, type PetToolCall, type NixClient } from '@nix/api-client';
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

export function PetWorkTools({
  runtime,
  workspaceId,
  petId,
  onChange,
  client,
}: {
  readonly runtime: PetConnection;
  readonly workspaceId: string;
  readonly petId: string;
  readonly onChange: (value: PetConnection) => void;
  readonly client: NixClient;
}): ReactElement {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decisions, setDecisions] = useState<Record<string, string>>({});

  function decisionKey(tool: PetToolCall) {
    return `tool:${workspaceId}:${petId}:${tool.id}`;
  }

  async function resolve(
    tool: PetToolCall,
    approved: boolean,
    fence?: StructureFingerprint,
    refusalResult?: string,
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
        pets.runtime({ operation: 'tool_claim', workspaceId, petId, toolId: tool.id, requestId }),
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
              mode: 'chat',
              toolId: tool.id,
              claimId: requestId,
              ...(fence === undefined ? {} : { fence }),
            },
          );
          toolResult = outcome.text;
          toolSuccess = true;
          if (!outcome.readOnly) {
            client.invalidate(['items']);
            for (const parent of outcome.touchedParents)
              notifyItemChildrenChanged(workspaceId, parent);
            const args = workspaceToolSchema.parse(JSON.parse(tool.arguments));
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
          toolId: tool.id,
          requestId,
          toolResult,
          toolSuccess,
        }),
        { signal },
      );
      onChange(result);
    } catch {
      setError(
        'The operation could not be confirmed. Refresh and inspect Nix before asking for this change again.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
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
  submitted,
  onResolve,
}: {
  readonly tool: PetToolCall;
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly busy: boolean;
  readonly submitted?: string;
  readonly onResolve: (
    tool: PetToolCall,
    approved: boolean,
    fence?: StructureFingerprint,
    refusalResult?: string,
  ) => Promise<void>;
}): ReactElement {
  const [state, setState] = useState<ToolPreviewState>({ loading: true });
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

  return (
    <div className="flex flex-col gap-2 rounded border border-divider p-3">
      <Text variant="h3" as="h3">
        {parsed.success ? 'Proposed action' : 'Unsupported tool request'}
      </Text>
      {model ? <PetStructurePreview model={model} /> : null}
      {(!currentPreview || state.loading) && parsed.success ? (
        <Text variant="note">Preparing the preview...</Text>
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
              void onResolve(tool, true, currentPreview ? state.prepared?.fingerprint : undefined);
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
