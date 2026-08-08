import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PRESENTATION, SyncFooter } from '../../editor/sync-footer';

import type { SyncState } from '../../editor/collab-sync';

/**
 * The sync footer's legibility contract: six states, one line, and the distinction between
 * "your work is syncing" and "it is not" must survive a glance, a screen reader, and a
 * monochrome display.
 *
 * The tier assertions read class names, which is deliberate: the tiers *are* presentation
 * (ink role, ground band, accent glyph), and the class list is the only place that
 * presentation exists before a browser paints it. The words themselves are asserted by
 * what a person reads.
 */

const ALL_STATES = [
  'connecting',
  'live',
  'pending',
  'readonly',
  'degraded',
  'offline',
] as const satisfies readonly SyncState[];

function renderFooter(state: SyncState): HTMLElement {
  render(<SyncFooter state={state} />);
  return screen.getByRole('contentinfo');
}

function expectUnhealthyDress(footer: HTMLElement, term: string): void {
  expect(footer.className).toContain('bg-surface');
  expect(screen.getByText(term).className).toContain('text-foreground');
  expect(footer.querySelector('svg')?.getAttribute('class')).toContain('text-accent');
}

describe('the sync footer', () => {
  it('announces state changes politely instead of interrupting mid-sentence', () => {
    const footer = renderFooter('live');
    expect(footer).toHaveAttribute('aria-live', 'polite');
  });

  it('keeps the same live region across state changes, so a change is announced', () => {
    const { rerender } = render(<SyncFooter state={'live'} />);
    const footer = screen.getByRole('contentinfo');
    const before = footer.textContent;

    rerender(<SyncFooter state={'offline'} />);

    // Same node, new words: an aria-live announcement depends on the region persisting
    // while its contents change, not on a fresh region appearing.
    expect(screen.getByRole('contentinfo')).toBe(footer);
    expect(footer.textContent).not.toBe(before);
    expect(footer.textContent).toContain('Offline');
  });

  it('hides its glyph from assistive technology, leaving the words to carry the state', () => {
    const footer = renderFooter('offline');
    const glyph = footer.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('lets a healthy connection recede: live is muted, unbanded, and unaccented', () => {
    const footer = renderFooter('live');
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Edits reach other people as you type.')).toBeInTheDocument();
    expect(screen.getByText('Live').className).toContain('text-muted');
    expect(footer.className).not.toContain('bg-surface');
    expect(footer.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('text-accent');
  });

  it('says it is connecting as quietly as live: muted, unbanded, told apart by its spinner', () => {
    const footer = renderFooter('connecting');
    expect(screen.getByText('Connecting')).toBeInTheDocument();
    expect(screen.getByText('Reaching the server.')).toBeInTheDocument();
    expect(screen.getByText('Connecting').className).toContain('text-muted');
    expect(footer.className).not.toContain('bg-surface');
  });

  it('treats unsent edits as trouble: "not saved" wears the full unhealthy dress', () => {
    const footer = renderFooter('pending');
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your edits are only in this tab until the connection returns - keep it open.',
      ),
    ).toBeInTheDocument();
    expectUnhealthyDress(footer, 'Not saved');
  });

  it('tells a viewer the truth about read-only without claiming their access changed', () => {
    const footer = renderFooter('readonly');
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('You have view access, so edits are not saved.')).toBeInTheDocument();
    expectUnhealthyDress(footer, 'Read-only');
  });

  it('says the server cannot sync, briefly, and wears the unhealthy dress', () => {
    const footer = renderFooter('degraded');
    expect(screen.getByText('Not syncing')).toBeInTheDocument();
    expect(
      screen.getByText('The server cannot sync this document right now; reloading may help.'),
    ).toBeInTheDocument();
    expectUnhealthyDress(footer, 'Not syncing');
  });

  it('says offline edits live only in this tab, and wears the unhealthy dress', () => {
    const footer = renderFooter('offline');
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(
      screen.getByText('Edits made now stay only in this tab until the connection returns.'),
    ).toBeInTheDocument();
    expectUnhealthyDress(footer, 'Offline');
  });

  it('gives each state its own glyph, so shape distinguishes what color must not carry alone', () => {
    const icons = new Set(ALL_STATES.map((state) => PRESENTATION[state].icon));
    expect(icons.size).toBe(ALL_STATES.length);
  });

  it('keeps the detail to one truncating line', () => {
    const footer = renderFooter('degraded');
    const detail = screen.getByText(
      'The server cannot sync this document right now; reloading may help.',
    );
    expect(detail.className).toContain('truncate');
    expect(detail.className).toContain('min-w-0');
    expect(footer.className).toContain('items-baseline');
  });

  it('spins only the connecting glyph, and only when motion is allowed', () => {
    const { unmount } = render(<SyncFooter state={'connecting'} />);
    expect(screen.getByRole('contentinfo').querySelector('svg')?.getAttribute('class')).toContain(
      'motion-safe:animate-spin',
    );
    unmount();

    render(<SyncFooter state={'live'} />);
    expect(
      screen.getByRole('contentinfo').querySelector('svg')?.getAttribute('class') ?? '',
    ).not.toContain('animate-spin');
  });
});
