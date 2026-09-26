import { pets, type NixClient, type PetToolCall } from '@nix/api-client';
import {
  createCompanionBodies,
  defaultClock,
  defaultIds,
  runWorkspaceTool,
  workspaceToolSchema,
  WorkspaceToolRefusal,
} from '@nix/companion';
import { printResult, type OutputOptions } from '../output.ts';
import { openSession, type Session } from '../session.ts';
import { collabClientFor } from './templates.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

const RUNTIME_OPERATIONS = [
  'status',
  'connect',
  'disconnect',
  'models',
  'read',
  'send',
  'interrupt',
  'reset',
  'settings',
  'tool_claim',
  'tool_result',
] as const;
type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

export interface PetOptions {
  readonly apiUrl?: string;
  readonly workspace?: string;
  readonly pet?: string;
  readonly message?: string;
  readonly model?: string;
  readonly workspaceTools?: boolean;
  readonly toolId?: string;
  readonly requestId?: string;
  readonly toolResult?: string;
  readonly toolSuccess?: boolean;
  readonly mode?: string;
}

export interface PetToolRunOptions extends PetOptions {
  readonly approve?: boolean;
  readonly decline?: boolean;
}

/** Matches `pet-work-tools.tsx:84-86`: what the web card says when a claimed write's
 * outcome cannot be trusted, so the pet never assumes success it did not observe. */
const UNCERTAIN_OUTCOME_RESULT =
  'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.';

const DECLINED_RESULT = 'Declined by the user. Do not retry this change unless asked.';

/**
 * Opens the client a pet operation runs as: an interactive `NIX_SESSION_TOKEN` paired with
 * `apiUrl` opens a short-lived session with no stored profile (never expanding PAT scopes),
 * with the collaboration endpoint derived the same way a stored profile's would be; otherwise
 * this resolves the named (or default) profile as usual.
 *
 * Shared by `petCommand`, `petToolRun` and their MCP mirrors, so all four reach Core (and, for
 * `petToolRun`, Collab) with the same credential the moment `NIX_SESSION_TOKEN` is set.
 */
