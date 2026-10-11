import { Button, Field, Input, Text } from '@nix/ui';
import { useId, useRef, useState, type ReactNode } from 'react';

import { FilterRulesEditor } from '../query/filter-rules-editor';
import type { PropertyDefinition, View, ViewFilterRule } from './container-model';
import type { ViewStateControl } from './view-state';

export interface ViewToolsProps {
  readonly view: View | null;
  readonly schema: readonly PropertyDefinition[];
  readonly viewState: Pick<ViewStateControl, 'search' | 'setSearch' | 'filters' | 'clearFilters'>;
  readonly onSave: (filters: readonly ViewFilterRule[]) => Promise<string | null>;
}

export function ViewTools({ view, schema, viewState, onSave }: ViewToolsProps): ReactNode {
  const panelId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<readonly ViewFilterRule[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function closeFilters(): void {
    setDraft(null);
    setError(null);
    requestAnimationFrame(() => filterTrigger.current?.focus());
  }

  async function save(): Promise<void> {
    if (draft === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const refusal = await onSave(draft);
      if (refusal !== null) setError(refusal);
      else closeFilters();
    } catch {
      setError('The filters could not be saved. Your changes are still here.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 pb-3">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-full">
          <Field
            label="Search titles"
            hint={
              view?.kind === 'query'
                ? 'Search the loaded smart list results.'
                : 'Search the loaded items in this view.'
            }
          >
            {(control) => (
              <Input
                {...control}
                ref={searchInput}
                type="search"
                value={viewState.search}
                onChange={(event) => {
                  viewState.setSearch(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        {viewState.search.length === 0 ? null : (
          <Button
            variant="ghost"
            onClick={() => {
              viewState.setSearch('');
              searchInput.current?.focus();
            }}
          >
            Clear search
          </Button>
        )}
        {view === null ? null : (
          <Button
            ref={filterTrigger}
            variant="secondary"
            aria-expanded={draft !== null}
            aria-controls={panelId}
            disabled={saving}
            onClick={() => {
              setDraft(draft === null ? view.filters : null);
              setError(null);
            }}
          >
            View filters{view.filters.length === 0 ? '' : ` (${String(view.filters.length)})`}
          </Button>
        )}
        {viewState.filters.length === 0 ? null : (
          <Button
            variant="ghost"
            onClick={() => {
              viewState.clearFilters();
              searchInput.current?.focus();
            }}
          >
            Clear link filters ({String(viewState.filters.length)})
          </Button>
        )}
      </div>
      {draft === null ? null : (
        <section
          id={panelId}
          aria-label="Saved view filters"
          className="flex min-w-0 flex-col gap-3 border border-divider p-3"
          aria-busy={saving}
        >
          <Text variant="note" tone="muted">
            Saving changes this view&apos;s filters for everyone. Title search only changes your
            current link.
          </Text>
          <fieldset disabled={saving} className="min-w-0">
            <FilterRulesEditor
              scope={view?.kind === 'query' ? 'query' : 'container'}
              rules={draft}
              schema={schema}
              onChange={setDraft}
            />
          </fieldset>
          {error === null ? null : (
            <Text variant="note" tone="accent" role="alert">
              {error}
            </Text>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving filters…' : 'Save view filters'}
            </Button>
            <Button variant="ghost" disabled={saving} onClick={closeFilters}>
              Cancel
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
