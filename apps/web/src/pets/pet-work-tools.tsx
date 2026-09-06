import {
  pets,
  runWorkspaceTool,
  workspaceToolSchema,
  WorkspaceToolRefusal,
  type PetConnection,
  type PetToolCall,
  type NixClient,
} from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { readActionReceipt, writeActionReceipt } from './action-receipts';
import { notifyItemChildrenChanged } from '../lib/item-children-changed';

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
  async function resolve(tool: PetToolCall, approved: boolean) {
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
      let toolResult = 'Declined by the user. Do not retry this change unless asked.';
      let toolSuccess = false;
      if (approved) {
        try {
          const { createCompanionBodies } = await import('./companion-bodies');
          toolResult = await runWorkspaceTool(
            client,
            workspaceId,
            tool.arguments,
            createCompanionBodies(client),
            signal,
          );
          toolSuccess = true;
          const operation = workspaceToolSchema.parse(JSON.parse(tool.arguments)).operation;
          if (
            !['list_items', 'search', 'read_item', 'read_note', 'read_schema'].includes(operation)
          ) {
            client.invalidate(['items']);
            notifyItemChildrenChanged(workspaceId, null);
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
      {(runtime.tools ?? []).map((tool) => {
        const submitted = decisions[decisionKey(tool)] ?? readActionReceipt(decisionKey(tool));
        let preview: ReturnType<typeof workspaceToolSchema.safeParse>;
        try {
          preview = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
        } catch {
          preview = workspaceToolSchema.safeParse(null);
        }
        return (
          <div key={tool.id} className="flex flex-col gap-2 rounded border border-divider p-3">
            <Text variant="h3" as="h3">
              {preview.success ? 'Proposed action' : 'Unsupported tool request'}
            </Text>
            {preview.success ? (
              <>
                <Text>{describeWorkspaceAction(preview.data)}</Text>
                {preview.data.title ? <Text>{preview.data.title}</Text> : null}
                {preview.data.query ? (
                  <Text variant="note">Search: {preview.data.query}</Text>
                ) : null}
                {preview.data.itemId ? (
                  <Link className="underline" to={`/w/${workspaceId}?item=${preview.data.itemId}`}>
                    Inspect target item
                  </Link>
                ) : null}
                {preview.data.parentId ? (
                  <Link
                    className="underline"
                    to={`/w/${workspaceId}?item=${preview.data.parentId}`}
                  >
                    Inspect destination
                  </Link>
                ) : null}
                {preview.data.markdown ? (
                  <Text
                    variant="note"
                    className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words"
                  >
                    {preview.data.markdown}
                  </Text>
                ) : null}
                {preview.data.propertiesJson ? (
                  <Text variant="note" className="whitespace-pre-wrap break-words">
                    {preview.data.propertiesJson}
                  </Text>
                ) : null}
                <Text variant="note" tone="muted">
                  {['list_items', 'search', 'read_item', 'read_note', 'read_schema'].includes(
                    preview.data.operation,
                  )
                    ? 'Approval sends the retrieved workspace content to ChatGPT.'
                    : 'Approval applies this change using your Nix permissions.'}
                </Text>
              </>
            ) : (
              <Text variant="note">
                This request is unsupported. Decline it so the companion can try a supported
                operation.
              </Text>
            )}
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
                <Text
                  variant="note"
                  className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words"
                >
                  {tool.result}
                </Text>
              </details>
            ) : null}
            {tool.status === 'pending' && !submitted ? (
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={busy || !preview.success}
                  onClick={() => {
                    void resolve(tool, true);
                  }}
                >
                  Approve request
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void resolve(tool, false);
                  }}
                >
                  Decline request
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      {error ? <Text role="alert">{error}</Text> : null}
    </section>
  );
}

function describeWorkspaceAction(action: ReturnType<typeof workspaceToolSchema.parse>): string {
  switch (action.operation) {
    case 'list_items':
      return action.parentId
        ? 'I will list the items inside the linked destination to find what to work on.'
        : 'I will list the top-level items in this workspace to find what to work on.';
    case 'search':
      return `I will search this workspace for “${action.query}” to find matching items.`;
    case 'read_item':
      return 'I will read the linked item’s details and properties.';
    case 'read_note':
      return 'I will read the linked note’s content for context.';
    case 'read_schema':
      return 'I will read the linked item’s property schema to check which fields can be used.';
    case 'create_note':
      return `I will create a note named “${action.title}” ${action.parentId ? 'inside the linked destination' : 'at the top level of this workspace'}${action.markdown ? ', with the content shown below' : ', with an empty body'}.`;
    case 'append_note':
      return 'I will add the content below to the end of the linked note, preserving its existing content.';
    case 'rename_item':
      return `I will rename the linked item to “${action.title}”.`;
    case 'move_item':
      return `I will move the linked item ${action.parentId ? 'inside the linked destination' : 'to the top level of this workspace'}.`;
    case 'set_properties':
      return 'I will update the linked item with the property values shown below, leaving other properties unchanged.';
    case 'trash_item':
      return 'I will move the linked item to Trash. It can be restored later.';
    case 'restore_item':
      return 'I will restore the linked item from Trash.';
  }
}
