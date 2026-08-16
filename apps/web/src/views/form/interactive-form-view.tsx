import { Button, Text } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';

import { PropertyInput, isKnownPropertyType } from '../../properties/property-input';
import type {
  FormBlock,
  FormCondition,
  InteractiveFormDefinition,
  PropertyValue,
} from '../core/container-model';
import { resolveLoadState } from '../core/view-chrome';
import type { ViewRendererProps } from '../core/view-kinds';

type FormPage = InteractiveFormDefinition['pages'][number];

function conditionMatches(
  condition: FormCondition,
  answers: Record<string, PropertyValue>,
): boolean {
  const answer = answers[condition.fieldBlockId];
  const expected = condition.value ?? '';
  if (condition.operator === 'checked') return answer === true;
  if (condition.operator === 'not_checked') return answer !== true;
  if (condition.operator === 'not_equals') return String(answer ?? '') !== expected;
  if (condition.operator === 'contains') {
    return Array.isArray(answer)
      ? answer.includes(expected)
      : String(answer ?? '').includes(expected);
  }
  return String(answer ?? '') === expected;
}

function isVisible(
  conditions: readonly FormCondition[],
  answers: Record<string, PropertyValue>,
): boolean {
  return conditions.every((condition) => conditionMatches(condition, answers));
}

function isEmpty(value: PropertyValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function resolveFlow(
  pages: readonly FormPage[],
  answers: Readonly<Record<string, PropertyValue>>,
): { pages: FormPage[]; answers: Record<string, PropertyValue> } {
  const effective: Record<string, PropertyValue> = {};
  const shown: FormPage[] = [];
  for (const page of pages) {
    if (!isVisible(page.visibleWhen, effective)) continue;
    const blocks = page.blocks.filter((block) => {
      if (!isVisible(block.visibleWhen, effective)) return false;
      if (block.kind === 'field' && answers[block.id] !== undefined) {
        effective[block.id] = answers[block.id] ?? null;
      }
      return true;
    });
    shown.push({ ...page, blocks });
  }
  return { pages: shown, answers: effective };
}

export function InteractiveFormView({ container, view }: ViewRendererProps): ReactNode {
  const form = view.interactiveForm;
  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, PropertyValue>>({});
  const answersRef = useRef(answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const definitions = new Map(
    (container.schema?.properties ?? []).map((property) => [property.key, property]),
  );

  const loadState = resolveLoadState(container, 'this interactive form');
  if (loadState !== null) return loadState;
  if (form === null || form === undefined || form.pages.length === 0) {
    return (
      <Text tone="muted">
        Configure this interactive form in Views before collecting responses.
      </Text>
    );
  }
  const definition = form;

  const visiblePages = resolveFlow(definition.pages, answers).pages;
  const page = visiblePages[Math.min(pageIndex, Math.max(0, visiblePages.length - 1))];

  if (complete) {
    return (
      <section
        aria-live="polite"
        className="flex max-w-xl flex-col gap-2 border border-divider p-3"
      >
        <Text variant="h3" as="h2">
          {definition.confirmationTitle}
        </Text>
        <Text tone="muted">{definition.confirmationMessage}</Text>
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            setAnswers({});
            answersRef.current = {};
            setPageIndex(0);
            setComplete(false);
          }}
        >
          Add another response
        </Button>
      </section>
    );
  }

  if (page === undefined) return <Text tone="muted">No page currently matches these answers.</Text>;
  const visibleBlocks = page.blocks.filter((block) => isVisible(block.visibleWhen, answers));
  const last = pageIndex >= visiblePages.length - 1;

  function validate(blocks: readonly FormBlock[]): boolean {
    const currentAnswers = answersRef.current;
    const required = Object.fromEntries(
      blocks
        .filter(
          (candidate) =>
            candidate.kind === 'field' &&
            candidate.required &&
            isEmpty(currentAnswers[candidate.id]),
        )
        .map((candidate) => [candidate.id, 'This answer is required.']),
    );
    setErrors(required);
    if (Object.keys(required).length === 0) return true;
    setOutcome('Some required answers are still empty.');
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '[data-form-error="true"] input, [data-form-error="true"] select',
        )
        ?.focus(),
    );
    return false;
  }

  async function finish(): Promise<void> {
    const currentAnswers = answersRef.current;
    const flow = resolveFlow(definition.pages, currentAnswers);
    const shownBlocks = flow.pages.flatMap((entry) => entry.blocks);
    if (!validate(shownBlocks)) return;

    const properties: Record<string, PropertyValue> = {};
    for (const block of shownBlocks) {
      if (
        block.kind === 'field' &&
        block.propertyKey !== null &&
        flow.answers[block.id] !== undefined
      ) {
        properties[block.propertyKey] = flow.answers[block.id] ?? null;
      }
    }
    const titleBlock = visiblePages
      .flatMap((entry) => entry.blocks)
      .find((block) => block.id === definition.titleFieldBlockId);
    const title =
      definition.titleMode === 'field' && titleBlock !== undefined
        ? String(flow.answers[titleBlock.id] ?? '').trim()
        : `${view.name} — ${new Date().toISOString()}`;

    setSending(true);
    setOutcome(null);
    const refusal = await container.create(title || `${view.name} response`, properties);
    setSending(false);
    if (refusal !== null) {
      setOutcome(refusal);
      return;
    }
    setComplete(true);
  }

  return (
    <form
      aria-label={view.name}
      className="flex max-w-xl flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (last) void finish();
        else if (validate(visibleBlocks)) {
          setOutcome(null);
          setPageIndex((current) => current + 1);
        }
      }}
    >
      <header className="flex flex-col gap-1 border-b border-divider pb-3">
        <Text variant="caption" tone="muted">
          Page {String(pageIndex + 1)} of {String(visiblePages.length)}
        </Text>
        <Text variant="h3" as="h2">
          {page.title}
        </Text>
        {page.description === null ? null : <Text tone="muted">{page.description}</Text>}
      </header>

      {visibleBlocks.map((block) => (
        <InteractiveBlock
          key={block.id}
          block={block}
          definition={block.propertyKey === null ? undefined : definitions.get(block.propertyKey)}
          value={answers[block.id]}
          error={errors[block.id] ?? null}
          onValue={(value) => {
            const next = { ...answersRef.current, [block.id]: value };
            answersRef.current = next;
            setAnswers(next);
            setErrors((current) =>
              Object.fromEntries(Object.entries(current).filter(([id]) => id !== block.id)),
            );
          }}
        />
      ))}

      {outcome === null ? null : <Text role="alert">{outcome}</Text>}
      <div className="flex items-center gap-2">
        {pageIndex === 0 ? null : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setPageIndex((current) => current - 1);
            }}
          >
            Back
          </Button>
        )}
        <Button type="submit" aria-disabled={sending}>
          {sending ? 'Sending…' : last ? 'Send response' : 'Continue'}
        </Button>
      </div>
    </form>
  );
}

