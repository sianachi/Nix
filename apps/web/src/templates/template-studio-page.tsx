import { Button } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from 'react-router';

import { isCanceledError, isNixApiError } from '@nix/api-client';

import { useApiClient } from '../api/api-client-provider';
import type { CollabSync } from '../editor/collab-sync';
import { browserSessionStorage } from '../lib/browser-storage';
import type { ShellContext } from '../shell/shell-context';
import { useWorkspace } from '../workspaces/workspace-context';
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
import { useTemplateLibrary } from './template-library-context';
import {
  distinctViewKinds,
  draftScope,
  editedRootFacts,
  modeFromPath,
  newDraft,
  readDraft,
  storageKey,
  TEMPLATE_STUDIO_STEPS,
  type CaptureFacts,
  type TemplateDraft,
} from './template-studio-model';
import { Review } from './template-studio-facts';
import { TemplateStudioShell } from './template-studio-shell';
import { Basics, Contents } from './template-studio-steps';
import { StudioNotice } from './template-studio-notice';
import { templateFailure } from './use-templates';

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
  const [draft, setDraft] = useState<TemplateDraft>(initialDraft);
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
    if (index === TEMPLATE_STUDIO_STEPS.length - 1 && !(await prepareReview())) return;
    setError(null);
    setStep(index);
  }

  async function discard(): Promise<void> {
    if (mode === 'edit' && template !== null && editOperation !== null) {
      setWorking(true);
      try {
        await client.execute(discardTemplateEditDraft(template.id, editOperation.operationId));
      } catch (reason) {
        setError(templateFailure(reason, 'The draft could not be discarded.'));
        setWorking(false);
        setDiscarding(false);
        return;
      }
    }
    browserSessionStorage()?.removeItem(key);
    void navigate(-1);
  }

  return (
    <TemplateStudioShell
      mode={mode}
      title={title}
      destination={destination}
      step={step}
      working={working}
      previewing={previewing}
      error={error}
      discarding={discarding}
      draft={draft}
      template={template}
      rootFacts={rootFacts}
      missingFactsLabel={missingFactsLabel}
      stepMainRef={stepMainRef}
      onRequestDiscard={() => {
        setDiscarding(true);
      }}
      onCloseDiscard={() => {
        setDiscarding(false);
      }}
      onDiscard={() => {
        void discard();
      }}
      onTogglePreview={() => {
        setPreviewing((value) => !value);
      }}
      onStepChange={(index) => {
        void goToStep(index);
      }}
      onBack={() => {
        void goToStep(step - 1);
      }}
      onNext={() => {
        void goToStep(Math.min(step + 1, TEMPLATE_STUDIO_STEPS.length - 1));
      }}
      onFinish={() => {
        void finish();
      }}
      finishLabel={
        mode === 'capture'
          ? 'Save template'
          : mode === 'edit'
            ? 'Save changes'
            : mode === 'apply'
              ? 'Apply template'
              : 'Create item'
      }
      finishDisabled={preflight?.canApply === false}
    >
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
    </TemplateStudioShell>
  );
}
