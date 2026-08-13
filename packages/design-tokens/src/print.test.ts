import { describe, expect, it } from 'vitest';

import { PRINT_PALETTE } from './print.js';
import { parseCustomProperties, resolveProperty, splitByGround, themeCss } from './theme-sheet.js';

/**
 * The print palette against the sheet it claims to come from.
 *
 * Without this, `print.ts` is a second copy of the colours that drifts the first time a ramp step
 * moves - and drifts silently, because nothing else in the tree reads both. This is the whole
 * justification for a hand-written palette living in a directory the raw-value guard cannot see.
 */

const light = parseCustomProperties(splitByGround(themeCss).light);

/** Which token each print role is taken from, and therefore what must not move without this failing. */
const SOURCES: Readonly<Record<keyof typeof PRINT_PALETTE, string>> = {
  ink: 'color-text',
  muted: 'color-muted',
  accentText: 'color-accent-text',
  accentFill: 'color-accent-fill',
  surface: 'color-surface',

  // Not `color-divider`: that is a color-mix() against the ground, which neither PDF nor Open XML
  // can express. The neutral step below is the substitution print.ts documents.
  divider: 'color-neutral-300',
  calloutFill: 'color-neutral-100',
  codeFill: 'color-neutral-200',
  highlight: 'color-accent-200',
};

describe('the print palette', () => {
  it('takes every colour from the light ground of the token sheet', () => {
    for (const [role, token] of Object.entries(SOURCES)) {
      expect(PRINT_PALETTE[role as keyof typeof PRINT_PALETTE]).toBe(resolveProperty(light, token));
    }
  });

  it('names a source for every role, so a new one cannot be invented untraced', () => {
    expect(Object.keys(SOURCES).sort()).toEqual(Object.keys(PRINT_PALETTE).sort());
  });

  it('is entirely literal colour, because a page cannot resolve a variable', () => {
    for (const value of Object.values(PRINT_PALETTE)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps code and callout grounds apart, so the two blocks never read alike', () => {
    expect(PRINT_PALETTE.codeFill).not.toBe(PRINT_PALETTE.calloutFill);
  });
});
