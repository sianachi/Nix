import { SITE_PALETTE } from '@nix/design-tokens/site';
import { describe, expect, it } from 'vitest';

import { contrast, readableAccent, themeCss, themeFonts } from './css.js';

const base = {
  accent: '#4f7a3a', // design-token-exempt: a site owner's chosen accent.
  headingMark: 'square',
  typeface: 'rounded',
  spacing: 'comfortable',
} as const;

describe('readableAccent', () => {
  const accents = ['#4f7a3a', '#2f5fd0', '#ffd400', '#00ffff', '#000000', '#ffffff']; // design-token-exempt: chosen accents.
  it.each(accents)('reads at 4.5:1 on both grounds for %s', (accent) => {
    for (const ground of [SITE_PALETTE.light, SITE_PALETTE.dark]) {
      const link = readableAccent(accent, ground);
      expect(contrast(link, ground.ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(link, ground.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps an accent that already reads', () => {
    const dark = '#1d4a10'; // design-token-exempt: a chosen accent that already reads.
    expect(readableAccent(dark, SITE_PALETTE.light)).toBe(dark);
  });
});

describe('themeCss', () => {
  it('loads only the chosen typeface', () => {
    const css = themeCss({ ...base, typeface: 'serif' });
    expect(css).toContain("font-family:'Literata'");
    expect(css).not.toContain('Nunito Sans');
    expect(themeFonts('legible')[0]?.package).toBe('@fontsource/atkinson-hyperlegible-next');
  });

  it('draws the chosen heading mark and spacing', () => {
    expect(themeCss({ ...base, headingMark: 'none' })).toContain(
      '.nix-glyph,.nix-mark{display:none}',
    );
    expect(themeCss({ ...base, headingMark: 'diamond' })).toContain('rotate(45deg)');
    expect(themeCss({ ...base, spacing: 'airy' })).toContain('--rhythm:1.3;');
  });
});
