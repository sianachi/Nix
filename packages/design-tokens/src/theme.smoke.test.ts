import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Smoke check: Tailwind v4 must accept the theme and turn the tokens into
// working utilities. Compiles a tiny probe document with the real Tailwind
// CLI and asserts the generated CSS resolves utilities to the token values.
//
// Two things make this deterministic:
//  - The scratch directory lives inside the package, so `@import 'tailwindcss'`
//    resolves through the workspace. An OS temp directory has no path back to
//    node_modules and the compile fails there.
//  - `source(none)` disables automatic source detection, so the output depends
//    only on the probe below and not on whatever files sit around the package.

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const PROBE_CLASSES = [
  'bg-accent-500',
  'bg-background',
  'text-foreground',
  'text-accent-text',
  'hover:bg-accent-hover',
  'active:bg-accent-pressed',
  'font-heading',
  'font-body',
  'rounded-md',
  'shadow-lg',
  'p-4',
  'gap-2',
].join(' ');

let workDir: string;
let output: string;

beforeAll(() => {
  workDir = mkdtempSync(join(packageDir, '.smoke-'));
  writeFileSync(join(workDir, 'probe.html'), `<div class="${PROBE_CLASSES}"></div>`);
  writeFileSync(
    join(workDir, 'input.css'),
    [
      "@import 'tailwindcss' source(none);",
      // The package's own theme, as a consumer would import it.
      "@import '../src/theme.css';",
      "@source './probe.html';",
      '',
    ].join('\n'),
  );

  // The CLI package exposes no main export, only its bin; resolve the bin
  // script through its manifest.
  const cliManifestPath = require.resolve('@tailwindcss/cli/package.json');
  const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as {
    bin: { tailwindcss: string };
  };
  const cliBin = join(dirname(cliManifestPath), cliManifest.bin.tailwindcss);
  execFileSync(process.execPath, [cliBin, '--input', 'input.css', '--output', 'out.css'], {
    cwd: workDir,
    stdio: 'pipe',
  });
  output = readFileSync(join(workDir, 'out.css'), 'utf8');
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('Tailwind v4 compiles the theme', () => {
  it('emits the ramp token and resolves bg-accent-500 to it', () => {
    expect(output).toContain('--color-accent-500: #749dc4;');
    expect(output).toContain('.bg-accent-500');
    expect(output).toContain('background-color: var(--color-accent-500)');
  });

  it('resolves the semantic role utilities through the base roles', () => {
    expect(output).toContain('--color-bg: #f2f2f3;');
    expect(output).toContain('--color-background: var(--color-bg);');
    expect(output).toContain('.bg-background');
    expect(output).toContain('--color-accent-hover: var(--color-accent-600);');
    expect(output).toContain('--color-accent-text: var(--color-accent-700);');
  });

  it('resolves type, spacing and radius utilities to the tokens', () => {
    expect(output).toContain("--font-heading: 'Barlow Condensed', system-ui, sans-serif;");
    expect(output).toContain('--spacing: 3.4px;');
    expect(output).toContain('--radius-md: 4px;');
    expect(output).toContain('.rounded-md');
    expect(output).toContain('.p-4');
  });

  it('carries the elevation token value into the shadow utility', () => {
    // Tailwind v4 inlines a shadow's value into --tw-shadow rather than
    // referencing var(--shadow-lg), so the token is asserted through the
    // generated utility, not through an emitted theme variable.
    expect(output).toContain('.shadow-lg');
    expect(output).toContain('0 12px 32px var(--tw-shadow-color, color-mix(in srgb, #2b2b2d 22%');
  });

  it('does not resurrect the default Tailwind palette', () => {
    expect(output).not.toContain('--color-red-500');
    expect(output).not.toContain('--color-blue-500');
  });
});
