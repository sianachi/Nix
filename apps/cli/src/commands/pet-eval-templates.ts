import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  items,
  templates,
  templateSummarySchema,
  type TemplateDetail,
  type TemplateSummary,
} from '@nix/api-client';
import type { Session } from '../session.ts';
import { collabClientFor } from './templates.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const TEMPLATE_TITLE = 'Nix eval meeting template';

/** Only successful capture receipts establish cleanup ownership; catalog discovery never does. */
function recordCapture(
  workspaceId: string,
  templateId: string,
  owned: Map<string, TemplateSummary>,
): void {
  z.uuid().parse(workspaceId);
  z.uuid().parse(templateId);
  if (owned.has(templateId)) return;
  // This placeholder is for cleanup only. Callers must await validation before read/apply.
  owned.set(templateId, {
    id: templateId,
    workspaceId,
    title: TEMPLATE_TITLE,
    description: null,
    origin: 'user',
    revision: 0,
    includeBody: true,
    includeChildren: false,
    fieldCount: 0,
    viewCount: 0,
    childCount: 0,
    viewKinds: [],
    capabilities: { canEdit: false, canDelete: false, canExport: false, canApply: false },
    updatedAt: new Date().toISOString(),
  });
}

function verifyTemplate(detail: TemplateDetail, workspaceId: string, templateId: string): void {
  const root = detail.root;
  if (
    detail.id !== templateId ||
    detail.workspaceId !== workspaceId ||
    detail.origin !== 'user' ||
    !detail.includeBody ||
    !root.hasBody ||
    root.itemType !== 'note' ||
    detail.childCount !== 0 ||
    root.children.length !== 0 ||
    detail.initialization.inputs.length !== 0 ||
    detail.initialization.rules.length !== 0 ||
    detail.initialization.references.length !== 0 ||
    Object.keys(root.properties ?? {}).some((key) => key !== 'title') ||
    (root.schema?.properties.length ?? 0) !== 0 ||
    (root.schema?.declared.length ?? 0) !== 0 ||
    (root.views?.views.length ?? 0) !== 0 ||
    root.recurrence !== null ||
    detail.fieldCount !== 0 ||
    detail.viewCount !== 0
  ) {
    throw new Error('The captured eval template must be one plain note in the fixture workspace.');
  }
}

async function readCapturedTemplate(
  session: Session,
  workspaceId: string,
  templateId: string,
  owned: Map<string, TemplateSummary>,
): Promise<TemplateDetail> {
  recordCapture(workspaceId, templateId, owned);
  const detail = await session.client.query(templates.templateById(templateId), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    forceRefresh: true,
  });
  verifyTemplate(detail, workspaceId, templateId);
  return detail;
}

/** Registers an ID returned by a trusted fixture capture, then verifies it before read/apply. */
export async function registerEvalTemplate(
  session: Session,
  workspaceId: string,
  templateId: string,
  owned: Map<string, TemplateSummary>,
): Promise<void> {
  const detail = await readCapturedTemplate(session, workspaceId, templateId, owned);
  owned.set(templateId, templateSummarySchema.parse(detail));
}

/** Captures the caller's freshly built synthetic note leaf, without file transfer or children. */
export async function seedEvalTemplate(
  session: Session,
  workspaceId: string,
  sourceItemId: string,
  owned: Map<string, TemplateSummary>,
): Promise<void> {
  z.uuid().parse(workspaceId);
  z.uuid().parse(sourceItemId);
  const options = { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), forceRefresh: true };
  const source = await session.client.query(items.itemById(sourceItemId), options);
  if (
    source.id !== sourceItemId ||
    source.workspaceId !== workspaceId ||
    source.lifecycleState !== 'active' ||
    source.type !== 'note' ||
    source.hasChildren ||
    Object.keys(source.properties).some((key) => key !== 'title')
  ) {
    throw new Error('The eval template source must be the synthetic note leaf in its workspace.');
  }
  const children = session.client.paginate(
    items.listItems(workspaceId, { parentId: sourceItemId, pageSize: 1 }),
    { signal: options.signal, maxPages: 1 },
  );
  if (!(await children.next()).done) {
    await children.return();
    throw new Error('The eval template source must have no children.');
  }
  const preview = await session.client.query(
    templates.previewTemplateCapture(workspaceId, sourceItemId, false),
    options,
  );
  if (preview.itemCount !== 1 || preview.sourceTitle !== source.title) {
    throw new Error('The eval template capture preview must contain exactly the source note.');
  }
  const capture = await collabClientFor(session).execute(
    templates.captureTemplate({
      workspaceId,
      sourceItemId,
      title: TEMPLATE_TITLE,
      includeBody: true,
      includeChildren: false,
      idempotencyKey: `eval-template-${randomUUID()}`,
      expectedFingerprint: preview.captureFingerprint,
    }),
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  recordCapture(workspaceId, capture.templateId, owned);
  if (capture.fileTransferPending || capture.fileTransferJobId != null) {
    throw new Error('Eval template capture must not create a file transfer.');
  }
  const detail = await readCapturedTemplate(session, workspaceId, capture.templateId, owned);
  if (detail.root.title !== source.title) {
    throw new Error('The eval template must preserve the source note title.');
  }
  owned.set(capture.templateId, templateSummarySchema.parse(detail));
}

/** Removes only capture IDs recorded by this run; failed deletions remain available for recovery. */
export async function removeEvalTemplates(
  session: Session,
  owned: Map<string, TemplateSummary>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const [id, summary] of owned) {
    try {
      if (id !== summary.id) throw new Error('Eval template registry identity mismatch.');
      await session.client.execute(templates.deleteTemplate(templateSummarySchema.parse(summary)), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      owned.delete(id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not remove every capture owned by this eval run.');
  }
}