export async function petSessionFor(
  apiUrl: string | undefined,
  profile: string | undefined,
  deps: SessionDeps = {},
  resolve: (
    profileName: string | undefined,
    sessionDeps: SessionDeps,
  ) => Promise<Session> = resolveSession,
): Promise<Session> {
  const env = deps.env ?? process.env;
  const token = env.NIX_SESSION_TOKEN;
  if (token && apiUrl) {
    return openSession({
      profile: { apiUrl, token: '' },
      bearerToken: token,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  return resolve(profile, deps);
}

/**
 * Validates and runs one `pets.runtime` (or `pets.settings`) call: the same operation allowlist,
 * required-field checks and request shape `petCommand` and the `pet_runtime` MCP tool both need,
 * kept in one place so the two surfaces cannot drift apart.
 *
 * @throws When `operation` is unknown, `mode` is neither chat nor consult, a required field for
 * the operation is missing, or Core refuses the call.
 */
export async function executePetRuntime(
  client: NixClient,
  operation: string,
  options: PetOptions,
): Promise<unknown> {
  validatePetRuntimeRequest(operation, options);
  if (operation === 'settings') return client.query(pets.settings());
  return client.execute(
    pets.runtime({
      operation: operation as Exclude<RuntimeOperation, 'settings'>,
      ...(options.workspace ? { workspaceId: options.workspace } : {}),
      ...(options.pet ? { petId: options.pet } : {}),
      text: options.message ?? '',
      model: options.model ?? '',
      workspaceAccess: options.workspaceTools ?? false,
      ...(options.toolId ? { toolId: options.toolId } : {}),
      ...(options.toolResult !== undefined ? { toolResult: options.toolResult } : {}),
      ...(options.toolSuccess !== undefined ? { toolSuccess: options.toolSuccess } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.requestId
        ? { requestId: options.requestId }
        : operation === 'send'
          ? { requestId: crypto.randomUUID() }
          : {}),
    }),
  );
}

function validatePetRuntimeRequest(
  operation: string,
  options: PetOptions,
): asserts options is PetOptions & { readonly mode?: 'chat' | 'consult' } {
  if (!RUNTIME_OPERATIONS.includes(operation as RuntimeOperation))
    throw new Error(`Choose a pet operation: ${RUNTIME_OPERATIONS.join(', ')}.`);
  if (options.mode !== undefined && options.mode !== 'chat' && options.mode !== 'consult')
    throw new Error('--mode must be chat or consult.');
  if (operation === 'send' && !options.message?.trim()) throw new Error('Provide --message.');
  if (
    ['read', 'send', 'interrupt', 'reset', 'tool_claim', 'tool_result'].includes(operation) &&
    (!options.workspace || !options.pet)
  )
    throw new Error('Provide --workspace and --pet.');
  if (operation === 'tool_claim' && !options.toolId) throw new Error('Provide --tool-id.');
  if (operation === 'tool_result' && (!options.toolId || options.toolResult === undefined))
    throw new Error('Provide --tool-id and --tool-result.');
}

/** Interactive account operations require a short-lived BFF token, never expanded PAT scopes. */
export async function petCommand(
  profile: string | undefined,
  operation: string,
  options: PetOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  validatePetRuntimeRequest(operation, options);
  const session = await petSessionFor(options.apiUrl, profile, deps);
  printResult(await executePetRuntime(session.client, operation, options), output);
}

export type PetToolDecision = 'approve' | 'decline' | 'preview';

/**
 * Previews, and on request executes, one pending workspace tool call the same way the web
 * companion panel does: claim before any write, run the exact claimed request through
 * `@nix/companion`, and post its outcome back. Never retries after an uncertain outcome.
 *
 * Shared by the `pet tools run` CLI command and the `pet_tool_run` MCP tool, so both drive the
 * same claim-before-write rule from one place.
 *
 * @throws When the named tool is not pending, or its claim receipt does not match.
 */
export async function executePetToolRun(
  session: Session,
  workspaceId: string,
  petId: string,
  toolId: string,
  decision: PetToolDecision,
): Promise<unknown> {
  const client = session.client;
  const runtime = await client.execute(pets.runtime({ operation: 'read', workspaceId, petId }));
  const tool: PetToolCall | undefined = runtime.tools?.find((entry) => entry.id === toolId);
  if (tool?.status !== 'pending') throw new Error(`Tool ${toolId} is not pending.`);

  // Matches `pet-work-tools.tsx:113-117`: malformed arguments must still resolve to a plain
  // "unsupported" preview, never an uncaught parse error - a corrupt call must stay declinable.
  let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
  try {
    parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
  } catch {
    parsed = workspaceToolSchema.safeParse(null);
  }
  const preview = parsed.success
    ? describeWorkspaceAction(parsed.data)
    : 'This request is unsupported. Decline it so the companion can try a supported operation.';

  if (decision === 'preview') {
    return { toolId, status: tool.status, preview, arguments: tool.arguments };
  }

  const requestId = crypto.randomUUID();
  const claimed = await client.execute(
    pets.runtime({ operation: 'tool_claim', workspaceId, petId, toolId, requestId }),
  );
  const receipt = claimed.tools?.find((entry) => entry.id === toolId);
  if (receipt?.status !== 'claimed' || receipt.claimId !== requestId)
    throw new Error('Tool was claimed elsewhere.');

  let toolResult = DECLINED_RESULT;
  let toolSuccess = false;
  if (decision === 'approve') {
    try {
      const outcome = await runWorkspaceTool(
        {
          core: session.client,
          collab: collabClientFor(session),
          bodies: createCompanionBodies(session.client),
          clock: defaultClock(),
          ids: defaultIds(),
        },
        workspaceId,
        tool.arguments,
        AbortSignal.timeout(90000),
        { toolId, claimId: requestId },
      );
      toolResult = outcome.text;
      toolSuccess = true;
    } catch (reason) {
      toolResult =
        reason instanceof WorkspaceToolRefusal ? reason.message : UNCERTAIN_OUTCOME_RESULT;
      toolSuccess = false;
    }
  }

  try {
    return await client.execute(
      pets.runtime({
        operation: 'tool_result',
        workspaceId,
        petId,
        toolId,
        requestId,
        toolResult,
        toolSuccess,
      }),
    );
  } catch (reason) {
    // The claimed write (if any) may already have happened; posting its outcome is what tells
    // the pet and clears the claim. A failure here must say that plainly, not surface a bare
    // transport error that leaves the caller unsure whether anything happened.
    const cause = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `${toolSuccess ? 'The change was applied, but its' : 'Its'} outcome could not be recorded (${cause}). Refresh and inspect Nix before retrying.`,
    );
  }
}

/**
 * `nixctl pet tools run`: resolves the profile's session, then delegates to
 * {@link executePetToolRun} for the claim-before-write flow, printing its outcome.
 *
 * @throws When the named tool is not pending, or its claim receipt does not match.
 */
export async function petToolRun(
  profile: string | undefined,
  toolId: string,
  options: PetToolRunOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (options.approve && options.decline)
    throw new Error('Choose either --approve or --decline, not both.');
  if (!options.workspace || !options.pet) throw new Error('Provide --workspace and --pet.');
  const session = await petSessionFor(options.apiUrl, profile, deps);
  const decision: PetToolDecision = options.approve
    ? 'approve'
    : options.decline
      ? 'decline'
      : 'preview';
  printResult(
    await executePetToolRun(session, options.workspace, options.pet, toolId, decision),
    output,
  );
}

/** Matches `pet-work-tools.tsx:225-260`: the same first-person sentence the web approval card
 * shows, so a pending tool call reads identically whether approved from the browser or nixctl. */
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
    case 'read_structure':
      return "I will read the linked item's fields, views and how many children it has.";
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
    case 'list_templates':
      return action.query
        ? `I will look through your templates for “${action.query}” to see what fits.`
        : 'I will look through your templates to see what fits.';
    case 'read_template':
      return 'I will read the linked template’s outline to see if it fits.';
    case 'apply_template':
      return `I will create “${action.title}” from the linked template${action.parentId ? ' inside the linked destination' : ' at the top level of this workspace'}.`;
    case 'create_structured':
      return `I will create a structured item named “${action.title}” ${action.parentId ? 'inside the linked destination' : 'at the top level of this workspace'}.`;
    case 'add_view':
      return 'I will add the view described below to the linked item.';
    case 'create_entries':
      return 'I will add the entries described below to the linked destination.';
    case 'add_fields':
      return 'I will add the fields described below to the linked item, leaving existing fields unchanged.';
    case 'edit_form':
      return 'I will update the linked form as described below, preserving its companion view.';
    case 'set_recurrence':
      return 'I will make the linked item repeat according to the schedule described below.';
  }
}
