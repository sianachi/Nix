import { Blueprint, Button, Dialog, Field, Icon, Input, Tag, Text, cn, focusRing } from '@nix/ui';
import { ArrowLeft, ArrowRight, Check, Eye, LayoutTemplate } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from 'react-router';
import { z } from 'zod';

import { isCanceledError, isNixApiError } from '@nix/api-client';

import { useApiClient } from '../api/api-client-provider';
import type { CollabSync } from '../editor/collab-sync';
import { browserSessionStorage } from '../lib/browser-storage';
import type { ShellContext } from '../shell/shell-context';
import { useTemplateLibrary } from './template-library-context';
import { EffectiveSchemaSchema, ViewSchema, type View } from '../views/core/container-model';
import {
  applyStoredTemplate,
  beginTemplateEditDraft,
  captureTemplate,
  discardTemplateEditDraft,
  preflightTemplate,
  saveTemplateEditDraft,
  templateById,
  templateCaptureSourceSchema,
  templateCaptureSourceViews,
  templateEditDraftById,
  updateTemplateEditDraft,
  updateTemplateEditDraftItem,
  type TemplateDetail,
  type TemplateEditDraft,
  type TemplatePreflight,
} from './template-api';
import {
  TemplateDraftEditor,
  type TemplateItemEdit,
  type TemplateItemEdits,
} from './template-draft-editor';
import { templateFailure } from './use-templates';
import { useWorkspace } from '../workspaces/workspace-context';

type StudioMode = 'capture' | 'create' | 'apply' | 'edit';

