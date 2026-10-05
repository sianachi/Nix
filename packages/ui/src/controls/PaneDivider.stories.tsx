import { Fragment, useId, useRef, useState, type ReactNode } from 'react';
import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import { Text } from '../primitives/Text';
import { PaneDivider, type PaneDividerOrientation } from './PaneDivider';

/**
 * The handle between two panes: the ARIA window-splitter pattern, keyboard first.
 *
 * Arrow keys move it a step (Shift for a coarse one), Home and End go to the bounds, and Enter
 * toggles between an even split and wherever it was before - the one position a drag cannot aim
 * at. The value it announces is the share of the pane *before* the handle, and `aria-controls`
 * points at that pane so the number has a subject the platform can follow.
 *
 * **There is no Dragging story**, and not for want of a state worth showing: the pressed step
 * (`data-dragging`) only lights up during a live pointer capture, which needs pointer scripting a
 * story cannot express. The rest state, hover, focus and both bounds are all here; the drag
 * itself belongs to the owed real-browser pass.
 */
const meta = {
  title: 'Controls/PaneDivider',
  component: PaneDivider,
  // Controlled by design, so the default args stand in for a caller that owns the shares. Every
  // story below renders its own state, because that is how it is actually used.
  args: {
    orientation: 'vertical',
    before: 50,
    after: 50,
    beforeName: 'Spec',
    afterName: 'Notes',
    controls: 'pane-spec',
    onPreview: () => undefined,
    onCommit: () => undefined,
  },
} satisfies Meta<typeof PaneDivider>;

export default meta;

type Story = StoryObj<typeof meta>;

/** One pane's box, with the id its handle points `aria-controls` at. */
function Pane({
  id,
  name,
  share,
  paneRef,
}: {
  readonly id: string;
  readonly name: string;
  readonly share: number;
  readonly paneRef: React.RefObject<HTMLDivElement | null>;
}): ReactNode {
  return (
    <div
      ref={paneRef}
      id={id}
      style={{ flexGrow: share, flexBasis: 0 }} // design-token-exempt: a pane's share is a runtime ratio somebody dragged, not a step on any scale
      className="min-h-0 min-w-0 overflow-hidden rounded-sm bg-surface p-3"
    >
      <Text variant="note" tone="muted">
        {name}
      </Text>
    </div>
  );
}

/**
 * A caller that owns the shares, with the divider between the two boxes it resizes.
 *
 * A real component rather than a `render` callback holding hooks: a callback is not a component,
 * so React's rules do not apply to it and the hooks would be a bug that happens to work.
 *
 * The preview path writes the grow factors straight to the elements, which is the component's
 * documented contract: a state update per pointer event would re-render both panes for the whole
 * length of a drag. React writes the same numbers again when the settled value lands in state.
 */
function Example({
  orientation,
  initial,
}: {
  readonly orientation: PaneDividerOrientation;
  readonly initial: readonly [number, number];
}): ReactNode {
  const [shares, setShares] = useState(initial);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const firstId = useId();

  function preview(before: number, after: number): void {
    firstRef.current?.style.setProperty('flex-grow', String(before));
    secondRef.current?.style.setProperty('flex-grow', String(after));
  }

  return (
    <div className={orientation === 'vertical' ? 'flex h-64' : 'flex h-96 flex-col'}>
      <Pane id={firstId} name="Spec" share={shares[0]} paneRef={firstRef} />

      <PaneDivider
        orientation={orientation}
        before={shares[0]}
        after={shares[1]}
        beforeName="Spec"
        afterName="Notes"
        controls={firstId}
        onPreview={preview}
        onCommit={(before, after) => {
          setShares([before, after]);
        }}
      />

      <Pane id={`${firstId}-second`} name="Notes" share={shares[1]} paneRef={secondRef} />
    </div>
  );
}

/** Two panes side by side, separated by the vertical line the arrows move left and right. */
export const Vertical: Story = {
  render: () => <Example orientation="vertical" initial={[50, 50]} />,
};

/** Two panes stacked, separated by the horizontal line the arrows move up and down. */
export const Horizontal: Story = {
  render: () => <Example orientation="horizontal" initial={[50, 50]} />,
};

/**
 * The handle with the keyboard on it: the focus ring and the accent line, which is the only state
 * that says "this is a control" on a hairline at rest.
 *
 * Focused in a `play` rather than described in prose so the axe pass sweeps a *focused* handle -
 * a rest-state-only story would never exercise the indicator that has to clear 3:1.
 */
export const Focused: Story = {
  render: () => <Example orientation="vertical" initial={[50, 50]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole('separator', { name: 'Resize Spec and Notes' });

    await userEvent.tab();

    await expect(handle).toHaveFocus();
  },
};

/**
 * A pane squeezed to the 15% floor, where the drag and the arrow keys both stop: below about a
 * sixth of the pair a pane is narrower than its own header controls. Home returns here; End goes
 * to the opposite bound.
 */
export const AtTheMinimum: Story = {
  render: () => <Example orientation="vertical" initial={[15, 85]} />,
};

/** The other bound, where End lands: the pane after the handle is the one at the floor. */
export const AtTheMaximum: Story = {
  render: () => <Example orientation="vertical" initial={[85, 15]} />,
};

/**
 * Three panes and two handles, which is the arrangement the product actually reaches.
 *
 * Each handle trades between its own pair and names only those two, so the middle pane is spoken
 * about by both and owned by neither - the reason the value is a share of a *pair* rather than of
 * the whole group.
 */
function ThreePanes(): ReactNode {
  const [shares, setShares] = useState<readonly [number, number, number]>([34, 33, 33]);
  // A tuple rather than an array, so indexing one of the three is a ref and not "a ref or
  // nothing" - the arrangement's length is fixed by `names` below.
  const refs: readonly [
    React.RefObject<HTMLDivElement | null>,
    React.RefObject<HTMLDivElement | null>,
    React.RefObject<HTMLDivElement | null>,
  ] = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const groupId = useId();
  const names: readonly [string, string, string] = ['Spec', 'Notes', 'Tasks'];

  function paneId(index: number): string {
    return `${groupId}-${String(index)}`;
  }

  function commit(index: number, before: number, after: number): void {
    setShares((current) => {
      const next = [...current] as [number, number, number];
      next[index] = before;
      next[index + 1] = after;
      return next;
    });
  }

  return (
    <div className="flex h-64">
      {names.map((name, index) => (
        <Fragment key={name}>
          {index === 0 ? null : (
            <PaneDivider
              orientation="vertical"
              before={shares[index - 1] ?? 33}
              after={shares[index] ?? 33}
              beforeName={names[index - 1] ?? name}
              afterName={name}
              controls={paneId(index - 1)}
              onPreview={(before, after) => {
                refs[index - 1]?.current?.style.setProperty('flex-grow', String(before));
                refs[index]?.current?.style.setProperty('flex-grow', String(after));
              }}
              onCommit={(before, after) => {
                commit(index - 1, before, after);
              }}
            />
          )}

          <Pane
            id={paneId(index)}
            name={name}
            share={shares[index] ?? 33}
            paneRef={refs[index] ?? refs[0]}
          />
        </Fragment>
      ))}
    </div>
  );
}

export const ThreePanesTwoHandles: Story = {
  render: () => <ThreePanes />,
};
