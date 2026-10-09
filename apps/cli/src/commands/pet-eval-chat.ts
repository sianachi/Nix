import { readFile } from 'node:fs/promises';
import { items, pets, type Item, type PetConnection, type PetToolCall } from '@nix/api-client';
import {
  canApplyWithoutAsking,
  createCompanionBodies,
  defaultClock,
  defaultIds,
  executeBuild,
  hasExternalLink,
  loadPreviewContext,
  planBuild,
  readStructure,
  READ_ONLY_OPERATIONS,
  workspaceToolSchema,
  type CompanionPorts,
} from '@nix/companion';
import { blueprintSchema, chatSuiteSchema, type ChatAssertion, type ChatCase } from '@nix/structure-spec';
import { printResult, printTable, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';
import { executePetToolRun, petSessionFor } from './pets.ts';
import type { SessionDeps } from './shared.ts';
import { collabClientFor } from './templates.ts';

/** docs/plans/pet-tool-use-plan.md, lane E: the chat suite. A fixture is built from one
 * blueprint, every case is one owner message, tools run for real under the lane F policy
 * (plus "inside the fixture"), and the case is scored on which tools were attempted and on the
 * workspace state read back afterwards. Nothing here teaches the model anything: the point is
 * a number that moves when the tools or the prompt change. */

const POLL_INTERVAL_MS = 3_000;
const CASE_TIMEOUT_MS = 180_000;
const DECLINED_PREFIX = 'Evaluation run: declined';

export interface ChatEvalOptions {
  readonly suite: 'chat';
  readonly case?: string;
  readonly model?: string;
  readonly apiUrl?: string;
  readonly workspace?: string;
  readonly pet?: string;
  /** Approve writes that the lane F policy allows and that target the fixture. Off: every write
   * is declined and recorded, which still scores whether the right tool was attempted. */
  readonly allowWrites?: boolean;
  /** Leave the fixture in place after the run. */
  readonly keep?: boolean;
  readonly runs?: number;
}

export interface ChatToolRecord {
  readonly operation: string;
  readonly decision: 'ran' | 'declined';
  readonly reason?: string;
  readonly success: boolean;
  readonly ms: number;
}

export interface ChatCaseResult {
  readonly id: string;
  readonly run: number;
  readonly model: string | null;
  readonly outcome: 'done' | 'tool_limit' | 'timeout' | 'error';
  readonly pass: boolean;
  readonly failures: string[];
  readonly tools: ChatToolRecord[];
  readonly answer: string;
  readonly durationMs: number;
}

/** The built fixture: the container every write must stay inside, and each blueprint node's
 * item. Tests supply their own instead of building one. */
export interface ChatFixture {
  readonly rootId: string;
  readonly nodes: ReadonlyMap<string, string>;
}

export interface ChatEvalRuntime {
  readonly session: Session;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly today: () => string;
  readonly seed?: (
    session: Session,
    workspaceId: string,
    today: string,
  ) => Promise<ChatFixture>;
  readonly teardown?: (session: Session, workspaceId: string, fixture: ChatFixture) => Promise<void>;
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Replaces `{today}`, `{today+N}` and `{today-N}` with ISO dates relative to `today`. */
export function substituteDates(text: string, today: string): string {
  return text.replaceAll(/\{today([+-]\d+)?\}/g, (_match, offset: string | undefined) => {
    const base = new Date(`${today}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + (offset ? Number(offset) : 0));
    return base.toISOString().slice(0, 10);
  });
}

function portsFor(session: Session): CompanionPorts {
  const collab = collabClientFor(session);
  return {
    core: session.client,
    collab,
    bodies: createCompanionBodies(collab),
    clock: defaultClock(),
    ids: defaultIds(),
  };
}

async function readJson(relative: string): Promise<unknown> {
  const file = new URL(`../../../../packages/structure-spec/evals/chat/${relative}`, import.meta.url);
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Builds the fixture under a fresh container at the workspace root, so teardown is one trash
 * and "inside the fixture" is one ancestry walk. */
async function buildFixture(session: Session, workspaceId: string, today: string): Promise<ChatFixture> {
  const raw = substituteDates(JSON.stringify(await readJson('fixture.json')), today);
  const blueprint = blueprintSchema.parse(JSON.parse(raw));
  const container = await session.client.execute(
    items.createItem(workspaceId, {
      type: 'note',
      title: `Eval chat ${new Date().toISOString().replace(/[:.]/g, '-')}`,
      parentId: null,
    }),
  );
  const ports = portsFor(session);
  const plan = planBuild(blueprint, {
    parentId: container.id,
    sandboxExists: true,
    clock: ports.clock,
    inheritedFields: [],
  });
  const built = await executeBuild(ports, workspaceId, plan, AbortSignal.timeout(180_000));
  if (!built.complete) {
    await session.client.execute(items.deleteItem(workspaceId, container.id));
    throw new Error(`The fixture did not build completely (${built.instruction}).`);
  }
  const nodes = new Map<string, string>();
  for (const entry of built.ledger) if (entry.itemId && !nodes.has(entry.nodeId)) nodes.set(entry.nodeId, entry.itemId);
  return { rootId: container.id, nodes };
}

async function trashFixture(session: Session, workspaceId: string, fixture: ChatFixture): Promise<void> {
  await session.client.execute(items.deleteItem(workspaceId, fixture.rootId));
}

function resolveNode(fixture: ChatFixture, node: string): string {
  const id = fixture.nodes.get(node);
  if (!id) throw new Error(`The fixture has no node '${node}'.`);
  return id;
}

async function titleOf(session: Session, id: string): Promise<string> {
  return (await session.client.query(items.itemById(id), { forceRefresh: true })).title;
}

/** Whether `itemId` is the fixture container or sits anywhere below it. */
async function insideFixture(
  session: Session,
  fixture: ChatFixture,
  itemId: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const seen: string[] = [];
  let current: string | null = itemId;
  let inside = false;
  for (let depth = 0; current && depth < 16; depth += 1) {
    const known = cache.get(current);
    if (known !== undefined) {
      inside = known;
      break;
    }
    if (current === fixture.rootId) {
      inside = true;
      break;
    }
    seen.push(current);
    try {
      const item: Item = await session.client.query(items.itemById(current), { forceRefresh: true });
      current = item.parentId;
    } catch {
      break;
    }
  }
  for (const id of seen) cache.set(id, inside);
  return inside;
}

function operationOf(tool: PetToolCall): string {
  try {
    const args: unknown = JSON.parse(tool.arguments);
    return typeof args === 'object' && args !== null && 'operation' in args && typeof args.operation === 'string'
      ? args.operation
      : 'unparseable';
  } catch {
    return 'unparseable';
  }
}

/** Why a write may not run on its own, or undefined when it may. Mirrors the web card: the
 * lane F policy, the external-link rule, the hold after a read of locked content (the worker's
 * conversation-level `lockedRead`), the hold on completing an occurrence of a repeating task, and
 * the harness's own fixture boundary. */
export async function declineReason(
  session: Session,
  fixture: ChatFixture,
  tool: PetToolCall,
  allowWrites: boolean,
  cache: Map<string, boolean>,
  lockedRead = false,
  ports?: CompanionPorts,
  workspaceId?: string,
): Promise<string | undefined> {
  let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
  try {
    parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
  } catch {
    parsed = workspaceToolSchema.safeParse(null);
  }
  if (!parsed.success) return 'unsupported request';
  const args = parsed.data;
  if (READ_ONLY_OPERATIONS.has(args.operation) || args.operation === 'validate_blueprint') return undefined;
  if (!allowWrites) return 'writes are not allowed in this run';
  if (!canApplyWithoutAsking(args.operation)) return `${args.operation} always asks`;
  if (lockedRead) return 'earlier in this conversation it read locked content';
  if (args.operation === 'complete_task') {
    // The same preview the card reads: an occurrence of a repeating task cannot be reopened, so it
    // never runs unattended. Without a preview there is no way to tell, so it does not run either.
    if (ports === undefined || workspaceId === undefined) return 'the task may repeat and there is no preview';
    try {
      const context = await loadPreviewContext(ports, workspaceId, args, AbortSignal.timeout(30_000));
      if (context.taskCompletion?.kind === 'occurrence')
        return "completing a repeating task's occurrence cannot be undone";
    } catch {
      return 'the task preview could not be loaded';
    }
  }
  if (hasExternalLink([args.title, args.markdown, args.specJson, args.propertiesJson]))
    return 'the text links to another host';
  const targets = [args.itemId, args.parentId].filter((id) => id.trim());
  if (targets.length === 0) return 'the target is the workspace root, outside the fixture';
  for (const id of targets)
    if (!(await insideFixture(session, fixture, id, cache))) return 'the target is outside the fixture';
  return undefined;
}

async function runtime(
  session: Session,
  workspaceId: string,
  petId: string,
  operation: 'reset' | 'send' | 'read' | 'tool_claim' | 'tool_result',
  extra: Partial<Parameters<typeof pets.runtime>[0]> = {},
): Promise<PetConnection> {
  return session.client.execute(pets.runtime({ operation, workspaceId, petId, mode: 'chat', ...extra }));
}

async function declineTool(
  session: Session,
  workspaceId: string,
  petId: string,
  tool: PetToolCall,
  reason: string,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const claimed = await runtime(session, workspaceId, petId, 'tool_claim', { toolId: tool.id, requestId });
  const receipt = claimed.tools?.find((entry) => entry.id === tool.id);
  if (receipt?.status !== 'claimed' || receipt.claimId !== requestId)
    throw new Error(`Tool ${tool.id} was claimed elsewhere.`);
  await runtime(session, workspaceId, petId, 'tool_result', {
    toolId: tool.id,
    requestId,
    toolResult: `${DECLINED_PREFIX}: ${reason}. Do not retry it.`,
    toolSuccess: false,
  });
}

function matches(list: readonly string[], attempted: readonly string[]): string[] {
  return list.filter((entry) => !entry.split('|').some((alternative) => attempted.includes(alternative)));
}

function inOrder(expected: readonly string[], attempted: readonly string[]): boolean {
  let index = 0;
  for (const operation of attempted) {
    const entry = expected[index];
    if (entry?.split('|').includes(operation)) index += 1;
  }
  return index === expected.length;
}

async function checkAssertion(
  session: Session,
  ports: CompanionPorts,
  workspaceId: string,
  fixture: ChatFixture,
  assertion: ChatAssertion,
): Promise<string | undefined> {
  switch (assertion.kind) {
    case 'child': {
      const parentId = resolveNode(fixture, assertion.parent);
      const title = new RegExp(assertion.title, 'i');
      const found: { title: string; properties: Record<string, unknown> }[] = [];
      for await (const item of session.client.paginate(items.listItems(workspaceId, { parentId, pageSize: 50 }), {
        forceRefresh: true,
      })) {
        if (title.test(item.title)) found.push({ title: item.title, properties: item.properties });
      }
      if (!assertion.exists) return found.length === 0 ? undefined : `a child matching /${assertion.title}/ exists under ${assertion.parent}`;
      if (found.length === 0) return `no child matching /${assertion.title}/ under ${assertion.parent}`;
      if (assertion.values) {
        const ok = found.some((item) =>
          Object.entries(assertion.values ?? {}).every(
            ([key, value]) => JSON.stringify(item.properties[key]) === JSON.stringify(value),
          ),
        );
        if (!ok) return `no child matching /${assertion.title}/ carries ${JSON.stringify(assertion.values)}`;
      }
      return undefined;
    }
    case 'value': {
      const item = await session.client.query(items.itemById(resolveNode(fixture, assertion.item)), {
        forceRefresh: true,
      });
      const value: unknown = item.properties[assertion.key];
      if (assertion.truthy) return value ? undefined : `${assertion.item}.${assertion.key} is ${JSON.stringify(value)}, expected truthy`;
      if (JSON.stringify(value) !== JSON.stringify(assertion.equals))
        return `${assertion.item}.${assertion.key} is ${JSON.stringify(value)}, expected ${JSON.stringify(assertion.equals)}`;
      return undefined;
    }
    case 'note': {
      const body = (await ports.bodies.read(resolveNode(fixture, assertion.item), AbortSignal.timeout(30_000))) as {
        markdown?: string;
      };
      const hit = new RegExp(assertion.contains, 'i').test(body.markdown ?? '');
      if (assertion.absent) return hit ? `${assertion.item} still contains /${assertion.contains}/` : undefined;
      return hit ? undefined : `${assertion.item} does not contain /${assertion.contains}/`;
    }
    case 'field': {
      const structure = await readStructure(ports, workspaceId, resolveNode(fixture, assertion.item), AbortSignal.timeout(30_000));
      const keys = structure.fields.map((field) => field.key);
      return keys.includes(assertion.key) ? undefined : `${assertion.item} declares no field '${assertion.key}' (has ${keys.join(', ') || 'none'})`;
    }
    case 'parent': {
      const item = await session.client.query(items.itemById(resolveNode(fixture, assertion.item)), {
        forceRefresh: true,
      });
      const expected = resolveNode(fixture, assertion.parent);
      return item.parentId === expected ? undefined : `${assertion.item} is no longer under ${assertion.parent}`;
    }
  }
}

/** Runs one case: one message, tools handled as they arrive, then the assertions. */
export async function runChatCase(
  chatCase: ChatCase,
  run: number,
  options: ChatEvalOptions & { workspace: string; pet: string },
  fixture: ChatFixture,
  runner: ChatEvalRuntime,
): Promise<ChatCaseResult> {
  const { session, sleep } = runner;
  const ports = portsFor(session);
  const model = options.model ?? null;
  const tools: ChatToolRecord[] = [];
  const handled = new Set<string>();
  const ancestry = new Map<string, boolean>();
  const started = Date.now();
  let outcome: ChatCaseResult['outcome'] = 'timeout';
  let answer = '';
  const prompt = await replaceNodeTitles(chatCase.prompt, fixture, session);
  await runtime(session, options.workspace, options.pet, 'reset');
  try {
    await runtime(session, options.workspace, options.pet, 'send', {
      text: prompt,
      workspaceAccess: true,
      requestId: crypto.randomUUID(),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    while (Date.now() - started < CASE_TIMEOUT_MS) {
      const connection = await runtime(session, options.workspace, options.pet, 'read');
      const tool = connection.tools?.find((entry) => entry.status === 'pending' && !handled.has(entry.id));
      if (tool) {
        handled.add(tool.id);
        const operation = operationOf(tool);
        if (tools.length >= chatCase.tools.max) {
          await declineTool(session, options.workspace, options.pet, tool, 'the tool budget is spent');
          tools.push({ operation, decision: 'declined', reason: 'tool budget', success: false, ms: 0 });
          outcome = 'tool_limit';
          break;
        }
        const at = Date.now();
        const reason = await declineReason(
          session,
          fixture,
          tool,
          options.allowWrites ?? false,
          ancestry,
          connection.lockedRead,
          ports,
          options.workspace,
        );
        if (reason !== undefined) {
          await declineTool(session, options.workspace, options.pet, tool, reason);
          tools.push({ operation, decision: 'declined', reason, success: false, ms: Date.now() - at });
          continue;
        }
        const after = (await executePetToolRun(
          session,
          options.workspace,
          options.pet,
          tool.id,
          'approve',
          'chat',
        )) as PetConnection;
        const status = after.tools?.find((entry) => entry.id === tool.id)?.status;
        tools.push({ operation, decision: 'ran', success: status === 'completed', ms: Date.now() - at });
        continue;
      }
      if (connection.state === 'success' || connection.state === 'error') {
        outcome = connection.state === 'error' ? 'error' : 'done';
        answer =
          connection.messages?.findLast((message) => message.role === 'assistant' && !message.id.includes(':draft:'))
            ?.text ?? '';
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await runtime(session, options.workspace, options.pet, 'reset');
  }

  const attempted = tools.map((tool) => tool.operation);
  const failures: string[] = [];
  if (outcome !== 'done') failures.push(`outcome ${outcome}`);
  for (const missing of matches(chatCase.tools.require, attempted)) failures.push(`never attempted ${missing}`);
  for (const hit of chatCase.tools.forbid.filter((entry) => entry.split('|').some((alt) => attempted.includes(alt))))
    failures.push(`attempted forbidden ${hit}`);
  if (chatCase.tools.inOrder && !inOrder(chatCase.tools.inOrder, attempted))
    failures.push(`tools not in order ${chatCase.tools.inOrder.join(' > ')}`);
  if (chatCase.answer && !new RegExp(chatCase.answer, 'i').test(answer)) failures.push(`answer does not match /${chatCase.answer}/`);
  if (chatCase.answerNot && new RegExp(chatCase.answerNot, 'i').test(answer)) failures.push(`answer matches /${chatCase.answerNot}/`);
  for (const assertion of chatCase.asserts) {
    try {
      const failure = await checkAssertion(session, ports, options.workspace, fixture, assertion);
      if (failure) failures.push(failure);
    } catch (reason) {
      failures.push(`assertion ${assertion.kind} could not be checked: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  return {
    id: chatCase.id,
    run,
    model,
    outcome,
    pass: failures.length === 0,
    failures,
    tools,
    answer: answer.slice(0, 2000),
    durationMs: Date.now() - started,
  };
}

async function replaceNodeTitles(prompt: string, fixture: ChatFixture, session: Session): Promise<string> {
  const refs = [...prompt.matchAll(/\{node:([a-z][a-z0-9-]*)\}/g)].map((match) => match[1] ?? '');
  const titles = new Map<string, string>();
  for (const ref of new Set(refs)) titles.set(ref, await titleOf(session, resolveNode(fixture, ref)));
  return prompt.replaceAll(/\{node:([a-z][a-z0-9-]*)\}/g, (_match, ref: string) => titles.get(ref) ?? ref);
}

export async function readChatCases(id: string | undefined): Promise<ChatCase[]> {
  const all = chatSuiteSchema.parse(await readJson('cases.json'));
  if (!id) return all;
  const selected = all.filter((entry) => entry.id === id);
  if (selected.length === 0) throw new Error(`Unknown chat case '${id}'. Choose: ${all.map((entry) => entry.id).join(', ')}.`);
  return selected;
}

export async function runChatSuite(
  cases: readonly ChatCase[],
  options: ChatEvalOptions & { workspace: string; pet: string },
  runner: ChatEvalRuntime,
): Promise<ChatCaseResult[]> {
  const results: ChatCaseResult[] = [];
  const runs = options.runs ?? 1;
  const seed = runner.seed ?? buildFixture;
  const teardown = runner.teardown ?? trashFixture;
  for (let run = 1; run <= runs; run += 1) {
    for (const chatCase of cases) {
      // One fresh fixture per case: a case must never see another case's writes.
      const fixture = await seed(runner.session, options.workspace, runner.today());
      try {
        results.push(await runChatCase(chatCase, run, options, fixture, runner));
      } finally {
        if (!options.keep) await teardown(runner.session, options.workspace, fixture);
      }
    }
  }
  return results;
}

export async function petEvalChat(
  profile: string | undefined,
  options: ChatEvalOptions,
  output: OutputOptions,
  deps: SessionDeps & { sleep?: (milliseconds: number) => Promise<void>; today?: () => string } = {},
): Promise<void> {
  if (!options.workspace || !options.pet) throw new Error('Provide --workspace and --pet.');
  const cases = await readChatCases(options.case);
  const session = await petSessionFor(options.apiUrl, profile, deps);
  const runner: ChatEvalRuntime = {
    session,
    sleep: deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    today: deps.today ?? localToday,
  };
  const results = await runChatSuite(cases, { ...options, workspace: options.workspace, pet: options.pet }, runner);
  if (output.json || !output.isTty) printResult(results, output);
  else {
    printTable(
      ['Case', 'Run', 'Outcome', 'Pass', 'Tools', 'Declined', 'Seconds'],
      results.map((result) => [
        result.id,
        String(result.run),
        result.outcome,
        result.pass ? 'pass' : 'fail',
        String(result.tools.length),
        String(result.tools.filter((tool) => tool.decision === 'declined').length),
        (result.durationMs / 1000).toFixed(1),
      ]),
    );
    const passed = results.filter((result) => result.pass).length;
    process.stdout.write(`\n${String(passed)} of ${String(results.length)} passed.\n`);
    for (const result of results.filter((entry) => !entry.pass)) {
      process.stdout.write(`\n${result.id} (run ${String(result.run)})\n`);
      for (const failure of result.failures) process.stdout.write(`  - ${failure}\n`);
      process.stdout.write(
        `  tools: ${result.tools.map((tool) => `${tool.operation}${tool.decision === 'declined' ? ` (declined: ${tool.reason ?? ''})` : tool.success ? '' : ' (failed)'}`).join(', ') || 'none'}\n`,
      );
    }
  }
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}
