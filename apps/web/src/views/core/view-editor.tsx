import { Button, Icon, Text } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { STRUCTURED_RECIPES } from '../wizard/structured-recipes';
import type { View } from './container-model';
import { EditorShell } from './editor-shell';
import type { ContainerData } from './use-container';
import { findViewKind } from './view-kinds';

function guidedRecipeFor(kind: string): (typeof STRUCTURED_RECIPES)[number] | null {
  return (
    STRUCTURED_RECIPES.find((recipe) => recipe.viewKind === kind && recipe.menu === 'structured') ??
    STRUCTURED_RECIPES.find((recipe) => recipe.viewKind === kind) ??
    null
  );
}

/**
 * Adding and configuring the ways a folder can be looked at.
 *
 * **Order is part of what is being edited**, which is why this saves the whole set rather than one
 * view at a time: a switcher's entries get dragged into an order about as often as an individual
 * view gets renamed, and per-view saves would make a reorder a sequence of writes that can
 * half-apply.
 *
 * The configuration a view needs depends on its kind, and only the fields that apply are shown. A
 * board offered a date property, or a calendar offered a grouping property, would be an invitation
 * to configure something the renderer ignores.
 */

export interface ViewEditorProps {
  readonly container: ContainerData;
  readonly open: boolean;
  readonly onClose: () => void;

  /** Renders as a column in the settings panel rather than as a dialog over the view. */
  readonly inline?: boolean;
}

export function ViewEditor({
  container,
  open,
  onClose,
  inline = false,
}: ViewEditorProps): ReactNode {
  const stored = container.views?.views ?? [];
  const [draft, setDraft] = useState<readonly View[]>(stored);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  const [openedWith, setOpenedWith] = useState(open);
  if (open !== openedWith) {
    setOpenedWith(open);
    if (open) {
      setDraft(stored);
      setError(null);
    }
  }

  function move(index: number, by: number): void {
    setDraft((current) => {
      const next = [...current];
      const target = index + by;
      const moved = next[index];
      const displaced = next[target];

      if (moved === undefined || displaced === undefined) {
        return current;
      }

      next[index] = displaced;
      next[target] = moved;
      return next;
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);

    // **The first view an item is given becomes what it opens on.** Building a board and watching
    // the screen not change is the whole of the bug this exists to prevent: the item kept opening
    // on its document, because that is what it had always said, and the person had no reason to
    // suspect a switcher had appeared above the thing they were already looking at.
    //
    // Only the first. Once an item offers views, "document" is a choice somebody can have made
    // deliberately, and adding a second view must not overrule it.
    const first = stored.length === 0 && draft.length > 0 ? draft[0]?.id : undefined;

    const refusal =
      first === undefined
        ? await container.setViews(draft)
        : await container.setViews(draft, first);

    setSaving(false);

    if (refusal === null) {
      onClose();
      return;
    }

    setError(refusal);
  }

  return (
    <EditorShell
      inline={inline}
      open={open}
      title="Views for this item"
      onClose={onClose}
      onSave={() => {
        void save();
      }}
      saving={saving}
      saveLabel="Save views"
    >
      <div className="flex flex-col gap-4">
        <Text variant="bodySmall" tone="muted">
          A view is a way of looking at this item. Everybody who can see it sees the same views.
        </Text>

        {error === null ? null : (
          <Text variant="bodySmall" role="alert" className="border border-foreground px-3 py-2">
            {error}
          </Text>
        )}

        {draft.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            No views yet. Without one, this item shows a plain list.
          </Text>
        ) : null}

        {draft.map((view, index) => (
          <div key={view.id} className="flex flex-col gap-2 border border-divider p-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Text variant="bodySmall" className="truncate">
                  {view.name}
                </Text>
                <Text variant="caption" tone="muted">
                  {findViewKind(view.kind)?.label ?? view.kind}
                  {view.companionViewId === null ? '' : ' · Has companion'}
                </Text>
              </div>

              <Button
                variant="secondary"
                disabled={container.itemId === null || guidedRecipeFor(view.kind) === null}
                onClick={() => {
                  const guidedRecipe = guidedRecipeFor(view.kind);
                  if (container.itemId !== null && guidedRecipe !== null) {
                    void navigate(
                      `/items/${container.itemId}/views/${encodeURIComponent(view.id)}/edit/${guidedRecipe.id}`,
                    );
                  }
                }}
              >
                Configure
              </Button>

              <Button
                variant="icon"
                aria-label={`Move ${view.name} earlier`}
                disabled={index === 0}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <Icon icon={ChevronUp} size="sm" />
              </Button>

              <Button
                variant="icon"
                aria-label={`Move ${view.name} later`}
                disabled={index === draft.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <Icon icon={ChevronDown} size="sm" />
              </Button>

              <Button
                variant="icon"
                aria-label={`Remove ${view.name}`}
                onClick={() => {
                  setDraft((current) => current.filter((_, position) => position !== index));
                }}
              >
                <Icon icon={Trash2} size="sm" />
              </Button>
            </div>
          </div>
        ))}

        <Button
          variant="secondary"
          onClick={() => {
            setAdding((current) => !current);
          }}
        >
          <Icon icon={Plus} size="sm" />
          {adding ? 'Close view choices' : 'Add a view'}
        </Button>
        {adding ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {STRUCTURED_RECIPES.filter(
              (recipe, index, all) =>
                all.findIndex((candidate) => candidate.viewKind === recipe.viewKind) === index,
            ).map((recipe) => (
              <Button
                key={recipe.id}
                variant="secondary"
                className="flex-col items-start gap-0.5 px-3 py-2 text-left"
                disabled={container.itemId === null}
                onClick={() => {
                  if (container.itemId !== null) {
                    void navigate(`/items/${container.itemId}/views/new/${recipe.id}`);
                  }
                }}
              >
                <span>{recipe.label}</span>
                <Text variant="caption" as="span" tone="muted">
                  {recipe.detail}
                </Text>
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </EditorShell>
  );
}
