import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(join(packageDir, 'src', 'theme.css'), 'utf8');

/** Every custom property declared in theme.css, by name (without the leading dashes). */
function parseCustomProperties(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  // Strip comments first so commented-out declarations never count.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /--([\w-]+)\s*:\s*([^;]+);/g;
  for (const match of withoutComments.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

const properties = parseCustomProperties(themeCss);

function getProperty(name: string): string {
  const value = properties.get(name);
  if (value === undefined) {
    throw new Error(`theme.css does not declare --${name}`);
  }
  return value;
}

const RAMPS = ['neutral', 'accent', 'accent-2'] as const;
const STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

// A ramp value must be a syntactically valid color literal. The Industry
// sheet generates its ramps in OKLCH but serializes them as sRGB hex, so a
// valid value is either a 6-digit hex or an oklch() function.
const COLOR_LITERAL = /^(#[0-9a-fA-F]{6}|oklch\([^)]+\))$/;

describe('theme.css structure', () => {
  it('defines its tokens inside a Tailwind v4 @theme block', () => {
    expect(themeCss).toContain('@theme {');
  });

  it('clears the default Tailwind color, radius and shadow palettes', () => {
    expect(themeCss).toContain('--color-*: initial;');
    expect(themeCss).toContain('--radius-*: initial;');
    expect(themeCss).toContain('--shadow-*: initial;');
  });
});

describe('color ramps', () => {
  for (const ramp of RAMPS) {
    it(`carries the full ${ramp} ramp 100-900 with valid color literals`, () => {
      for (const step of STEPS) {
        const name = `color-${ramp}-${String(step)}`;
        expect(getProperty(name), `--${name}`).toMatch(COLOR_LITERAL);
      }
    });
  }

  it('spot-checks exact ramp values against the Industry source sheet', () => {
    expect(getProperty('color-neutral-100')).toBe('#f5f5f8');
    expect(getProperty('color-neutral-500')).toBe('#98989b');
    expect(getProperty('color-neutral-900')).toBe('#2b2b2d');
    expect(getProperty('color-accent-100')).toBe('#eef6ff');
    expect(getProperty('color-accent-500')).toBe('#749dc4');
    expect(getProperty('color-accent-600')).toBe('#597ea3');
    expect(getProperty('color-accent-700')).toBe('#416180');
    expect(getProperty('color-accent-900')).toBe('#1d2d3d');
    expect(getProperty('color-accent-2-300')).toBe('#bdd8f2');
    expect(getProperty('color-accent-2-500')).toBe('#7e9cb8');
    expect(getProperty('color-accent-2-900')).toBe('#1f2d3a');
  });
});

describe('base color roles', () => {
  it('carries the sheet base roles verbatim', () => {
    expect(getProperty('color-bg')).toBe('#f2f2f3');
    expect(getProperty('color-surface')).toBe('#e9e9ea');
    expect(getProperty('color-text')).toBe('#1d1f20');
    expect(getProperty('color-accent')).toBe('#5980a6');
    expect(getProperty('color-accent-2')).toBe('#728fab');
    expect(getProperty('color-divider')).toBe('color-mix(in srgb, #1d1f20 16%, transparent)');
  });
});

describe('semantic roles', () => {
  it('aliases background and foreground onto the base roles', () => {
    expect(getProperty('color-background')).toBe('var(--color-bg)');
    expect(getProperty('color-foreground')).toBe('var(--color-text)');
  });

  it('maps the accent interaction steps per the Industry guide', () => {
    // Hover is one step past the base on a light ground; pressed one more;
    // body-size accent text needs the deep step for contrast.
    expect(getProperty('color-accent-hover')).toBe('var(--color-accent-600)');
    expect(getProperty('color-accent-pressed')).toBe('var(--color-accent-700)');
    expect(getProperty('color-accent-text')).toBe('var(--color-accent-700)');
  });
});

describe('type', () => {
  it('sets the heading face to the Barlow Condensed stack', () => {
    const heading = getProperty('font-heading');
    expect(heading).toContain('Barlow Condensed');
    expect(heading).toContain('system-ui');
    expect(heading).toContain('sans-serif');
  });

  it('sets the body face to the Barlow stack', () => {
    const body = getProperty('font-body');
    expect(body).toMatch(/['"]Barlow['"]/);
    expect(body).toContain('system-ui');
    expect(body).toContain('sans-serif');
  });

  it('carries the heading weight as a plain custom property', () => {
    expect(getProperty('font-heading-weight')).toBe('600');
  });
});

describe('spacing, radius, elevation', () => {
  it('derives the Tailwind spacing scale from the 3.4px density-scaled unit', () => {
    expect(getProperty('spacing')).toBe('3.4px');
  });

  it('carries the sheet named spacing steps verbatim', () => {
    expect(getProperty('space-1')).toBe('3.4px');
    expect(getProperty('space-2')).toBe('6.8px');
    expect(getProperty('space-3')).toBe('10.2px');
    expect(getProperty('space-4')).toBe('13.6px');
    expect(getProperty('space-6')).toBe('20.4px');
    expect(getProperty('space-8')).toBe('27.2px');
  });

  it('carries the radius steps verbatim', () => {
    expect(getProperty('radius-sm')).toBe('2px');
    expect(getProperty('radius-md')).toBe('4px');
    expect(getProperty('radius-lg')).toBe('7px');
  });

  it('carries the shadow tokens verbatim', () => {
    expect(getProperty('shadow-sm')).toBe('0 1px 2px color-mix(in srgb, #2b2b2d 14%, transparent)');
    expect(getProperty('shadow-md')).toBe(
      '0 3px 10px color-mix(in srgb, #2b2b2d 16%, transparent)',
    );
    expect(getProperty('shadow-lg')).toBe(
      '0 12px 32px color-mix(in srgb, #2b2b2d 22%, transparent)',
    );
  });
});

describe('package exports', () => {
  it('exposes the stylesheet and package.json through "exports"', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      exports: Record<string, string | Record<string, string>>;
    };
    const rootExport = manifest.exports['.'];
    expect(rootExport).toBeDefined();
    if (typeof rootExport === 'object') {
      expect(rootExport.style).toBe('./src/theme.css');
      expect(rootExport.default).toBe('./src/theme.css');
    } else {
      expect(rootExport).toBe('./src/theme.css');
    }
    expect(manifest.exports['./theme.css']).toBe('./src/theme.css');
    expect(manifest.exports['./package.json']).toBe('./package.json');
  });
});
