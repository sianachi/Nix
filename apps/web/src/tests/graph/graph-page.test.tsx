import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { stubViewport } from '../stub-viewport';
import { App } from '../../app';

/**
 * The graph destination.
 *
 * Driven through the whole application rather than the view in isolation, because most of what
 * this page promises is only true in a router and against a real fetch: which states it moves
 * through, that opening a node changes the address the same way the tree does, and that the
 * truncation notice reaches a reader.
 *
 * **Every assertion here is on the accessible tree, not the drawing.** That is the point rather
 * than a limitation of jsdom: the `<svg>` is `aria-hidden`, so if a fact about the graph cannot be
 * found by role and name then a screen-reader user cannot find it either. A test that reached into
 * the SVG would be checking the half of the view that is decoration.
 *
 * The tree is `sr-only` - visually hidden, because on screen it would be a second copy of the
 * workspace stacked under a picture of it. Testing Library queries it exactly as before: `sr-only`
 * is a clipping rectangle, not `display: none`, so the node stays in the accessibility tree, which
 * is the whole point of choosing it over removal.
 */
beforeEach(() => {
  signedIn();
  stubViewport(true);
});

const ROOT = item({
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'Specifications',
  hasChildren: true,
});

const CHILD = item({
  id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  title: 'Retention policy',
  parentId: ROOT.id,
});

const OTHER = item({
  id: 'cccccccc-3333-4333-8333-cccccccccccc',
  title: 'Roadmap',
});

function graphTree(): HTMLElement {
  return screen.getByRole('tree', { name: /workspace graph/i });
}

