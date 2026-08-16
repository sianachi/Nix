import { Button, Field, Input, Select, Text } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { Icon } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useAuth } from '../../auth/auth-provider';
import type {
  FormBlock,
  FormCondition,
  InteractiveFormDefinition,
  PropertyDefinition,
} from '../core/container-model';

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

  function updatePage(
    index: number,
    change: Partial<InteractiveFormDefinition['pages'][number]>,
  ): void {
    onChange({
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
      {previewing ? (
        <aside
          aria-label="Form preview"
          className="flex flex-col gap-3 border border-divider bg-background p-4"
        >
          {form.pages.map((page, index) => (
            <div key={page.id} className="flex flex-col gap-1">
              <Text variant="caption" tone="muted">
                Page {String(index + 1)}
              </Text>
              <Text variant="h4" as="h4">
                {page.title}
              </Text>
              {page.blocks.map((block) => (
                <Text
                  key={block.id}
                  {...(block.kind === 'paragraph' ? { tone: 'muted' as const } : {})}
                >
                  {block.kind === 'field' && block.required ? `${block.text} *` : block.text}
                </Text>
              ))}
            </div>
          ))}
        </aside>
      ) : null}

      {form.pages.map((page, pageIndex) => (
        <div key={page.id} className="flex flex-col gap-2 border border-divider p-3">
          <div className="flex items-end gap-2">
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
                    onChange({ ...form, pages: move(form.pages, pageIndex, -1) });
                  }}
                >
                  <Icon icon={ChevronUp} size="sm" />
                </Button>
                <Button
                  variant="icon"
                  disabled={pageIndex === form.pages.length - 1}
                  aria-label={`Move ${page.title} down`}
                  onClick={() => {
                    onChange({ ...form, pages: move(form.pages, pageIndex, 1) });
                  }}
                >
                  <Icon icon={ChevronDown} size="sm" />
                </Button>
                <Button
                  variant="icon"
                  aria-label={`Remove ${page.title}`}
                  onClick={() => {
                    onChange({
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
              <Input
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
          onChange({
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

      <div className="grid grid-cols-2 gap-2">
        <Field label="Response title">
          {(control) => (
            <Select
              {...control}
              value={form.titleMode === 'field' ? (form.titleFieldBlockId ?? '') : ''}
              onChange={(event) => {
                onChange({
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
                onChange({ ...form, confirmationTitle: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Confirmation message">
        {(control) => (
          <Input
            {...control}
            value={form.confirmationMessage}
            onChange={(event) => {
              onChange({ ...form, confirmationMessage: event.target.value });
            }}
          />
        )}
      </Field>
      {showPublishing ? <PublishingControls itemId={itemId} viewId={viewId} /> : null}
    </section>
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
          className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"
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
  const { getAccessToken } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    if (itemId === null) return;
    const controller = new AbortController();
    void getAccessToken().then(async (token) => {
      const response = await fetch(
        `/api/v1/items/${itemId}/views/${encodeURIComponent(viewId)}/public-link`,
        {
          signal: controller.signal,
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        },
      ).catch(() => null);
      if (response?.ok !== true || controller.signal.aborted) return;
      const result = (await response.json()) as { published: boolean; url: string | null };
      setPublished(result.published);
      setUrl(result.url);
    });
    return () => {
      controller.abort();
    };
  }, [getAccessToken, itemId, viewId]);

  async function change(method: 'PUT' | 'DELETE'): Promise<void> {
    if (itemId === null) return;
    setWorking(true);
    setOutcome(null);
    const token = await getAccessToken();
    const response = await fetch(
      `/api/v1/items/${itemId}/views/${encodeURIComponent(viewId)}/public-link`,
      {
        method,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      },
    ).catch(() => null);
    setWorking(false);
    if (response?.ok !== true) {
      setOutcome('The public link could not be changed. Save this view and try again.');
      return;
    }
    const result = (await response.json()) as { published: boolean; url: string | null };
    setPublished(result.published);
    setUrl(result.url);
    setOutcome(
      result.published ? 'A new public link is ready.' : 'The public link has been revoked.',
    );
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
          Status: {published ? 'Published' : 'Not published'}
        </Text>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={working || itemId === null}
          onClick={() => {
            void change('PUT');
          }}
        >
          {working ? 'Working…' : 'Publish form'}
        </Button>
        <Button
          variant="secondary"
          disabled={working || itemId === null}
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
      <div className="flex items-end gap-2">
        <Field
          label={
            block.kind === 'field' ? 'Question' : block.kind === 'heading' ? 'Heading' : 'Text'
          }
          className="flex-1"
        >
          {(control) => (
            <Input
              {...control}
              value={block.text}
              onChange={(event) => {
                onChange({ ...block, text: event.target.value });
              }}
            />
          )}
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
          <div className="grid grid-cols-2 gap-2">
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
                  {schema.map((property) => (
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
              <Input
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
                  className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"
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
