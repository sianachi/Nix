// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

// Rules only packages/ui asks for, each checked absent when the library is left
// out of the scan.
//
// Asserted as declarations rather than as selectors on purpose. A selector
// carries Tailwind's escaping scheme - `.h-\(--control-md\)` - so a test written
// against it breaks when that escaping changes and reports a styling regression
// that has not happened. What matters is that the rule reached the stylesheet.
// Patterns rather than literals, and for the same reason one step further out.
// What this test knows is "the library's rules are being compiled"; it does not
// get to care whether a value is written inline or has since been moved onto a
// token, because moving one there is exactly the change the design system is
// supposed to be able to make. The tracking step was the worked example: it was
// `-0.015em` in Text.tsx and became `var(--tracking-tight)` when the scale
// landed, and a test pinned to either spelling calls the other a regression.
//
// That canary has since been retired, which is the other half of the same
// lesson. `tracking-tight` stopped being library-only when U11's adoption sweep
// wrote it in two places in `apps/web` - once in the reason a wordmark keeps its
// own tracking, once in the specimen that draws the whole tracking ladder - and
// a canary the app also sings is not a canary. It is replaced below by the
// display step, which `apps/web` reaches only through `<Text variant="h1">`.
const LIBRARY_ONLY: readonly (readonly [string, RegExp])[] = [
  // Table.tsx: the border model the hairline row rules depend on.
  ['the table border model', /border-collapse:\s*separate/],
  ['the table border spacing', /border-spacing:/],
  // Button.tsx, Input.tsx, Select.tsx: every control's height.
  ['the control height', /height:\s*var\(--control-md\)/],
  // Button.tsx: the horizontal padding, off the spacing scale.
  ['the button padding', /padding-inline:\s*calc\(var\(--spacing\)\s*\*\s*3\.6\)/],
  // Text.tsx: the top of the type scale, which only the h1 variant asks for.
  ['the display step', /font-size:\s*(40px|var\(--text-3xl\))/],
];

/**
 * The utilities the declarations above stand for, as an app-side exclusion list.
 *
 * Every entry in `LIBRARY_ONLY` is a canary: it means something only while
 * `apps/web` does not ask for the same utility itself. The day a component here
 * writes `tracking-tight`, that declaration appears in the stylesheet whether
 * the `@source` line exists or not, and the assertion above quietly stops
 * testing anything.
 *
 * That is not hypothetical. `apps/web` had no letter-spacing vocabulary at all
 * until the sweep that moved it onto the scale, and it now names four of the
 * six tracking steps; `min-w-(--control-md)` appeared in the same sweep, one
 * keystroke from the `h-` spelling below.
 *
 * So the canaries are checked for what they are. When this fails, the fix is to
 * pick a different declaration that is still library-only - not to delete the
 * assertion it protects.
 */
const CANARY_UTILITIES = [
  'border-separate',
  'border-spacing-',
  'h-(--control-md)',
  'px-3.6',
  'text-3xl',
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
    const missing = LIBRARY_ONLY.filter(([, pattern]) => !pattern.test(output)).map(
      ([label]) => label,
    );

    expect(missing).toEqual([]);
  });

  it('keeps those rules library-only, so the check above still checks something', () => {
    const sourceRoot = join(appDir, 'src');

    function sourceFiles(directory: string): readonly string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
          return sourceFiles(path);
        }

        // Test files are excluded from the probe's scan, so a canary named in
        // one - this file names all five - never reaches the stylesheet.
        return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)
          ? [path]
          : [];
      });
    }

    const claimed = sourceFiles(sourceRoot).flatMap((path) => {
      const contents = readFileSync(path, 'utf8');

      return CANARY_UTILITIES.filter((utility) => contents.includes(utility)).map(
        (utility) => `${path.slice(sourceRoot.length + 1)}: ${utility}`,
      );
    });

    expect(claimed).toEqual([]);
  });
});