describe('the graph destination', () => {
  it('names every readable item, so the graph is not only a picture', async () => {
    stubCoreApi({ items: [ROOT, CHILD, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const names = within(graphTree())
      .getAllByRole('treeitem')
      .map((row) => row.textContent);

    expect(names).toHaveLength(3);
    expect(names.join(' ')).toContain('Specifications');
    expect(names.join(' ')).toContain('Retention policy');
    expect(names.join(' ')).toContain('Roadmap');
  });

  /**
   * The reason the accessible tree exists at all. A drawing can show an arc between two discs; only
   * words can say which item points at which, and a count alone ("2 references") is the same shrug
   * an unnamed spinner is.
   */
  it('says what each item points at by name, which the drawing cannot', async () => {
    stubCoreApi({
      items: [ROOT, OTHER],
      graphLinks: [{ sourceId: ROOT.id, targetId: OTHER.id }],
    });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(
      within(graphTree()).getByRole('button', { name: /Specifications.*references.*Roadmap/i }),
    ).toBeInTheDocument();
  });

  it('says an item points at nothing rather than leaving it ambiguous', async () => {
    stubCoreApi({ items: [OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(
      within(graphTree()).getByRole('button', { name: /Roadmap.*no references/i }),
    ).toBeInTheDocument();
  });

  it('reports containment depth, so nesting survives without the drawing', async () => {
    stubCoreApi({ items: [ROOT, CHILD] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(graphTree()).getAllByRole('treeitem');
    const child = rows.find((row) => row.textContent.includes('Retention policy'));

    expect(child).toHaveAttribute('aria-level', '2');
  });

  /**
   * Asserted through the tree rather than by reading the address, for two reasons. The router here
   * is a `MemoryRouter`, so `window.location` is not where the address lives - but more usefully,
   * what a reader can actually perceive is that the node they clicked became the current one, and
   * that only happens if the selection round-tripped through the URL and back into the view.
   */
  it('opens the item a node stands for, and marks it current', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const roadmap = within(graphTree()).getByRole('treeitem', { name: /Roadmap/i });
    expect(roadmap).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(within(roadmap).getByRole('button'));

    expect(within(graphTree()).getByRole('treeitem', { name: /Roadmap/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  /**
   * A roving tabindex is a claim about the document's tab order, and nothing short of tabbing
   * through it checks that. Two thousand nodes behind two thousand tab stops would make the graph
   * something a keyboard user routes around rather than uses.
   */
  it('costs one tab stop, and moves within itself with the arrow keys', async () => {
    stubCoreApi({ items: [ROOT, CHILD, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(graphTree()).getAllByRole('button');
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);

    rows[0]?.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[1]);

    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(rows[rows.length - 1]);

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(rows[0]);
  });

  it('does not walk past either end of the list', async () => {
    stubCoreApi({ items: [ROOT, CHILD] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(graphTree()).getAllByRole('button');
    rows[0]?.focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(document.activeElement).toBe(rows[0]);
  });
});

/**
 * The honest states. A graph has one failure mode a list does not: a truncated list looks short and
 * announces itself, while a truncated graph looks like a graph. Somebody shown part of a workspace
 * would conclude two clusters are unconnected - a wrong answer rather than a missing one.
 */
describe('what the graph admits to', () => {
  it('says so when the node ceiling was reached, rather than drawing a partial graph as whole', async () => {
    stubCoreApi({ items: [ROOT, OTHER], graphTruncated: { nodes: true } });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(await screen.findByRole('status', { name: '' })).toBeInTheDocument();
    expect(screen.getByText(/first 2000 items/i)).toBeInTheDocument();
    expect(screen.getByText(/not drawn/i)).toBeInTheDocument();
  });

  it('reports a link ceiling separately, since the two are independent', async () => {
    stubCoreApi({ items: [ROOT, OTHER], graphTruncated: { links: true } });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.getByText(/first 4000 references/i)).toBeInTheDocument();
  });

  it('claims nothing when the graph is complete', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.queryByText(/not drawn/i)).not.toBeInTheDocument();
  });

  it('offers a way out when the read fails, and does not call it empty', async () => {
    stubCoreApi({ items: [ROOT], graphFails: true });
    renderAt(<App />, '/graph');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: /workspace graph/i })).not.toBeInTheDocument();
  });

  /**
   * A regression for a real debugging session. Core answers `404 workspaces.not_found` for a
   * workspace the caller may not see, and a server with no such route answers a bodyless 404 -
   * same status, completely different fact. Reporting the second as the first sent somebody
   * hunting a permission bug that did not exist while the server was simply running an older
   * build.
   */
  it('tells a missing route apart from a refused workspace, since both are 404', async () => {
    stubCoreApi({ items: [ROOT], graphRouteMissing: true });
    renderAt(<App />, '/graph');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/older build/i)).toBeInTheDocument();
    expect(within(alert).queryByText(/workspace could not be found/i)).not.toBeInTheDocument();
  });

  it('says a workspace the caller may not see could not be found', async () => {
    stubCoreApi({ items: [ROOT], graphFails: true });
    renderAt(<App />, '/graph');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/workspace could not be found/i)).toBeInTheDocument();
    expect(within(alert).queryByText(/older build/i)).not.toBeInTheDocument();
  });

  it('says a workspace with nothing in it is empty, not broken', async () => {
    stubCoreApi({ items: [] });
    renderAt(<App />, '/graph');

    expect(await screen.findByText(/nothing to graph yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * Zoom.
 *
 * The ladder itself is asserted in `graph-zoom.test.ts`, as arithmetic. What is left here is the
 * part only a rendered view can answer: that the controls exist under names somebody can find,
 * that they report where they got to, and that they stop at the ends rather than going quiet.
 */
describe('zooming the graph', () => {
  it('offers named controls rather than bare glyphs', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeInTheDocument();
  });

  it('says where the zoom got to, since the drawing rescaling is not something everyone can see', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });
    expect(screen.getByText('100%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(screen.getByText('150%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /zoom out/i }));
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('returns to where it started, exactly', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    await userEvent.click(screen.getByRole('button', { name: /reset zoom/i }));

    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('disables reset at the default, so the control never lies about having something to do', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeEnabled();
  });

  it('stops at the ends rather than stepping past them', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const zoomIn = screen.getByRole('button', { name: /zoom in/i });
    for (let step = 0; step < 8; step += 1) {
      if (!zoomIn.hasAttribute('disabled')) {
        await userEvent.click(zoomIn);
      }
    }

    expect(screen.getByText('300%')).toBeInTheDocument();
    expect(zoomIn).toBeDisabled();
  });
});

/**
 * Labels.
 *
 * **The one place these tests read the drawing**, and worth saying why. Labels used to be
 * permanent, and past a few dozen items that is a mat of overlapping text with the shape lost
 * underneath - so a node writes its name only when asked. That is a fact about the SVG and there is
 * nowhere else to look for it.
 *
 * The assertion is on the reveal class rather than on computed visibility, because jsdom does not
 * run Tailwind: no stylesheet is attached, so `getComputedStyle` reports nothing useful for
 * `opacity-0` or `group-hover`. This therefore catches the behaviour being deleted or inverted, and
 * does not prove a hover actually paints - which needs the browser-based pass (Storybook + axe),
 * the same limit `sidebar-drawer.test.tsx` records for its own.
 */
describe('when a node writes its name', () => {
  function labelFor(container: HTMLElement, title: string): SVGTextElement | undefined {
    return [...container.querySelectorAll('svg text')].find(
      (text) => text.textContent === title,
    ) as SVGTextElement | undefined;
  }

  it('keeps every name in the drawing, so nothing is unfindable', async () => {
    const { container } = renderAt(<App />, '/graph');
    stubCoreApi({ items: [ROOT, OTHER] });

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(labelFor(container, 'Specifications')).toBeDefined();
    expect(labelFor(container, 'Roadmap')).toBeDefined();
  });

  it('hides an ordinary node name until it is hovered', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(labelFor(container, 'Roadmap')?.getAttribute('class')).toContain(
      'group-hover:opacity-100',
    );
    expect(labelFor(container, 'Roadmap')?.getAttribute('class')).toContain('opacity-0');
  });

  it('keeps the open item named without a hover, since it is the one you are looking at', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });
    await userEvent.click(
      within(screen.getByRole('tree', { name: /workspace graph/i })).getByRole('button', {
        name: /Roadmap/i,
      }),
    );

    expect(labelFor(container, 'Roadmap')?.getAttribute('class')).not.toContain('opacity-0');
  });

  /**
   * The reason the drawing tracks keyboard focus at all. The tree is `sr-only`, so a sighted
   * keyboard user is focused on a control they cannot see - and without this the graph would give
   * them no indication of where they are.
   */
  it('names the node the keyboard is on, since the control itself is not painted', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(screen.getByRole('tree', { name: /workspace graph/i })).getAllByRole(
      'button',
    );
    const firstName = rows[0]?.textContent.split(',')[0] ?? '';
    rows[0]?.focus();

    // Awaited because focus sets React state: the re-render that reveals the label happens after
    // the event, not during `.focus()`.
    await waitFor(() => {
      expect(labelFor(container, firstName)?.getAttribute('class')).not.toContain('opacity-0');
    });
  });
});
