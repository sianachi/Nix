import { Button, Field, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PropertyInput, isKnownPropertyType } from '../../properties/property-input';
import { resolveConfiguredColumns } from '../core/columns';
import { isComputedType } from '../core/property-types';
import {
  type EffectiveSchema,
  type PropertyDefinition,
  type PropertyValue,
  type View,
} from '../core/container-model';
import type { ContainerData } from '../core/use-container';
import { resolveLoadState } from '../core/view-chrome';
import type { ViewRendererProps } from '../core/view-kinds';

/**
 * The form view: the container's schema as fields, and every submission a new child.
 *
 * The intake shape - a daily tracker whose entries are rows, an inventory log fed line by line.
 * Nothing here is new machinery: the fields are `PropertyInput`, the same control the property
 * panel and the list's cells draw, and the submit is the ordinary create every view offers. What
 * the kind adds is the arrangement - entry first, entries elsewhere - switchable beside the list
 * the submissions land in. ADR-0040 records the two decisions this kind rests on: a write surface
 * offered on the view axis, and required-ness as this form's own promise.
 *
 * **This view does not render children, so it takes only `resolveLoadState` from the chrome.**
 * The chrome's empty, filtered and truncated branches are statements about children this view
 * does not draw - an empty container is exactly what a fresh tracker looks like, and the form is
 * how it stops being empty. Loading and error still hold, from the shared module so they cannot
 * drift.
 *
 * **Required-ness is enforced here, and only here.** On create the server deliberately owes no
 * required value - `PropertyValidator.ValidateSupplied`'s own remark: a required property is a
 * statement about a finished item, not about a first keystroke - and ADR-0016 records the
 * consequence that nothing tells anyone an item is incomplete. This form is the first surface
 * that partially closes that gap, as its own submit-time promise rather than a relay of a server
 * rule; the other create paths (the list's quick add, a board's column create) still owe nothing.
 */

export function FormView(props: ViewRendererProps): ReactNode {
  const { container, view } = props;

  // Once the container has been ready, a reload must not tear the form down: `create` reloads the
  // children on success, which flips `status` through 'loading' - and unmounting `EntryForm` then
  // would destroy the draft state mid-submit, so the success sentence, the cleared fields and the
  // returned focus would all act on a component that no longer exists. The loading panel is for
  // the first arrival only; after that, the form's own "Adding" line is the latency signal.
  const [hasBeenReady, setHasBeenReady] = useState(false);
  if (!hasBeenReady && container.status === 'ready') {
    setHasBeenReady(true);
  }

  const loadState = resolveLoadState(container, 'this form');
  if (loadState !== null && !(hasBeenReady && container.status === 'loading')) {
    return loadState;
  }

  return <EntryForm container={container} view={view} />;
}

/** How the fields resolve: the shared column rule, with this view's answer for the gaps. */
function resolveFields(
  view: View,
  schema: EffectiveSchema | null,
): { offered: readonly PropertyDefinition[]; unavailable: readonly string[] } {
  const { keys, definitions } = resolveConfiguredColumns(view, schema);

  const offered: PropertyDefinition[] = [];
  const unavailable: string[] = [];

  for (const key of keys) {
    const definition = definitions.get(key);

    // A configured field the schema does not describe, or whose type this build has no control
    // for, cannot be offered as an input - there is nothing to type into. Named rather than
    // silently dropped, so a renamed property is a stated gap instead of a field that vanished.
    if (definition === undefined || !isKnownPropertyType(definition.type)) {
      unavailable.push(key);
      continue;
    }

    // A computed property is skipped rather than named as unavailable, and the difference is the
    // sentence a person reads. "Unavailable" is for a field that was meant to be an input and is
    // not one - a renamed property, a type this build cannot draw. A formula is working exactly as
    // declared and simply is not an input: a form writes children, and nothing writes a computed
    // value. Listing it would report a fault that does not exist.
    if (isComputedType(definition.type)) {
      continue;
    }

    offered.push(definition);
  }

  return { offered, unavailable };
}

