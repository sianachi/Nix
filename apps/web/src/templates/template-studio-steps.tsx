import { Blueprint, Field, Input, Text, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import type { CollabSync } from '../editor/collab-sync';
import type { TemplateDetail, TemplateEditDraft } from './template-api';
import { TemplateDraftEditor, type TemplateItemEdit } from './template-draft-editor';
import { TemplateFact, TemplateFacts } from './template-studio-facts';
import type { StudioMode, TemplateDraft } from './template-studio-model';
import { StudioNotice } from './template-studio-notice';

export function Basics({
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

export function Contents({
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