interface TemplateDraft {
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

interface RootTemplateFacts {
  readonly fieldCount: number;
  readonly viewCount: number;
  readonly viewKinds: readonly string[];
}

type CaptureFacts =
  { readonly status: 'loading' | 'error' } | ({ readonly status: 'ready' } & RootTemplateFacts);

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

const STEPS = [
  { label: 'Basics', detail: 'Name and destination' },
  { label: 'Contents', detail: 'What this carries' },
  { label: 'Review', detail: 'Check and finish' },
] as const;

function modeFromPath(pathname: string): StudioMode {
  if (pathname.endsWith('/edit')) return 'edit';
  if (pathname.includes('/templates/apply/')) return 'apply';
  if (pathname.endsWith('/create')) return 'create';
  return 'capture';
}

function newDraft(title: string, scope: string): TemplateDraft {
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

function draftScope(
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

function storageKey(workspaceId: string, mode: StudioMode, scope: string): string {
  return `nix:template-studio:${workspaceId}:${mode}:${scope}`;
}

function distinctViewKinds(views: readonly View[]): readonly string[] {
  return [...new Set(views.map((view) => view.kind))];
}

function editedRootFacts(
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

function readDraft(
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

export function TemplateStudioPage(): ReactNode {
  const { templateId, itemId } = useParams();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const sourceItemId = searchParams.get('sourceItem');
  const { tree } = useOutletContext<ShellContext>();
  if (sourceItemId !== null && tree.status === 'loading') {
    return <StudioNotice title="Loading source item" detail="Reading the item to capture." />;
  }
  const scope = `${modeFromPath(pathname)}:${templateId ?? 'new'}:${itemId ?? sourceItemId ?? 'unknown'}:${searchParams.get('parent') ?? 'root'}`;
  return <TemplateStudio key={scope} />;
}

function TemplateStudio(): ReactNode {
  const { workspaceId } = useWorkspace();
  const { templateId, itemId } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const sourceItemId = searchParams.get('sourceItem');
  const parentItemId = searchParams.get('parent');
  const mode = modeFromPath(location.pathname);
  const scope = draftScope(mode, templateId, sourceItemId, itemId, parentItemId);
  const key = storageKey(workspaceId, mode, scope);
  const { tree } = useOutletContext<ShellContext>();
  const templateLibrary = useTemplateLibrary();
  const templateCapabilities = templateLibrary.capabilities;
  const templateStatus = templateLibrary.status;
  const sourceTitle =
    sourceItemId === null
      ? 'Untitled template'
      : (tree.find(sourceItemId)?.title ?? 'Untitled template');
  const targetTitle = itemId === undefined ? null : (tree.find(itemId)?.title ?? 'Current item');
  const client = useApiClient();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [editOperation, setEditOperation] = useState<TemplateEditDraft | null>(null);
  const [captureFacts, setCaptureFacts] = useState<CaptureFacts>({ status: 'loading' });
  const [loading, setLoading] = useState(mode !== 'capture');
  const [step, setStep] = useState(0);
  const [recovery] = useState(() => readDraft(key, newDraft(sourceTitle, scope)));
  const recoveredDraft = recovery.recovered;
  const initialDraft = recovery.draft;
  const [draft, setDraft] = useState(initialDraft);
  const [resumeOperationId, setResumeOperationId] = useState(initialDraft.operationId);
  const [editAttemptKey, setEditAttemptKey] = useState(initialDraft.idempotencyKey);
  const [staleEditDraft, setStaleEditDraft] = useState(false);
  const [editConflict, setEditConflict] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [preflight, setPreflight] = useState<TemplatePreflight | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [bodySync, setBodySync] = useState<CollabSync | null>(null);
  const stepMainRef = useRef<HTMLElement>(null);
  const previousStep = useRef(step);
  const activeOperation = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeOperation.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (mode === 'capture' || templateId === undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const loaded = await client.query(templateById(templateId), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setTemplate(loaded);
        let loadedEditDraft: TemplateEditDraft | null = null;
        if (mode === 'edit') {
          if (resumeOperationId !== null) {
            try {
              loadedEditDraft = await client.query(
                templateEditDraftById(templateId, resumeOperationId),
                { signal: controller.signal, forceRefresh: true },
              );
            } catch (reason) {
              if (isCanceledError(reason)) return;
              if (!isNixApiError(reason) || reason.status !== 409) throw reason;
              setStaleEditDraft(true);
              setLoading(false);
              return;
            }
          }
          loadedEditDraft ??= await client.execute(
            beginTemplateEditDraft(templateId, editAttemptKey),
            { signal: controller.signal },
          );
          setEditOperation(loadedEditDraft);
          setStaleEditDraft(false);
        }
        if (!recoveredDraft) {
          const seeded = newDraft(loaded.title, scope);
          setDraft({
            ...seeded,
            description: loadedEditDraft?.description ?? loaded.description ?? '',
            idempotencyKey: loadedEditDraft === null ? seeded.idempotencyKey : editAttemptKey,
            includeBody: loaded.includeBody,
            includeChildren: loaded.includeChildren,
            operationId: loadedEditDraft?.operationId ?? null,
            expiresAt: loadedEditDraft?.expiresAt ?? null,
            selectedSourceId: loadedEditDraft?.root.sourceId ?? null,
            title: loadedEditDraft?.title ?? seeded.title,
          });
        } else if (loadedEditDraft !== null) {
          setDraft((current) => ({
            ...current,
            operationId: loadedEditDraft.operationId,
            expiresAt: loadedEditDraft.expiresAt,
            selectedSourceId: current.selectedSourceId ?? loadedEditDraft.root.sourceId,
          }));
        }
        setLoading(false);
      } catch (reason) {
        if (isCanceledError(reason)) return;
        if (mode === 'edit' && isNixApiError(reason) && reason.status === 409) {
          setEditConflict(
            templateFailure(
              reason,
              'Another template draft is still active. Finish or discard it before trying again.',
            ),
          );
          setLoading(false);
          return;
        }
        setError(templateFailure(reason, 'This template could not be loaded.'));
        setLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [
    client,
    editAttemptKey,
    initialDraft,
    loadVersion,
    mode,
    recoveredDraft,
    resumeOperationId,
    scope,
    templateId,
  ]);

  useEffect(() => {
    if (mode !== 'capture' || sourceItemId === null) return;
    const controller = new AbortController();
    void Promise.all([
      client.query(templateCaptureSourceSchema(sourceItemId), { signal: controller.signal }),
      client.query(templateCaptureSourceViews(sourceItemId), { signal: controller.signal }),
    ])
      .then(([schema, views]) => {
        setCaptureFacts({
          status: 'ready',
          fieldCount: schema.properties.length,
          viewCount: views.views.length,
          viewKinds: distinctViewKinds(views.views),
        });
      })
      .catch((reason: unknown) => {
        if (!isCanceledError(reason)) setCaptureFacts({ status: 'error' });
      });
    return () => {
      controller.abort();
    };
  }, [client, mode, sourceItemId]);

  useEffect(() => {
    browserSessionStorage()?.setItem(key, JSON.stringify(draft));
  }, [draft, key]);

  useEffect(() => {
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
  }, []);

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const heading = stepMainRef.current?.querySelector<HTMLElement>('h2');
    if (heading === null || heading === undefined) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [step]);

  if (loading) {
    return (
      <StudioNotice title="Loading template" detail="Reading its fields, views, and contents." />
    );
  }

  if (mode !== 'capture' && template === null) {
    return (
      <StudioNotice
        title="Template unavailable"
        detail={error ?? 'This template no longer exists.'}
      >
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'capture' && sourceItemId === null) {
    return (
      <StudioNotice title="Choose an item first" detail="A template needs an item to capture." />
    );
  }

  if (mode === 'capture' && templateStatus === 'loading') {
    return <StudioNotice title="Checking template access" detail="Reading workspace access." />;
  }

  if (mode === 'capture' && templateStatus === 'error') {
    return (
      <StudioNotice
        title="Template access could not be checked"
        detail={templateLibrary.error ?? 'Check the connection and try again.'}
      >
        <Button variant="secondary" onClick={templateLibrary.reload}>
          Try again
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'capture' && !templateCapabilities.canManage) {
    return (
      <StudioNotice
        title="Template creation unavailable"
        detail="You can browse workspace templates, but you cannot add or change them."
      />
    );
  }

  if (
    (mode === 'create' || mode === 'apply') &&
    template !== null &&
    !template.capabilities.canApply
  ) {
    return (
      <StudioNotice
        title="Template use unavailable"
        detail="You can preview and download this template, but you cannot apply it in this workspace."
      >
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'edit' && template?.capabilities.canEdit !== true) {
    return (
      <StudioNotice
        title="Managed template"
        detail="Built-in and file-managed templates are read-only. Use one to create an editable workspace item; the library template stays unchanged."
      >
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'edit' && editConflict !== null) {
    return (
      <StudioNotice title="Another template draft is active" detail={editConflict} attention>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setEditConflict(null);
              setLoading(true);
              setLoadVersion((current) => current + 1);
            }}
          >
            Try again
          </Button>
          <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
            Back to templates
          </Button>
        </div>
      </StudioNotice>
    );
  }

  if (mode === 'edit' && staleEditDraft) {
    return (
      <StudioNotice
        title="This saved draft is no longer available"
        detail="Its document, canvas, or sheet edits cannot be recovered. Names, fields, and view changes saved in this tab are still here and can be reapplied to a fresh draft."
        attention
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setLoading(true);
              setLoadVersion((current) => current + 1);
            }}
          >
            Try to resume again
          </Button>
          <Button
            onClick={() => {
              const nextAttemptKey = globalThis.crypto.randomUUID();
              setEditOperation(null);
              setBodySync(null);
              setDraft((current) => ({
                ...current,
                idempotencyKey: nextAttemptKey,
                operationId: null,
                expiresAt: null,
              }));
              setResumeOperationId(null);
              setEditAttemptKey(nextAttemptKey);
              setStaleEditDraft(false);
              setLoading(true);
            }}
          >
            Start a fresh draft
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              browserSessionStorage()?.removeItem(key);
              void navigate(`/w/${workspaceId}/templates`);
            }}
          >
            Discard local recovery
          </Button>
        </div>
      </StudioNotice>
    );
  }

  const destination =
    mode === 'apply'
      ? (targetTitle ?? 'Current item')
      : parentItemId === null
        ? 'Workspace root'
        : (tree.find(parentItemId)?.title ?? 'Current item');
  const title =
    mode === 'capture'
      ? 'Save as template'
      : mode === 'create'
        ? `Create from ${template?.title ?? 'template'}`
        : mode === 'apply'
          ? `Apply ${template?.title ?? 'template'}`
          : `Edit ${template?.title ?? 'template'}`;
  const rootFacts =
    mode === 'edit'
      ? editedRootFacts(editOperation, draft)
      : mode === 'capture' && captureFacts.status === 'ready'
        ? captureFacts
        : null;
  const missingFactsLabel =
    mode === 'capture' && captureFacts.status !== 'ready'
      ? captureFacts.status === 'loading'
        ? 'Loading…'
        : 'Unavailable'
      : null;

  async function prepareReview(): Promise<boolean> {
    if ((mode !== 'create' && mode !== 'apply') || templateId === undefined) return true;
    setWorking(true);
    setError(null);
    activeOperation.current?.abort();
    const controller = new AbortController();
    activeOperation.current = controller;
    try {
      const result = await client.execute(
        preflightTemplate(templateId, {
          mode: mode === 'create' ? 'create' : 'merge',
          ...(mode === 'apply' && itemId !== undefined ? { targetItemId: itemId } : {}),
          ...(mode === 'create' ? { parentItemId, title: draft.title.trim() } : {}),
        }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || activeOperation.current !== controller) return false;
      setPreflight(result);
      if (!result.canApply) {
        setError(
          result.conflicts[0] ??
            'This template cannot be used here until its conflicts are resolved.',
        );
      }
      return result.canApply;
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return false;
      setError(templateFailure(reason, 'This template could not be checked.'));
      return false;
    } finally {
      if (activeOperation.current === controller) {
        activeOperation.current = null;
        setWorking(false);
      }
    }
  }

  async function finish(): Promise<void> {
    if (draft.title.trim().length === 0) {
      setError('Give this template a name.');
      return;
    }
    setWorking(true);
    setError(null);
    activeOperation.current?.abort();
    const controller = new AbortController();
    activeOperation.current = controller;
    try {
      if (mode === 'capture' && sourceItemId !== null) {
        await client.execute(
          captureTemplate({
            workspaceId,
            sourceItemId,
            title: draft.title.trim(),
            description: draft.description.trim() || null,
            includeBody: draft.includeBody,
            includeChildren: draft.includeChildren,
            idempotencyKey: draft.idempotencyKey,
          }),
          { signal: controller.signal },
        );
        if (controller.signal.aborted || activeOperation.current !== controller) return;
        complete(`/w/${workspaceId}/templates`);
        return;
      }

      if (mode === 'edit' && template !== null && editOperation !== null) {
        const invalidEdit = Object.values(draft.itemEdits).find(
          (itemEdit) => itemEdit.title.trim().length === 0,
        );
        if (invalidEdit !== undefined) {
          setError('Every included item needs a name.');
          return;
        }
        await client.execute(
          updateTemplateEditDraft(template.id, editOperation.operationId, {
            title: draft.title.trim(),
            description: draft.description.trim() || null,
          }),
          { signal: controller.signal },
        );
        for (const [sourceId, itemEdit] of Object.entries(draft.itemEdits)) {
          await client.execute(
            updateTemplateEditDraftItem(template.id, editOperation.operationId, sourceId, {
              title: itemEdit.title.trim(),
              schema: itemEdit.schema ?? null,
              views: itemEdit.views ?? null,
            }),
            { signal: controller.signal },
          );
          if (controller.signal.aborted || activeOperation.current !== controller) return;
        }
        await client.execute(saveTemplateEditDraft(template, editOperation.operationId), {
          signal: controller.signal,
        });
        if (controller.signal.aborted || activeOperation.current !== controller) return;
        complete(`/w/${workspaceId}/templates`);
        return;
      }

      if (templateId !== undefined) {
        const result = await client.execute(
          applyStoredTemplate({
            templateId,
            mode: mode === 'apply' ? 'merge' : 'create',
            ...(mode === 'apply' && itemId !== undefined ? { targetItemId: itemId } : {}),
            ...(mode === 'create' ? { parentItemId, title: draft.title.trim() } : {}),
            idempotencyKey: draft.idempotencyKey,
          }),
          { signal: controller.signal },
        );
        if (controller.signal.aborted || activeOperation.current !== controller) return;
        complete(`/w/${workspaceId}?item=${encodeURIComponent(result.targetItemId)}`);
      }
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setError(templateFailure(reason, 'This template could not be saved.'));
    } finally {
      if (activeOperation.current === controller) {
        activeOperation.current = null;
        setWorking(false);
      }
    }
  }

  function complete(to: string): void {
    browserSessionStorage()?.removeItem(key);
    void navigate(to);
  }

  async function next(): Promise<void> {
    await goToStep(Math.min(step + 1, STEPS.length - 1));
  }

  async function flushDraftBody(): Promise<boolean> {
    if (mode !== 'edit' || bodySync === null) return true;
    setWorking(true);
    setError(null);
    try {
      await bodySync.flushAndWait();
      return true;
    } catch {
      setError('The open body has not finished saving. Keep it open and try again.');
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function goToStep(index: number): Promise<void> {
    if (index === step) return;
    if (index > step && mode !== 'apply' && draft.title.trim().length === 0) {
      setError('Give this template a name.');
      queueMicrotask(() => {
        stepMainRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
      });
      return;
    }
    if (step === 1 && !(await flushDraftBody())) return;
    if (index === STEPS.length - 1 && !(await prepareReview())) return;
    setError(null);
    setStep(index);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-divider px-4 py-3">
        <Button
          variant="icon"
          aria-label="Cancel template setup"
          onClick={() => {
            setDiscarding(true);
          }}
        >
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <div className="min-w-0 flex-1">
          <Text variant="h3" as="h1" className="truncate">
            {title}
          </Text>
          <Text variant="caption" tone="muted" className="truncate">
            {mode === 'capture' || mode === 'edit'
              ? 'Shared with this workspace'
              : `Destination: ${destination}`}
          </Text>
        </div>
        <Button
          variant="secondary"
          className="lg:hidden"
          onClick={() => {
            setPreviewing((value) => !value);
          }}
        >
          <Icon icon={Eye} size="sm" /> {previewing ? 'Hide preview' : 'Preview'}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Template steps"
          className="shrink-0 border-b border-divider bg-surface p-3 lg:w-44 lg:border-b-0 lg:border-r"
        >
          <ol className="grid grid-cols-3 gap-1 lg:flex lg:flex-col lg:gap-2">
            {STEPS.map((entry, index) => (
              <li key={entry.label}>
                <button
                  type="button"
                  aria-current={index === step ? 'step' : undefined}
                  aria-label={`${entry.label}: ${entry.detail}`}
                  disabled={working}
                  onClick={() => {
                    void goToStep(index);
                  }}
                  className={cn(
                    `flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${focusRing}`,
                    index === step ? 'bg-accent/10 text-accent-text' : 'hover:bg-foreground/7',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background">
                    {index < step ? <Icon icon={Check} size="sm" /> : String(index + 1)}
                  </span>
                  <span className="hidden min-w-0 lg:block">
                    <Text variant="bodySmall" as="span" className="block">
                      {entry.label}
                    </Text>
                    <Text variant="caption" as="span" tone="muted" className="block truncate">
                      {entry.detail}
                    </Text>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <main
          ref={stepMainRef}
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6',
            previewing ? 'hidden lg:block' : '',
          )}
        >
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {step === 0 ? (
              <Basics
                mode={mode}
                draft={draft}
                destination={destination}
                targetTitle={targetTitle}
                onChange={setDraft}
              />
            ) : step === 1 ? (
              <Contents
                mode={mode}
                draft={draft}
                template={template}
                editOperation={editOperation}
                bodySync={bodySync}
                onBodySync={setBodySync}
                onChange={setDraft}
              />
            ) : (
              <Review
                mode={mode}
                draft={draft}
                template={template}
                preflight={preflight}
                destination={destination}
                rootFacts={rootFacts}
                missingFactsLabel={missingFactsLabel}
              />
            )}
            {error === null ? null : (
              <Text variant="bodySmall" role="alert" className="bg-surface px-3 py-2">
                {error}
              </Text>
            )}
            <div className="flex items-center justify-between border-t border-divider pt-4">
              <Button
                variant="secondary"
                disabled={step === 0 || working}
                onClick={() => {
                  void goToStep(step - 1);
                }}
              >
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button disabled={working} onClick={() => void next()}>
                  {working ? 'Checking…' : 'Continue'} <Icon icon={ArrowRight} size="sm" />
                </Button>
              ) : (
                <Button
                  disabled={working || preflight?.canApply === false}
                  onClick={() => void finish()}
                >
                  {working
                    ? 'Saving…'
                    : mode === 'capture'
                      ? 'Save template'
                      : mode === 'edit'
                        ? 'Save changes'
                        : mode === 'apply'
                          ? 'Apply template'
                          : 'Create item'}
                </Button>
              )}
            </div>
          </div>
        </main>

        <aside
          aria-label="Template preview"
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-t border-divider bg-surface p-4',
            'lg:flex-none lg:shrink-0 lg:border-l lg:border-t-0 lg:w-80 xl:w-96',
            previewing ? 'block' : 'hidden lg:block',
          )}
        >
          <TemplateBlueprint
            draft={draft}
            template={template}
            destination={destination}
            mode={mode}
            rootFacts={rootFacts}
            missingFactsLabel={missingFactsLabel}
          />
        </aside>
      </div>

      <Dialog
        open={discarding}
        title="Discard this setup?"
        onClose={() => {
          setDiscarding(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDiscarding(false);
              }}
            >
              Keep editing
            </Button>
            <Button
              disabled={working}
              onClick={() => {
                void (async () => {
                  if (mode === 'edit' && template !== null && editOperation !== null) {
                    setWorking(true);
                    try {
                      await client.execute(
                        discardTemplateEditDraft(template.id, editOperation.operationId),
                      );
                    } catch (reason) {
                      setError(templateFailure(reason, 'The draft could not be discarded.'));
                      setWorking(false);
                      setDiscarding(false);
                      return;
                    }
                  }
                  browserSessionStorage()?.removeItem(key);
                  void navigate(-1);
                })();
              }}
            >
              Discard setup
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">Discarding removes this tab&rsquo;s saved draft.</Text>
      </Dialog>
    </div>
  );
}

function Basics({
  mode,
  draft,
  destination,
  targetTitle,
  onChange,
}: {
  readonly mode: StudioMode;
  readonly draft: TemplateDraft;
  readonly destination: string;
  readonly targetTitle: string | null;
  readonly onChange: (draft: TemplateDraft) => void;
}): ReactNode {
  if (mode === 'apply') {
    return (
      <section className="flex flex-col gap-4">
        <Text variant="h2" as="h2">
          Apply to {targetTitle ?? 'this item'}
        </Text>
        <Text tone="muted">
          Existing fields, views, content, and children stay in place. The server checks additions
          and conflicts before anything changes. Starting content is used only when creating a new
          item; it is never appended to this item.
        </Text>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h2" as="h2">
          {mode === 'create' ? 'Name the new item' : 'Name the template'}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {mode === 'create'
            ? `Creating in ${destination}`
            : 'Use a name your team will recognize in New.'}
        </Text>
      </div>
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            value={draft.title}
            onChange={(event) => {
              onChange({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      {mode === 'create' ? null : (
        <Field label="Description" hint="Optional. Say when this starting point is useful.">
          {(control) => (
            <Input
              {...control}
              value={draft.description}
              onChange={(event) => {
                onChange({ ...draft, description: event.target.value });
              }}
            />
          )}
        </Field>
      )}
    </section>
  );
}

function Contents({
  mode,
  draft,
  template,
  editOperation,
  bodySync,
  onBodySync,
  onChange,
}: {
  readonly mode: StudioMode;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly editOperation: TemplateEditDraft | null;
  readonly bodySync: CollabSync | null;
  readonly onBodySync: (sync: CollabSync | null) => void;
  readonly onChange: (draft: TemplateDraft) => void;
}): ReactNode {
  if (mode === 'edit') {
    if (editOperation === null) {
      return (
        <StudioNotice title="Draft unavailable" detail="The editable copy could not be prepared." />
      );
    }
    return (
      <section className="flex flex-col gap-4">
        <Text variant="caption" tone="muted">
          Draft available until{' '}
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(editOperation.expiresAt))}
          . Save before then to keep body edits.
        </Text>
        <TemplateDraftEditor
          root={editOperation.root}
          edits={draft.itemEdits}
          templateId={editOperation.templateId}
          operationId={editOperation.operationId}
          bodySync={bodySync}
          onBodySync={onBodySync}
          selectedSourceId={draft.selectedSourceId ?? editOperation.root.sourceId}
          onSelect={(selectedSourceId) => {
            onChange({ ...draft, selectedSourceId });
          }}
          onChange={(sourceId, itemEdit: TemplateItemEdit) => {
            onChange({
              ...draft,
              itemEdits: { ...draft.itemEdits, [sourceId]: itemEdit },
            });
          }}
        />
      </section>
    );
  }
  if (mode !== 'capture') {
    return (
      <section className="flex flex-col gap-4">
        <Text variant="h2" as="h2">
          What this template adds
        </Text>
        <TemplateFacts template={template} mode={mode} />
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h2" as="h2">
          Choose what to capture
        </Text>
        <Text variant="bodySmall" tone="muted">
          Fields and views are always included. Content and children start off to protect real
          workspace data.
        </Text>
      </div>
      <Blueprint className="flex flex-col gap-3 p-4">
        <TemplateFact label="Fields and views" value="Included" />
        <label
          aria-label="Include document content"
          className="flex cursor-pointer items-start gap-3"
        >
          <input
            type="checkbox"
            checked={draft.includeBody}
            onChange={(event) => {
              onChange({ ...draft, includeBody: event.target.checked });
            }}
            className={`mt-0.5 size-4 ${focusRing}`}
          />
          <span>
            <Text variant="bodySmall" as="span" className="block">
              Include document content
            </Text>
            <Text variant="caption" as="span" tone="muted" className="block">
              Copies the note, canvas, or sheet body as starting content.
            </Text>
          </span>
        </label>
        <label
          aria-label="Include everything inside"
          className="flex cursor-pointer items-start gap-3"
        >
          <input
            type="checkbox"
            checked={draft.includeChildren}
            onChange={(event) => {
              onChange({ ...draft, includeChildren: event.target.checked });
            }}
            className={`mt-0.5 size-4 ${focusRing}`}
          />
          <span>
            <Text variant="bodySmall" as="span" className="block">
              Include everything inside
            </Text>
            <Text variant="caption" as="span" tone="muted" className="block">
              Copies the readable child subtree and its property values.
            </Text>
          </span>
        </label>
      </Blueprint>
    </section>
  );
}

function Review({
  mode,
  draft,
  template,
  preflight,
  destination,
  rootFacts,
  missingFactsLabel,
}: {
  readonly mode: StudioMode;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly preflight: TemplatePreflight | null;
  readonly destination: string;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
}): ReactNode {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h2" as="h2">
          Review
        </Text>
        <Text variant="bodySmall" tone="muted">
          Nothing changes until you finish.
        </Text>
      </div>
      <TemplateBlueprint
        draft={draft}
        template={template}
        destination={destination}
        mode={mode}
        rootFacts={rootFacts}
        missingFactsLabel={missingFactsLabel}
      />
      {preflight === null ? null : (
        <Blueprint className="flex flex-col gap-2 p-4">
          <TemplateFact label="Fields added" value={String(preflight.additions.fields)} />
          <TemplateFact label="Views added" value={String(preflight.additions.views)} />
          <TemplateFact label="Items added" value={String(preflight.additions.items)} />
          {preflight.conflicts.map((conflict) => (
            <Text key={conflict} variant="bodySmall" role="alert">
              {conflict}
            </Text>
          ))}
        </Blueprint>
      )}
      {mode === 'edit' ? (
        <Text variant="caption" tone="muted">
          The active template stays unchanged until Save completes every draft change together.
        </Text>
      ) : null}
    </section>
  );
}

function TemplateBlueprint({
  draft,
  template,
  destination,
  mode,
  rootFacts,
  missingFactsLabel,
}: {
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly destination: string;
  readonly mode: StudioMode;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
}): ReactNode {
  return (
    <Blueprint className="flex flex-col gap-4 p-4">
      <div>
        <Text variant="kicker">Template blueprint</Text>
        <Text variant="h3">{draft.title || 'Untitled template'}</Text>
        {draft.description ? (
          <Text variant="bodySmall" tone="muted">
            {draft.description}
          </Text>
        ) : null}
      </div>
      <TemplateFacts
        template={template}
        fallback={draft}
        mode={mode}
        rootFacts={rootFacts}
        missingFactsLabel={missingFactsLabel}
      />
      <div className="border-t border-divider pt-3">
        <TemplateFact label="Destination" value={destination} />
      </div>
    </Blueprint>
  );
}

function TemplateFacts({
  template,
  fallback,
  mode,
  rootFacts = null,
  missingFactsLabel = null,
}: {
  readonly template: TemplateDetail | null;
  readonly fallback?: TemplateDraft;
  readonly mode?: StudioMode;
  readonly rootFacts?: RootTemplateFacts | null;
  readonly missingFactsLabel?: string | null;
}): ReactNode {
  const fieldCount = rootFacts?.fieldCount ?? template?.fieldCount;
  const viewCount = rootFacts?.viewCount ?? template?.viewCount;
  const viewKinds = rootFacts?.viewKinds ?? template?.viewKinds ?? [];
  return (
    <div className="flex flex-col gap-2">
      <TemplateFact label="Fields" value={fieldCount?.toString() ?? missingFactsLabel ?? '0'} />
      <TemplateFact label="Views" value={viewCount?.toString() ?? missingFactsLabel ?? '0'} />
      <TemplateFact
        label="Children"
        value={
          template?.includeChildren === true || fallback?.includeChildren === true
            ? String(template?.childCount ?? 'Included')
            : 'Not included'
        }
      />
      <TemplateFact
        label="Content"
        value={
          template?.includeBody === true || fallback?.includeBody === true
            ? mode === 'apply'
              ? 'New items only'
              : 'Included'
            : 'Not included'
        }
      />
      {viewKinds.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {viewKinds.map((kind) => (
            <Tag key={kind}>{kind.replace('_', ' ')}</Tag>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="bodySmall" className="text-right">
        {value}
      </Text>
    </div>
  );
}

function StudioNotice({
  title,
  detail,
  children,
  attention = false,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
  readonly attention?: boolean;
}): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (attention) headingRef.current?.focus();
  }, [attention, title]);

  return (
    <div
      role={attention ? 'alert' : undefined}
      aria-live={attention ? 'assertive' : undefined}
      className="flex min-h-0 flex-1 items-center justify-center p-6"
    >
      <Blueprint className="flex max-w-lg flex-col items-start gap-3 p-6">
        <Icon icon={LayoutTemplate} size="md" />
        <h1 ref={headingRef} tabIndex={attention ? -1 : undefined}>
          <Text variant="h2" as="span">
            {title}
          </Text>
        </h1>
        <Text tone="muted">{detail}</Text>
        {children}
      </Blueprint>
    </div>
  );
}