function EntryForm({
  container,
  view,
}: {
  readonly container: ContainerData;
  readonly view: View;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [bag, setBag] = useState<Record<string, PropertyValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** The one sentence about the last submit: saved, blocked by required fields, or refused. */
  const [outcome, setOutcome] = useState<{
    kind: 'saved' | 'blocked' | 'refused';
    text: string;
  } | null>(null);

  const [sending, setSending] = useState(false);

  /**
   * Counts successful submissions, and does two jobs: as a `key` on the fields it remounts every
   * control clean after a success - a draft a field held but never committed (an unparseable
   * number, a half-typed date) would otherwise survive under the "added" message, looking stored
   * when it was not - and it leaves the required check honest about what was actually sent.
   */
  const [submissions, setSubmissions] = useState(0);

  /** Bumped on a blocked submit, so the focus effect runs again even when the text is identical. */
  const [blockedAt, setBlockedAt] = useState(0);

  const titleRef = useRef<HTMLInputElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);

  const { offered, unavailable } = resolveFields(view, container.schema);

  // A blocked submit whose sentence has not changed re-renders nothing, so a live region says
  // nothing the second time - focus is the feedback that works on every attempt, and it also
  // answers "which field" in a way the summary sentence deliberately does not.
  useEffect(() => {
    if (blockedAt === 0) {
      return;
    }
    const invalid = fieldsRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    invalid?.focus();
  }, [blockedAt]);

  // Focus returns to the title after the fields have remounted, not before: the success path
  // remounts them (the `submissions` key) to shed uncommitted drafts, so a focus call made inside
  // submit() would land on an input that is about to be unmounted and follow it to the body.
  useEffect(() => {
    if (submissions > 0) {
      titleRef.current?.focus();
    }
  }, [submissions]);

  function setValue(key: string, value: PropertyValue): void {
    setBag((current) => {
      if (value === null) {
        // Absent, not null: the create sends this bag verbatim, and an explicit null is a clear
        // instruction the merge contract acts on - meaningless for an item that does not exist.
        return Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key));
      }
      return { ...current, [key]: value };
    });
    setFieldErrors((current) =>
      key in current
        ? Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key))
        : current,
    );
  }

  async function submit(): Promise<void> {
    if (sending) {
      return;
    }

    // The form's own required check - see the header for whose rule this is and is not.
    const blockers: Record<string, string> = {};

    if (title.trim().length === 0) {
      blockers.title = 'An entry needs a title.';
    }

    for (const definition of offered) {
      // A checkbox is exempt from the check because unanswered and unchecked are indistinguishable
      // in the control; the bag is completed below instead, so what is sent still carries a value.
      if (!definition.required || definition.type === 'checkbox') {
        continue;
      }
      if (bag[definition.key] === undefined) {
        blockers[definition.key] = 'Required before the entry is added.';
      }
    }

    if (Object.keys(blockers).length > 0) {
      setFieldErrors(blockers);
      const count = Object.keys(blockers).length;
      setOutcome({
        kind: 'blocked',
        text:
          count === 1
            ? 'The entry was not added: one field still needs a value.'
            : `The entry was not added: ${String(count)} fields still need values.`,
      });
      setBlockedAt((current) => current + 1);
      return;
    }

    // An untouched checkbox never commits, so its key is absent - but unchecked is a value, not
    // an absence ("true or false, never null" is the control's own contract), so the sent bag
    // says `false` explicitly rather than shipping the incomplete item this form promises not to.
    const sent: Record<string, PropertyValue> = { ...bag };
    for (const definition of offered) {
      if (definition.type === 'checkbox' && sent[definition.key] === undefined) {
        sent[definition.key] = false;
      }
    }

    setFieldErrors({});
    setOutcome(null);
    setSending(true);

    try {
      const refusal = await container.create(title.trim(), sent);

      if (refusal !== null) {
        setOutcome({ kind: 'refused', text: refusal });
        return;
      }

      // A clean slate for the next entry, with focus back at the top (via the effect above): the
      // whole point of the shape is the second submission.
      setTitle('');
      setBag({});
      setSubmissions((current) => current + 1);
      setOutcome({ kind: 'saved', text: 'Entry added.' });
    } catch {
      setOutcome({
        kind: 'refused',
        text: 'The entry could not be sent. Check the connection and try again.',
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      aria-label={view.name}
      className="flex max-w-xl flex-col gap-4"
      // The form owns its validation - the per-field sentences below - and the design language
      // never shows browser default bubbles. Without this the controls' own `required` attributes
      // would block submission before the handler could say anything.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div ref={fieldsRef} key={submissions} className="flex flex-col gap-4">
        <Field label="Title" required error={fieldErrors.title ?? null}>
          {(control) => (
            <Input
              {...control}
              ref={titleRef}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                // Cleared on the keystroke that answers it, the same trigger `setValue` uses for
                // every other field - one rule, not two.
                setFieldErrors((current) =>
                  'title' in current
                    ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'title'))
                    : current,
                );
              }}
            />
          )}
        </Field>

        {offered.map((definition) => (
          <PropertyInput
            key={definition.key}
            item={{ title, properties: bag }}
            property={definition}
            density="panel"
            error={fieldErrors[definition.key] ?? null}
            onCommit={(value) => {
              setValue(definition.key, value);
            }}
          />
        ))}
      </div>

      {offered.length === 0 ? (
        <Text tone="muted">
          This one has no properties yet, so entries carry only a title. Add properties under
          Properties to build the form out.
        </Text>
      ) : null}

      {unavailable.length > 0 ? (
        <Text variant="note" tone="muted">
          {unavailable.length === 1
            ? `The configured field "${unavailable[0] ?? ''}" cannot be offered as an input here.`
            : `Some configured fields cannot be offered as inputs here: ${unavailable.join(', ')}.`}
        </Text>
      ) : null}

      {/* aria-disabled rather than disabled: disabling the focused element throws focus to the
          body, and each outcome decides where focus goes instead. The double-submit guard is the
          early return in submit(). */}
      <div>
        <Button type="submit" aria-disabled={sending}>
          Add entry
        </Button>
      </div>

      {/* Two always-mounted regions, so an announcement fires the moment a sentence appears. The
          alert interrupts and is reserved for a refusal; saved, blocked and in-flight inform via
          status - the blocked summary informs rather than interrupts because focus (above) is
          what carries the interruption to the field itself. Not one region with a switched role,
          which assistive technology would not re-announce. */}
      <div>
        <Text variant="note" role="alert" as="p">
          {outcome?.kind === 'refused' ? outcome.text : null}
        </Text>
        <Text variant="note" role="status" as="p">
          {sending ? 'Adding the entry.' : outcome?.kind === 'refused' ? null : outcome?.text}
        </Text>
      </div>
    </form>
  );
}
