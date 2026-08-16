import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';

import { PropertyInput, isKnownPropertyType } from '../properties/property-input';
import { type PropertyValue } from '../views/core/container-model';

const PublicConditionSchema = z.object({
  fieldBlockId: z.string(),
  operator: z.string(),
  value: z.string().nullable(),
});

const PublicBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  text: z.string(),
  help: z.string().nullable(),
  required: z.boolean(),
  identityRole: z.string().nullable(),
  visibleWhen: z.array(PublicConditionSchema),
});

const PublicPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  visibleWhen: z.array(PublicConditionSchema),
  blocks: z.array(PublicBlockSchema),
});

const PublicFieldSchema = z.object({
  blockId: z.string(),
  type: z.string(),
  options: z.array(z.string()),
});

const PublicFormSchema = z.object({
  name: z.string(),
  form: z.object({
    pages: z.array(PublicPageSchema),
    confirmationTitle: z.string(),
    confirmationMessage: z.string(),
  }),
  fields: z.array(PublicFieldSchema),
});

type PublicForm = z.infer<typeof PublicFormSchema>;

function matches(
  condition: z.infer<typeof PublicConditionSchema>,
  answers: Readonly<Record<string, PropertyValue>>,
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

function visible(
  block: { readonly visibleWhen: readonly z.infer<typeof PublicConditionSchema>[] },
  answers: Readonly<Record<string, PropertyValue>>,
): boolean {
  return block.visibleWhen.every((condition) => matches(condition, answers));
}

function empty(value: PropertyValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function resolveFlow(
  pages: readonly z.infer<typeof PublicPageSchema>[],
  answers: Readonly<Record<string, PropertyValue>>,
): { pages: z.infer<typeof PublicPageSchema>[]; answers: Record<string, PropertyValue> } {
  const effective: Record<string, PropertyValue> = {};
  const shown: z.infer<typeof PublicPageSchema>[] = [];
  for (const page of pages) {
    if (!visible(page, effective)) continue;
    const blocks = page.blocks.filter((block) => {
      if (!visible(block, effective)) return false;
      if (block.kind === 'field' && answers[block.id] !== undefined) {
        effective[block.id] = answers[block.id] ?? null;
      }
      return true;
    });
    shown.push({ ...page, blocks });
  }
  return { pages: shown, answers: effective };
}

export function PublicFormPage(): ReactNode {
  const { token = '' } = useParams();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [failed, setFailed] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, PropertyValue>>({});
  const answersRef = useRef(answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    let current = true;
    void fetch(`/public/v1/forms/${encodeURIComponent(token)}`)
      .then(async (response) =>
        response.ok ? PublicFormSchema.safeParse(await response.json()) : null,
      )
      .then((result) => {
        if (!current) return;
        if (result?.success === true) setForm(result.data);
        else setFailed(true);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [token]);

  const fields = new Map((form?.fields ?? []).map((field) => [field.blockId, field]));

  if (failed) {
    return (
      <PublicFrame>
        <Text variant="h2" as="h1">
          This form is unavailable
        </Text>
        <Text tone="muted">The link may have expired or been revoked.</Text>
      </PublicFrame>
    );
  }
  if (form === null)
    return (
      <PublicFrame>
        <Text tone="muted">Loading form…</Text>
      </PublicFrame>
    );
  if (complete) {
    return (
      <PublicFrame>
        <Text variant="h2" as="h1">
          {form.form.confirmationTitle}
        </Text>
        <Text tone="muted">{form.form.confirmationMessage}</Text>
      </PublicFrame>
    );
  }

  const pages = resolveFlow(form.form.pages, answers).pages;
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  if (page === undefined)
    return (
      <PublicFrame>
        <Text tone="muted">No questions are available.</Text>
      </PublicFrame>
    );
  const blocks = page.blocks.filter((block) => visible(block, answers));
  const last = pageIndex >= pages.length - 1;

  function validate(candidates: readonly z.infer<typeof PublicBlockSchema>[]): boolean {
    const currentAnswers = answersRef.current;
    const next = Object.fromEntries(
      candidates
        .filter(
          (block) => block.kind === 'field' && block.required && empty(currentAnswers[block.id]),
        )
        .map((block) => [block.id, 'This answer is required.']),
    );
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(): Promise<void> {
    if (form === null) return;
    const currentAnswers = answersRef.current;
    const flow = resolveFlow(form.form.pages, currentAnswers);
    const shown = flow.pages.flatMap((candidate) => candidate.blocks);
    if (!validate(shown)) return;
    setSubmitting(true);
    const response = await fetch(`/public/v1/forms/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: flow.answers, website: '' }),
    }).catch(() => null);
    setSubmitting(false);
    if (response?.ok === true) setComplete(true);
    else setFailed(true);
  }

  return (
    <PublicFrame>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (last) void submit();
          else if (validate(blocks)) setPageIndex((current) => current + 1);
        }}
      >
        <header className="flex flex-col gap-2 border-b border-divider p-3">
          <Text variant="caption" tone="muted">
            {form.name} · Page {String(pageIndex + 1)} of {String(pages.length)}
          </Text>
          <Text variant="h2" as="h1">
            {page.title}
          </Text>
          {page.description === null ? null : <Text tone="muted">{page.description}</Text>}
        </header>
        {blocks.map((block) => {
          if (block.kind === 'heading')
            return (
              <Text key={block.id} variant="h3" as="h2">
                {block.text}
              </Text>
            );
          if (block.kind === 'paragraph')
            return (
              <Text key={block.id} tone="muted">
                {block.text}
              </Text>
            );
          const field = fields.get(block.id);
          if (field === undefined || !isKnownPropertyType(field.type)) return null;
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
                property={{
                  key: block.id,
                  label: block.text,
                  type: field.type,
                  options: field.options,
                  required: block.required,
                }}
                error={errors[block.id] ?? null}
                onCommit={(value) => {
                  const next = { ...answersRef.current, [block.id]: value };
                  answersRef.current = next;
                  setAnswers(next);
                }}
              />
            </div>
          );
        })}
        {/* Kept off-screen from people, present for unsophisticated form bots. */}
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          className="hidden"
          aria-hidden="true"
        />
        <div className="flex gap-2">
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
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Sending…' : last ? 'Send response' : 'Continue'}
          </Button>
        </div>
      </form>
    </PublicFrame>
  );
}

function PublicFrame({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-5 py-12">
      <section className="border border-divider bg-surface p-6 shadow-sm sm:p-10">
        {children}
      </section>
    </main>
  );
}
