import { Button, Field, Input, Select, Text } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { Icon } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { isCanceledError, isNixApiError } from '@nix/api-client';

import { useApiClient } from '../../api/api-client-provider';
import { PropertyInput, isKnownPropertyType } from '../../properties/property-input';
import type {
  FormBlock,
  FormCondition,
  InteractiveFormDefinition,
  PropertyDefinition,
  PropertyValue,
} from '../core/container-model';
import { isComputedType } from '../core/property-types';
import { changePublicFormStatus, publicFormStatus } from './public-form-api';
import { normalizeInteractiveForm } from './interactive-form-rules';

export const EMPTY_INTERACTIVE_FORM: InteractiveFormDefinition = {
  pages: [
    {
      id: 'page-1',
      title: 'Your response',
      description: null,
      visibleWhen: [],
      blocks: [],
    },
  ],
  titleMode: 'generated',
  titleFieldBlockId: null,
  confirmationTitle: 'Response received',
  confirmationMessage: 'Your response has been added.',
};

export function InteractiveFormEditor({
  form,
  schema,
  itemId,
  viewId,
  onChange,
  showPublishing = true,
}: {
  readonly form: InteractiveFormDefinition;
  readonly schema: readonly PropertyDefinition[];
  readonly itemId: string | null;
  readonly viewId: string;
  readonly onChange: (form: InteractiveFormDefinition) => void;
  readonly showPublishing?: boolean;
}): ReactNode {
  const [previewing, setPreviewing] = useState(false);
  const fields = form.pages
    .flatMap((page) => page.blocks)
    .filter((block) => block.kind === 'field');

  function commit(next: InteractiveFormDefinition): void {
    onChange(normalizeInteractiveForm(next, schema));
  }

  function updatePage(
    index: number,
    change: Partial<InteractiveFormDefinition['pages'][number]>,
  ): void {
    commit({
      ...form,
      pages: form.pages.map((page, position) =>
        position === index ? { ...page, ...change } : page,
      ),
    });
  }

  return (
    <section
      aria-label="Interactive form designer"
      className="flex flex-col gap-3 border-l-2 border-accent pl-3"
    >
      <div>
        <Text variant="h4" as="h3">
          Form flow
        </Text>
        <Text variant="note" tone="muted">
          Pages are shown in order. Conditions only use answers from earlier fields.
        </Text>
      </div>
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          setPreviewing((current) => !current);
        }}
      >
        {previewing ? 'Close preview' : 'Preview structure'}
      </Button>
      {previewing ? <InteractiveFormRespondentPreview form={form} schema={schema} /> : null}

      {form.pages.map((page, pageIndex) => (
        <div key={page.id} className="flex flex-col gap-2 border border-divider p-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label={`Page ${String(pageIndex + 1)} title`} className="flex-1">
              {(control) => (
                <Input
                  {...control}
                  value={page.title}
                  onChange={(event) => {
                    updatePage(pageIndex, { title: event.target.value });
                  }}
                />
              )}
            </Field>
            {form.pages.length === 1 ? null : (
              <>
                <Button
                  variant="icon"
                  disabled={pageIndex === 0}
                  aria-label={`Move ${page.title} up`}
                  onClick={() => {
                    commit({ ...form, pages: move(form.pages, pageIndex, -1) });
                  }}
                >
                  <Icon icon={ChevronUp} size="sm" />
                </Button>
                <Button
                  variant="icon"
                  disabled={pageIndex === form.pages.length - 1}
                  aria-label={`Move ${page.title} down`}
                  onClick={() => {
                    commit({ ...form, pages: move(form.pages, pageIndex, 1) });
                  }}
                >
                  <Icon icon={ChevronDown} size="sm" />
                </Button>
                <Button
                  variant="icon"
                  aria-label={`Remove ${page.title}`}
                  onClick={() => {
                    commit({
                      ...form,
                      pages: form.pages.filter((_, index) => index !== pageIndex),
                    });
                  }}
                >
                  <Icon icon={Trash2} size="sm" />
                </Button>
              </>
            )}
          </div>
          <Field label="Introduction">
            {(control) => (
              <textarea
                rows={3}
                {...control}
                value={page.description ?? ''}
                onChange={(event) => {
                  updatePage(pageIndex, { description: event.target.value || null });
                }}
              />
            )}
          </Field>
          <PageConditions
            conditions={page.visibleWhen}
            earlier={form.pages
              .slice(0, pageIndex)
              .flatMap((entry) => entry.blocks)
              .filter((entry) => entry.kind === 'field')}
            onChange={(visibleWhen) => {
              updatePage(pageIndex, { visibleWhen });
            }}
          />

          {page.blocks.map((block, blockIndex) => (
            <BlockEditor
              key={block.id}
              block={block}
              schema={schema}
              earlier={form.pages
                .slice(0, pageIndex)
                .flatMap((entry) => entry.blocks)
                .concat(page.blocks.slice(0, blockIndex))
                .filter((entry) => entry.kind === 'field')}
              onChange={(next) => {
                updatePage(pageIndex, {
                  blocks: page.blocks.map((entry, index) => (index === blockIndex ? next : entry)),
                });
              }}
              onRemove={() => {
                updatePage(pageIndex, {
                  blocks: page.blocks.filter((_, index) => index !== blockIndex),
                });
              }}
              onMove={(by) => {
                updatePage(pageIndex, { blocks: move(page.blocks, blockIndex, by) });
              }}
              canMoveUp={blockIndex > 0}
              canMoveDown={blockIndex < page.blocks.length - 1}
            />
          ))}

          <div className="flex flex-wrap gap-2">
            {(['field', 'heading', 'paragraph'] as const).map((kind) => (
              <Button
                key={kind}
                variant="secondary"
                onClick={() => {
                  const id = `block-${crypto.randomUUID()}`;
                  updatePage(pageIndex, {
                    blocks: [
                      ...page.blocks,
                      {
                        id,
                        kind,
                        propertyKey: kind === 'field' ? (schema[0]?.key ?? null) : null,
                        text:
                          kind === 'field'
                            ? (schema[0]?.label ?? 'Question')
                            : kind === 'heading'
                              ? 'Section heading'
                              : 'Helpful context',
                        help: null,
                        required: false,
                        identityRole: null,
                        visibleWhen: [],
                      },
                    ],
                  });
                }}
              >
                <Icon icon={Plus} size="sm" /> Add {kind}
              </Button>
            ))}
          </div>
        </div>
      ))}

      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          commit({
            ...form,
            pages: [
              ...form.pages,
              {
                id: `page-${crypto.randomUUID()}`,
                title: `Page ${String(form.pages.length + 1)}`,
                description: null,
                visibleWhen: [],
                blocks: [],
              },
            ],
          });
        }}
      >
        <Icon icon={Plus} size="sm" /> Add page
      </Button>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Response title">
          {(control) => (
            <Select
              {...control}
              value={form.titleMode === 'field' ? (form.titleFieldBlockId ?? '') : ''}
              onChange={(event) => {
                commit({
                  ...form,
                  titleMode: event.target.value ? 'field' : 'generated',
                  titleFieldBlockId: event.target.value || null,
                });
              }}
            >
              <option value="">Generate from form and time</option>
              {fields.map((field) => (
                <option key={field.id} value={field.id}>
                  Use “{field.text}”
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Confirmation heading">
          {(control) => (
            <Input
              {...control}
              value={form.confirmationTitle}
              onChange={(event) => {
                commit({ ...form, confirmationTitle: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Confirmation message">
        {(control) => (
          <textarea
            rows={3}
            {...control}
            value={form.confirmationMessage}
            onChange={(event) => {
              commit({ ...form, confirmationMessage: event.target.value });
            }}
          />
        )}
      </Field>
      {showPublishing ? <PublishingControls itemId={itemId} viewId={viewId} /> : null}
    </section>
  );
}

export function InteractiveFormRespondentPreview({
  form,
  schema,
}: {
  readonly form: InteractiveFormDefinition;
  readonly schema: readonly PropertyDefinition[];
}): ReactNode {
  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, PropertyValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [complete, setComplete] = useState(false);
  const pages = form.pages.filter((page) => formPartVisible(page.visibleWhen, answers));
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];

  if (complete) {
    return (
      <aside
        aria-label="Form preview"
        className="flex flex-col gap-3 border border-divider bg-background p-4"
      >
        <Text variant="h3" as="h3">
          {form.confirmationTitle}
        </Text>
        <Text tone="muted">{form.confirmationMessage}</Text>
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            setComplete(false);
            setPageIndex(0);
          }}
        >
          Preview again
        </Button>
      </aside>
    );
  }

  if (page === undefined) {
    return (
      <aside aria-label="Form preview" className="border border-divider bg-background p-4">
        <Text tone="muted">No page is currently visible.</Text>
      </aside>
    );
  }

  const blocks = page.blocks.filter((block) => formPartVisible(block.visibleWhen, answers));
  const last = pageIndex >= pages.length - 1;
  function advance(): void {
    const missing = Object.fromEntries(
      blocks
        .filter(
          (block) => block.kind === 'field' && block.required && emptyAnswer(answers[block.id]),
        )
        .map((block) => [block.id, 'This answer is required.']),
    );
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    if (last) setComplete(true);
    else setPageIndex((current) => current + 1);
  }

  return (
    <aside
      aria-label="Form preview"
      className="flex flex-col gap-4 border border-divider bg-background p-4"
    >
      <header className="flex flex-col gap-1 border-b border-divider pb-3">
        <Text variant="caption" tone="muted">
          Page {String(pageIndex + 1)} of {String(pages.length)}
        </Text>
        <Text variant="h3" as="h3">
          {page.title}
        </Text>
        {page.description === null ? null : <Text tone="muted">{page.description}</Text>}
      </header>
      {blocks.map((block) => {
        if (block.kind === 'heading')
          return (
            <Text key={block.id} variant="h4" as="h4">
              {block.text}
            </Text>
          );
        if (block.kind === 'paragraph')
          return (
            <Text key={block.id} tone="muted">
              {block.text}
            </Text>
          );
        const property = schema.find((candidate) => candidate.key === block.propertyKey);
        if (property === undefined || !isKnownPropertyType(property.type)) return null;
        return (
          <div key={block.id} className="flex flex-col gap-1">
            {block.help === null ? null : (
              <Text variant="note" tone="muted">
                {block.help}
              </Text>
            )}
            <PropertyInput
              item={{
                title: '',
                properties:
                  answers[block.id] === undefined ? {} : { [block.id]: answers[block.id] },
              }}
              property={{ ...property, key: block.id, label: block.text, required: block.required }}
              error={errors[block.id] ?? null}
              onCommit={(value) => {
                setAnswers((current) => ({ ...current, [block.id]: value }));
              }}
            />
          </div>
        );
      })}
      <div className="flex gap-2">
        {pageIndex === 0 ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              setPageIndex((current) => current - 1);
            }}
          >
            Back
          </Button>
        )}
        <Button onClick={advance}>{last ? 'Preview confirmation' : 'Continue'}</Button>
      </div>
    </aside>
  );
}

function formPartVisible(
  conditions: readonly FormCondition[],
  answers: Readonly<Record<string, PropertyValue>>,
): boolean {
  return conditions.every((condition) => {
    const answer = answers[condition.fieldBlockId];
    const expected = condition.value ?? '';
    if (condition.operator === 'checked') return answer === true;
    if (condition.operator === 'not_checked') return answer !== true;
    if (condition.operator === 'not_equals') return String(answer ?? '') !== expected;
    if (condition.operator === 'contains')
      return Array.isArray(answer)
        ? answer.includes(expected)
        : String(answer ?? '').includes(expected);
    return String(answer ?? '') === expected;
  });
}

function emptyAnswer(value: PropertyValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function PageConditions({
  conditions,
  earlier,
  onChange,
}: {
  readonly conditions: readonly FormCondition[];
  readonly earlier: readonly FormBlock[];
  readonly onChange: (conditions: FormCondition[]) => void;
}): ReactNode {
  if (earlier.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-divider p-3">
      <Text variant="note" tone="muted">
        Show this page only when all conditions match
      </Text>
      {conditions.map((condition, index) => (
        <div
          key={`${condition.fieldBlockId}-${String(index)}`}
          className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
        >
          <Select
            aria-label="Page condition field"
            value={condition.fieldBlockId}
            onChange={(event) => {
              onChange(
                conditions.map((entry, position) =>
                  position === index ? { ...entry, fieldBlockId: event.target.value } : entry,
                ),
              );
            }}
          >
            {earlier.map((field) => (
              <option key={field.id} value={field.id}>
                {field.text}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Page condition rule"
            value={condition.operator}
            onChange={(event) => {
              onChange(
                conditions.map((entry, position) =>
                  position === index ? { ...entry, operator: event.target.value } : entry,
                ),
              );
            }}
          >
            <option value="equals">Equals</option>
            <option value="not_equals">Does not equal</option>
            <option value="contains">Contains</option>
            <option value="checked">Is checked</option>
            <option value="not_checked">Is not checked</option>
          </Select>
          <Input
            aria-label="Page condition value"
            disabled={condition.operator === 'checked' || condition.operator === 'not_checked'}
            value={condition.value ?? ''}
            onChange={(event) => {
              onChange(
                conditions.map((entry, position) =>
                  position === index ? { ...entry, value: event.target.value } : entry,
                ),
              );
            }}
          />
          <Button
            variant="icon"
            aria-label="Remove page condition"
            onClick={() => {
              onChange(conditions.filter((_, position) => position !== index));
            }}
          >
            <Icon icon={Trash2} size="sm" />
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          onChange([
            ...conditions,
            { fieldBlockId: earlier[0]?.id ?? '', operator: 'equals', value: '' },
          ]);
        }}
      >
        <Icon icon={Plus} size="sm" /> Add page condition
      </Button>
    </div>
  );
}

function move<T>(values: readonly T[], index: number, by: -1 | 1): T[] {
  const next = [...values];
  const target = index + by;
  const current = next[index];
  const replacement = next[target];
  if (current === undefined || replacement === undefined) return next;
  next[index] = replacement;
  next[target] = current;
  return next;
}

function PublishingControls({
  itemId,
  viewId,
}: {
  readonly itemId: string | null;
  readonly viewId: string;
}): ReactNode {
  const client = useApiClient();
  const [url, setUrl] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    itemId === null ? 'idle' : 'loading',
  );
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const pendingChange = useRef<AbortController | null>(null);

  useEffect(() => {
    if (itemId === null) return;
    const controller = new AbortController();
    void client
      .query(publicFormStatus(itemId, viewId), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then((result) => {
        setPublished(result.published);
        setUrl(result.url);
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (isCanceledError(reason)) return;
        setStatus('error');
        setOutcome(formLinkFailure(reason, 'The public-link status could not be loaded.'));
      });
    return () => {
      controller.abort();
      pendingChange.current?.abort();
    };
  }, [client, itemId, viewId]);

  async function change(method: 'PUT' | 'DELETE'): Promise<void> {
    if (itemId === null || status !== 'ready') return;
    pendingChange.current?.abort();
    const controller = new AbortController();
    pendingChange.current = controller;
    setWorking(true);
    setOutcome(null);
    try {
      const result = await client.execute(changePublicFormStatus(itemId, viewId, method), {
        signal: controller.signal,
      });
      setPublished(result.published);
      setUrl(result.url);
      setOutcome(
        result.published ? 'A new public link is ready.' : 'The public link has been revoked.',
      );
    } catch (reason) {
      if (isCanceledError(reason)) return;
      setOutcome(
        formLinkFailure(
          reason,
          'The public link could not be changed. Save this view and try again.',
        ),
      );
    } finally {
      if (pendingChange.current === controller) pendingChange.current = null;
      setWorking(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 border-t border-divider p-3">
      <div>
        <Text variant="h4" as="h3">
          Publish
        </Text>
        <Text variant="note" tone="muted">
          Save form changes first. Republishing rotates the old link.
        </Text>
        <Text variant="note" tone="muted">
          Status:{' '}
          {status === 'loading'
            ? 'Checking publication status'
            : status === 'error'
              ? 'Unavailable'
              : status === 'idle'
                ? 'Save this view to check'
                : published
                  ? 'Published'
                  : 'Not published'}
        </Text>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={working || itemId === null || status !== 'ready'}
          onClick={() => {
            void change('PUT');
          }}
        >
          {working ? 'Working…' : 'Publish form'}
        </Button>
        <Button
          variant="secondary"
          disabled={working || itemId === null || status !== 'ready' || !published}
          onClick={() => {
            void change('DELETE');
          }}
        >
          Revoke link
        </Button>
      </div>
      {url === null ? null : (
        <div className="flex gap-2">
          <Input aria-label="Public form URL" readOnly value={url} />
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(url);
            }}
          >
            Copy
          </Button>
        </div>
      )}
      {outcome === null ? null : (
        <Text variant="note" role="status">
          {outcome}
        </Text>
      )}
    </section>
  );
}

function formLinkFailure(reason: unknown, fallback: string): string {
  return isNixApiError(reason) ? (reason.detail ?? fallback) : fallback;
}

function BlockEditor({
  block,
  schema,
  earlier,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  readonly block: FormBlock;
  readonly schema: readonly PropertyDefinition[];
  readonly earlier: readonly FormBlock[];
  readonly onChange: (block: FormBlock) => void;
  readonly onRemove: () => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}): ReactNode {
  const identityEligible =
    schema.find((property) => property.key === block.propertyKey)?.type === 'text';
  return (
    <div className="flex flex-col gap-2 bg-surface p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label={
            block.kind === 'field' ? 'Question' : block.kind === 'heading' ? 'Heading' : 'Text'
          }
          className="min-w-full sm:min-w-0 sm:flex-1"
        >
          {(control) =>
            block.kind === 'paragraph' ? (
              <textarea
                {...control}
                rows={3}
                value={block.text}
                onChange={(event) => {
                  onChange({ ...block, text: event.target.value });
                }}
              />
            ) : (
              <Input
                {...control}
                value={block.text}
                onChange={(event) => {
                  onChange({ ...block, text: event.target.value });
                }}
              />
            )
          }
        </Field>
        <Button
          variant="icon"
          disabled={!canMoveUp}
          aria-label={`Move ${block.text} up`}
          onClick={() => {
            onMove(-1);
          }}
        >
          <Icon icon={ChevronUp} size="sm" />
        </Button>
        <Button
          variant="icon"
          disabled={!canMoveDown}
          aria-label={`Move ${block.text} down`}
          onClick={() => {
            onMove(1);
          }}
        >
          <Icon icon={ChevronDown} size="sm" />
        </Button>
        <Button variant="icon" aria-label={`Remove ${block.text}`} onClick={onRemove}>
          <Icon icon={Trash2} size="sm" />
        </Button>
      </div>
      {block.kind !== 'field' ? null : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Stores in">
              {(control) => (
                <Select
                  {...control}
                  value={block.propertyKey ?? ''}
                  onChange={(event) => {
                    const propertyKey = event.target.value || null;
                    const textBacked =
                      schema.find((property) => property.key === propertyKey)?.type === 'text';
                    onChange({
                      ...block,
                      propertyKey,
                      identityRole: textBacked ? block.identityRole : null,
                    });
                  }}
                >
                  {/* Computed properties are left out: a form writes children, and nothing writes
                      a computed value. Offering one would build a question with no control and no
                      way to answer it. */}
                  {schema
                    .filter((property) => !isComputedType(property.type))
                    .map((property) => (
                      <option key={property.key} value={property.key}>
                        {property.label}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label="Respondent identity">
              {(control) => (
                <Select
                  {...control}
                  disabled={!identityEligible}
                  value={block.identityRole ?? ''}
                  onChange={(event) => {
                    onChange({ ...block, identityRole: event.target.value || null });
                  }}
                >
                  <option value="">Not identity</option>
                  <option value="name">Name</option>
                  <option value="email">Email</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Help text">
            {(control) => (
              <textarea
                rows={3}
                {...control}
                value={block.help ?? ''}
                onChange={(event) => {
                  onChange({ ...block, help: event.target.value || null });
                }}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={block.required}
              onChange={(event) => {
                onChange({ ...block, required: event.target.checked });
              }}
            />
            Required
          </label>
          {earlier.length === 0 ? null : (
            <div className="flex flex-col gap-2 border-t border-divider p-3">
              <Text variant="note" tone="muted">
                Show only when all of these are true
              </Text>
              {block.visibleWhen.map((condition, conditionIndex) => (
                <div
                  key={`${condition.fieldBlockId}-${String(conditionIndex)}`}
                  className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
                >
                  <Field label="Field">
                    {(control) => (
                      <Select
                        {...control}
                        value={condition.fieldBlockId}
                        onChange={(event) => {
                          onChange({
                            ...block,
                            visibleWhen: block.visibleWhen.map((entry, index) =>
                              index === conditionIndex
                                ? { ...entry, fieldBlockId: event.target.value }
                                : entry,
                            ),
                          });
                        }}
                      >
                        {earlier.map((field) => (
                          <option key={field.id} value={field.id}>
                            {field.text}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Rule">
                    {(control) => (
                      <Select
                        {...control}
                        value={condition.operator}
                        onChange={(event) => {
                          onChange({
                            ...block,
                            visibleWhen: block.visibleWhen.map((entry, index) =>
                              index === conditionIndex
                                ? { ...entry, operator: event.target.value }
                                : entry,
                            ),
                          });
                        }}
                      >
                        <option value="equals">Equals</option>
                        <option value="not_equals">Does not equal</option>
                        <option value="contains">Contains</option>
                        <option value="checked">Is checked</option>
                        <option value="not_checked">Is not checked</option>
                      </Select>
                    )}
                  </Field>
                  <Field label="Value">
                    {(control) => (
                      <Input
                        {...control}
                        disabled={
                          condition.operator === 'checked' || condition.operator === 'not_checked'
                        }
                        value={condition.value ?? ''}
                        onChange={(event) => {
                          onChange({
                            ...block,
                            visibleWhen: block.visibleWhen.map((entry, index) =>
                              index === conditionIndex
                                ? { ...entry, value: event.target.value }
                                : entry,
                            ),
                          });
                        }}
                      />
                    )}
                  </Field>
                  <Button
                    variant="icon"
                    aria-label="Remove condition"
                    onClick={() => {
                      onChange({
                        ...block,
                        visibleWhen: block.visibleWhen.filter(
                          (_, index) => index !== conditionIndex,
                        ),
                      });
                    }}
                  >
                    <Icon icon={Trash2} size="sm" />
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                className="self-start"
                onClick={() => {
                  onChange({
                    ...block,
                    visibleWhen: [
                      ...block.visibleWhen,
                      { fieldBlockId: earlier[0]?.id ?? '', operator: 'equals', value: '' },
                    ],
                  });
                }}
              >
                <Icon icon={Plus} size="sm" /> Add condition
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