function InteractiveBlock({
  block,
  definition,
  value,
  error,
  onValue,
}: {
  readonly block: FormBlock;
  readonly definition:
    | {
        readonly key: string;
        readonly label: string;
        readonly type: string;
        readonly options: string[];
        readonly required: boolean;
      }
    | undefined;
  readonly value: PropertyValue | undefined;
  readonly error: string | null;
  readonly onValue: (value: PropertyValue) => void;
}): ReactNode {
  if (block.kind === 'heading')
    return (
      <Text variant="h4" as="h3">
        {block.text}
      </Text>
    );
  if (block.kind === 'paragraph') return <Text tone="muted">{block.text}</Text>;
  if (definition === undefined || !isKnownPropertyType(definition.type)) {
    return <Text role="alert">“{block.text}” refers to a field that is no longer available.</Text>;
  }
  return (
    <div
      className="flex flex-col gap-1"
      data-form-error={error === null ? undefined : 'true'}
      tabIndex={error === null ? undefined : -1}
    >
      <Text variant="h4" as="h3">
        {block.text}
        {block.required ? ' *' : ''}
      </Text>
      {block.help === null ? null : (
        <Text variant="note" tone="muted">
          {block.help}
        </Text>
      )}
      <PropertyInput
        item={{ title: '', properties: value === undefined ? {} : { [definition.key]: value } }}
        property={{ ...definition, label: block.text }}
        error={error}
        onCommit={onValue}
      />
    </div>
  );
}
