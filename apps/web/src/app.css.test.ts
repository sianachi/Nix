// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The app must compile the component library it renders.
//
// @nix/ui resolves through a pnpm workspace symlink into node_modules, which is
// outside the Vite root and excluded from Tailwind v4's automatic content
// detection. Without an explicit @source in app.css, every class used only
// inside packages/ui is absent from the stylesheet the browser gets: buttons
// lose their height and padding, tables lose their border model, and text loses
// its letter-spacing. Storybook has always had that @source, which is why the
// library looked correct there and wrong in the app.
//
// This compiles the real app.css with the real Tailwind CLI and asserts the
// library's own rules survive. Three things make it honest:
//  - The scratch directory lives inside apps/web, so `@import 'tailwindcss'`
//    and the @fontsource imports resolve through the workspace. An OS temp
//    directory has no path back to node_modules and the compile fails there.
//  - The CLI runs with the scratch directory as its working directory, so
//    automatic detection finds nothing on its own. The probe then names
//    apps/web/src explicitly, standing in for the root scan Vite performs in
//    the real build. That leaves app.css's own @source as the only route by
//    which a rule from packages/ui can reach the output, which is the claim.
//  - The probe excludes test files, this one included. Tailwind's extractor
//    treats a bare utility name in any scanned file as a used class, so writing
//    `border-separate` in a comment here would be enough to emit the rule this
//    test looks for and pass against a stylesheet that never saw the library.
//    Asserting declarations rather than selectors (below) already makes that
//    hard; excluding the file makes it impossible.
//
// Verified by removing the @source line from app.css: this fails, naming every
// missing declaration.

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Rules only packages/ui asks for, each checked absent when the library is left
// out of the scan.
//
// Asserted as declarations rather than as selectors on purpose. A selector
// carries Tailwind's escaping scheme - `.h-\(--control-md\)` - so a test written
// against it breaks when that escaping changes and reports a styling regression
// that has not happened. What matters is that the rule reached the stylesheet.
const LIBRARY_ONLY = [
  // Table.tsx: the border model the hairline row rules depend on.
  'border-collapse: separate',
  'border-spacing:',
  // Button.tsx, Input.tsx, Select.tsx: every control's height.
  'height: var(--control-md)',
  // Button.tsx: the horizontal padding, off the spacing scale.
  'padding-inline: calc(var(--spacing) * 3.6)',
  // Text.tsx: the body face's negative tracking.
  'letter-spacing: -0.015em',
];

let workDir: string;
let output: string;

beforeAll(() => {
  // Under .vite/ because that is already gitignored. A scratch directory left
  // behind by a Ctrl-C out of watch mode - afterAll does not run on SIGINT -
  // would otherwise sit untracked inside the app source root, full of class
  // names, exactly where the real build's automatic detection scans.
  const scratchRoot = join(appDir, '.vite');
  mkdirSync(scratchRoot, { recursive: true });
  workDir = mkdtempSync(join(scratchRoot, 'css-smoke-'));

  writeFileSync(
    join(workDir, 'input.css'),
    [
      "@import '../../src/app.css';",
      "@source '../../src';",
      "@source not '../../src/**/*.test.ts';",
      "@source not '../../src/**/*.test.tsx';",
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

  try {
    execFileSync(process.execPath, [cliBin, '--input', 'input.css', '--output', 'out.css'], {
      cwd: workDir,
      // stderr inherited rather than buffered: every way this can break - a bad
      // @source path, a CLI flag change, a missing package - otherwise reports
      // as the same opaque non-zero exit with the reason in an unread buffer.
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    throw new Error(`Tailwind could not compile app.css: ${String(error)}`);
  }

  output = readFileSync(join(workDir, 'out.css'), 'utf8');
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('the web entry', () => {
  it('compiles the rules the component library depends on', () => {
    const missing = LIBRARY_ONLY.filter((declaration) => !output.includes(declaration));

    expect(missing).toEqual([]);
  });
});
