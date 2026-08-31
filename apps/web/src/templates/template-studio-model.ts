import { z } from 'zod';

import { EffectiveSchemaSchema, ViewSchema, type View } from '../views/core/container-model';
import { browserSessionStorage } from '../lib/browser-storage';
import { type TemplateEditDraft } from './template-api';
import { type TemplateItemEdits } from './template-draft-editor';

export type StudioMode = 'capture' | 'create' | 'apply' | 'edit';

export interface TemplateDraft {
  readonly scope: string;
  readonly title: string;
  readonly description: string;
  readonly includeBody: boolean;
  readonly includeChildren: boolean;
  readonly idempotencyKey: string;
  readonly operationId: string | null;
  readonly expiresAt: string | null;
  readonly selectedSourceId: string | null;
  readonly itemEdits: TemplateItemEdits;
}

export interface RootTemplateFacts {
  readonly fieldCount: number;
  readonly viewCount: number;
  readonly viewKinds: readonly string[];
}

export type CaptureFacts =
  { readonly status: 'loading' | 'error' } | ({ readonly status: 'ready' } & RootTemplateFacts);

export const TEMPLATE_STUDIO_STEPS = [
  { label: 'Basics', detail: 'Name and destination' },
  { label: 'Contents', detail: 'What this carries' },
  { label: 'Review', detail: 'Check and finish' },
] as const;

const TemplateDraftRecoverySchema = z.object({
  scope: z.string(),
  title: z.string(),
  description: z.string(),
  includeBody: z.boolean(),
  includeChildren: z.boolean(),
  idempotencyKey: z.string(),
  operationId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  selectedSourceId: z.string().nullable(),
  itemEdits: z.record(
    z.string(),
    z.object({
      title: z.string(),
      schema: EffectiveSchemaSchema.nullable().optional(),
      views: z
        .object({ views: z.array(ViewSchema), default: z.string() })
        .nullable()
        .optional(),
    }),
  ),
});

export function modeFromPath(pathname: string): StudioMode {
  if (pathname.endsWith('/edit')) return 'edit';
  if (pathname.includes('/templates/apply/')) return 'apply';
  if (pathname.endsWith('/create')) return 'create';
  return 'capture';
}

export function newDraft(title: string, scope: string): TemplateDraft {
  return {
    scope,
    title,
    description: '',
    includeBody: false,
    includeChildren: false,
    idempotencyKey: globalThis.crypto.randomUUID(),
    operationId: null,
    expiresAt: null,
    selectedSourceId: null,
    itemEdits: {},
  };
}

export function draftScope(
  mode: StudioMode,
  templateId: string | undefined,
  sourceItemId: string | null,
  itemId: string | undefined,
  parentItemId: string | null,
): string {
  if (mode === 'capture') return `source:${sourceItemId ?? 'missing'}`;
  if (mode === 'apply') {
    return `template:${templateId ?? 'missing'}:target:${itemId ?? 'missing'}`;
  }
  if (mode === 'create') {
    return `template:${templateId ?? 'missing'}:parent:${parentItemId ?? 'root'}`;
  }
  return `template:${templateId ?? 'missing'}`;
}

export function storageKey(workspaceId: string, mode: StudioMode, scope: string): string {
  return `nix:template-studio:${workspaceId}:${mode}:${scope}`;
}

export function distinctViewKinds(views: readonly View[]): readonly string[] {
  return [...new Set(views.map((view) => view.kind))];
}

export function editedRootFacts(
  editOperation: TemplateEditDraft | null,
  draft: TemplateDraft,
): RootTemplateFacts | null {
  if (editOperation === null) return null;
  const edit = draft.itemEdits[editOperation.root.sourceId];
  const schema = edit?.schema ?? editOperation.root.schema;
  const views = edit?.views ?? editOperation.root.views;
  return {
    fieldCount: schema?.properties.length ?? 0,
    viewCount: views?.views.length ?? 0,
    viewKinds: distinctViewKinds(views?.views ?? []),
  };
}

export function readDraft(
  key: string,
  fallback: TemplateDraft,
): { readonly draft: TemplateDraft; readonly recovered: boolean } {
  const raw = browserSessionStorage()?.getItem(key);
  if (raw === null || raw === undefined) return { draft: fallback, recovered: false };
  try {
    const parsed = TemplateDraftRecoverySchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.scope !== fallback.scope) {
      return { draft: fallback, recovered: false };
    }
    return {
      draft: { ...parsed.data, itemEdits: parsed.data.itemEdits as TemplateItemEdits },
      recovered: true,
    };
  } catch {
    return { draft: fallback, recovered: false };
  }
}
