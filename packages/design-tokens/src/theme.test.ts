import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(join(packageDir, 'src', 'theme.css'), 'utf8');

/**
 * The sheet split into the ground it applies to.
 *
 * The dark ground redeclares the semantic roles, so a parser that swept the whole file would
 * report the dark value for every role and quietly assert nothing about the light one. Splitting on
 * the media query is what keeps each ground's assertions about that ground.
 */
function splitByGround(css: string): { light: string; dark: string } {
  // Strip comments first so commented-out declarations never count.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const darkStart = withoutComments.indexOf('@media (prefers-color-scheme: dark)');

  if (darkStart === -1) {
    return { light: withoutComments, dark: '' };
  }

  // The dark ground is a runtime :root override rather than a second @theme block, because
  // Tailwind flattens every theme block it finds regardless of what wraps it. Splitting on the
  // media query is still what keeps each ground's assertions about that ground.
  let depth = 0;
  let index = withoutComments.indexOf('{', darkStart);
  const blockStart = index;

  while (index < withoutComments.length) {
    if (withoutComments[index] === '{') depth += 1;
    if (withoutComments[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }

  return {
    light: withoutComments.slice(0, darkStart) + withoutComments.slice(index + 1),
    dark: withoutComments.slice(blockStart, index + 1),
  };
}

/** Every custom property declared in one ground, by name (without the leading dashes). */
function parseCustomProperties(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const pattern = /--([\w-]+)\s*:\s*([^;]+);/g;
  for (const match of css.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

const grounds = splitByGround(themeCss);
const properties = parseCustomProperties(grounds.light);
const darkProperties = parseCustomProperties(grounds.dark);

function getProperty(name: string): string {
  const value = properties.get(name);
  if (value === undefined) {
    throw new Error(`theme.css does not declare --${name}`);
  }
  return value;
}

function getDarkProperty(name: string): string {
  const value = darkProperties.get(name);
  if (value === undefined) {
    throw new Error(`theme.css does not declare --${name} on the dark ground`);
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

describe('the type scale', () => {
  const STEPS = ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl'] as const;

  it.each(STEPS)('carries the %s step as a pixel size', (step) => {
    expect(getProperty(`text-${step}`)).toMatch(/^\d+px$/);
  });

  it.each(STEPS)('pairs the %s step with a line height', (step) => {
    expect(getProperty(`text-${step}--line-height`)).toMatch(/^[\d.]+$/);
  });

  it('ascends without repeating a size', () => {
    const sizes = STEPS.map((step) => Number.parseInt(getProperty(`text-${step}`), 10));

    // A scale with two equal steps is a scale with a step nobody needs, and a scale that descends
    // anywhere is one somebody will reach into the middle of.
    expect(sizes).toEqual([...sizes].sort((left, right) => left - right));
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it('carries no half-pixel sizes', () => {
    // The reference this was derived from has four. Half-pixel type is a rendering accident rather
    // than a design intention, and encoding it here would make it permanent. See ADR-0008.
    for (const step of STEPS) {
      expect(getProperty(`text-${step}`), `--text-${step}`).not.toContain('.');
    }
  });
});

describe('the control-height scale', () => {
  it('carries three steps', () => {
    expect(getProperty('control-sm')).toBe('28px');
    expect(getProperty('control-md')).toBe('36px');
    expect(getProperty('control-lg')).toBe('44px');
  });

  it('keeps the default at what the button already used, so nothing moves', () => {
    expect(getProperty('control-md')).toBe('36px');
  });

  it('offers a step that meets the touch guidance', () => {
    // 44px is the smallest target the accessibility guidance accepts. Having it as a token is what
    // stops the responsive work inventing a number.
    expect(Number.parseInt(getProperty('control-lg'), 10)).toBeGreaterThanOrEqual(44);
  });
});

describe('the dark ground', () => {
  const ROLES = [
    'color-bg',
    'color-surface',
    'color-text',
    'color-divider',
    'color-accent-text',
    'color-accent-hover',
    'color-accent-pressed',
    'color-muted',
  ] as const;

  it.each(ROLES)('redefines %s', (role) => {
    expect(getDarkProperty(role)).not.toBe('');
  });

  it('inverts the ground rather than tinting it', () => {
    // A dark mode that merely darkened the paper would leave text at the same lightness and the
    // contrast reasoning recorded in Text would silently stop holding.
    expect(getDarkProperty('color-bg')).not.toBe(getProperty('color-bg'));
    expect(getDarkProperty('color-text')).not.toBe(getProperty('color-text'));
  });

  it('moves muted copy to the other end of the neutral ramp', () => {
    // The ramp is not symmetric: the step that reads as quiet against paper is nearly invisible
    // against ink, so this is a different step rather than the same one reused.
    expect(getProperty('color-muted')).toBe('var(--color-neutral-700)');
    expect(getDarkProperty('color-muted')).toBe('var(--color-neutral-400)');
  });

  it('leaves the ramps alone', () => {
    // Only the semantic roles move. A component saying bg-background is correct in both grounds;
    // one saying bg-neutral-100 is not, and that distinction is the whole design.
    for (const step of [100, 500, 900]) {
      expect(darkProperties.has(`color-accent-${String(step)}`)).toBe(false);
      expect(darkProperties.has(`color-neutral-${String(step)}`)).toBe(false);
    }
  });

  it('can be chosen deliberately as well as inherited from the system', () => {
    // Somebody on a dark desktop reading a document on a light ground should not have to change
    // their machine's setting to do it.
    expect(themeCss).toContain("[data-theme='dark']");
    expect(themeCss).toContain("[data-theme='light']");
  });
});

describe('the accent fill', () => {
  it('is a role of its own, not the text role reused', () => {
    // They start at the same step, which is why reusing one for the other looked correct until
    // somebody hovered on the dark ground.
    expect(getProperty('color-accent-fill')).toBe(getProperty('color-accent-text'));
    expect(properties.has('color-accent-fill-hover')).toBe(true);
    expect(properties.has('color-accent-fill-pressed')).toBe(true);
  });

  it('moves away from the ground on paper', () => {
    // A fill carrying a ground-coloured label has to move away from the ground as it is pressed,
    // or it closes on its own text. On paper that is deeper into the ramp.
    expect(getProperty('color-accent-fill-hover')).toBe('var(--color-accent-800)');
    expect(getProperty('color-accent-fill-pressed')).toBe('var(--color-accent-900)');
  });

  it('moves the other way on ink', () => {
    // The ramps do not move between grounds but --color-background does, so on ink the label is
    // dark and a fill stepping deeper would move towards it. Written with the text roles this read
    // 1.8:1, in the one state axe does not reach.
    expect(getDarkProperty('color-accent-fill-hover')).toBe('var(--color-accent-200)');
    expect(getDarkProperty('color-accent-fill-pressed')).toBe('var(--color-accent-100)');
  });
});

describe('the browser half of the theme', () => {
  it('declares a color scheme for each ground', () => {
    // Scrollbars, the canvas behind the document and every native control - a date picker, a
    // select's dropdown, a checkbox - are drawn by the browser from `color-scheme` and from nothing
    // else. No custom property reaches them, so without this a date field renders white-on-white
    // over a dark page and the scrollbar is a bright bar down the side of it.
    expect(themeCss).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
    expect(grounds.dark).toContain('color-scheme: dark');
    expect(themeCss).toMatch(/\[data-theme='dark'\]\s*\{\s*color-scheme:\s*dark/);
    expect(themeCss).toMatch(/\[data-theme='light'\]\s*\{\s*color-scheme:\s*light/);
  });

  it('keeps it out of the theme block, which takes custom properties only', () => {
    // Tailwind refuses an `@theme` block containing anything else, and the failure it produces is
    // a suite that reports as *skipped* rather than failed - which is how this shipped green once
    // already.
    const themeBlocks = themeCss.match(/@theme\s*\{[\s\S]*?\n\}/g) ?? [];

    expect(themeBlocks.length).toBeGreaterThan(0);
    for (const block of themeBlocks) {
      expect(block).not.toContain('color-scheme');
    }
  });
});
