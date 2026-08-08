import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { type ReactNode } from 'react';

import { useSelectedItem } from '../routing/selected-item';
import { proseClasses } from './prose';
import { useReference } from './reference-resolution';

/**
 * How a reference is drawn once the server has been asked about it.
 *
 * The four states of {@link useReference}, and each one is a different sentence:
 *
 * - **resolved** - the item's title as it is now, and a control that opens it. Not the stored
 *   label, so renaming the target is reflected everywhere it is mentioned.
 * - **loading** - the stored label, which is exactly what it was cached for.
 * - **refused** - a stub. Never the label: it is a copy of a title this reader has no entitlement
 *   to, and showing it as a fallback is a leak wearing a fallback's clothes.
 * - **unavailable** - the stored label again, and a tooltip saying it could not be checked. A
 *   failed lookup is a fact about the network; drawing it as a refusal would tell the reader
 *   something about their own permissions that nobody established.
 *
 * A person mentioned with `@` gets the label and no navigation: a principal is not somewhere the
 * item panes can open, and there is no people surface for it to lead to yet.
 */
export function ReferenceView(props: ReactNodeViewProps): ReactNode {
  const attrs = props.node.attrs as {
    readonly kind?: unknown;
    readonly targetId?: unknown;
    readonly label?: unknown;
  };

  const kind = attrs.kind === 'principal' ? 'principal' : 'item';
  const targetId = typeof attrs.targetId === 'string' ? attrs.targetId : null;
  const label = typeof attrs.label === 'string' && attrs.label.length > 0 ? attrs.label : 'Untitled';

  // Only items are resolved. A principal reference has nothing to resolve against yet, and asking
  // the item endpoint about a principal identifier would answer "refused" - which would draw every
  // mention of a colleague as something the reader is not allowed to see.
  const state = useReference(kind === 'item' ? targetId : null);
  const { select } = useSelectedItem();

  if (kind === 'item' && state.status === 'refused') {
    return (
      <NodeViewWrapper as="span" className="inline">
        <span
          className="text-muted italic"
          // Said in words as well as in style, because "unavailable" and "untitled" look alike at
          // a glance and only one of them means the reader is missing something.
          title="This link points somewhere you do not have access to."
        >
          Unavailable
        </span>
      </NodeViewWrapper>
    );
  }

  if (kind === 'item' && state.status === 'resolved' && targetId !== null) {
    return (
      <NodeViewWrapper as="span" className="inline">
        <button
          type="button"
          className={proseClasses.reference}
          onClick={() => {
            select(targetId);
          }}
        >
          {state.title ?? 'Untitled'}
        </button>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        className={proseClasses.reference}
        title={
          state.status === 'unavailable'
            ? 'This link could not be checked just now. The name shown is the one it had when the link was made.'
            : undefined
        }
      >
        {label}
      </span>
    </NodeViewWrapper>
  );
}
