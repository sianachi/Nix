/**
 * Generates the pet's capability catalog from `buildCatalog()` and writes it in the three shapes
 * consumers need: the machine JSON `src/generated/catalog.json`, and the two plain text files the
 * Go worker embeds. Committed outputs, never hand-edited - `pnpm --filter @nix/structure-spec
 * catalog` is the only way they change. CI (`.github/workflows/ci-frontend.yml`) and
 * `scripts/changed-path-checks.sh` both re-run this and diff the result against what is
 * committed.
 *
 * Paths are resolved from this script's own location, not the process cwd, so `pnpm --filter
 * @nix/structure-spec catalog` writes the same files whether it is run from the repo root or from
 * inside the package.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Imports the built package by its own name, like apps/cli imports its workspace dependencies:
// this script runs under Node's type-stripping loader directly against source, and a relative
// import written as `../src/catalog/build.js` cannot resolve `build.ts`'s own `.js`-suffixed
// sibling imports against the `.ts` files actually on disk. The `catalog` script's own `tsc` step
// builds this package immediately before this file runs, so the package's `exports` map always
// resolves to a fresh `dist`.
import { buildCatalog, renderChat, renderConsult } from '@nix/structure-spec';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');

const catalogJsonPath = resolve(packageRoot, 'src/generated/catalog.json');
const patternsPath = resolve(packageRoot, 'catalog/patterns.txt');
const chatTxtPath = resolve(repoRoot, 'apps/go-workers/internal/companion/catalog/chat.txt');
const consultTxtPath = resolve(repoRoot, 'apps/go-workers/internal/companion/catalog/consult.txt');

async function main(): Promise<void> {
  const catalog = buildCatalog();
  const patterns = await readFile(patternsPath, 'utf8');

  const chat = renderChat(catalog);
  const consult = renderConsult(catalog, patterns);

  // Two-space indent, trailing newline: a diff-friendly, deterministic form so the drift checks
  // (CI and changed-path-checks.sh) are meaningful rather than reordering noise on every run. Key
  // order is stable because `buildCatalog()` always builds the same object literal in the same
  // order; a replacer is not needed and would filter nested keys by name instead of reordering
  // them. Piped through prettier (below) so `pnpm lint`'s format check accepts it, the same way
  // `@nix/api-client`'s `generate` script formats its own generated file.
  const catalogJson = JSON.stringify(catalog, null, 2) + '\n';

  await mkdir(dirname(catalogJsonPath), { recursive: true });
  await mkdir(dirname(chatTxtPath), { recursive: true });

  await writeFile(catalogJsonPath, catalogJson, 'utf8');
  await writeFile(chatTxtPath, chat.trimEnd() + '\n', 'utf8');
  await writeFile(consultTxtPath, consult.trimEnd() + '\n', 'utf8');

  process.stdout.write(
    `Wrote ${catalogJsonPath}\nWrote ${chatTxtPath} (${String(chat.length)} chars)\nWrote ${consultTxtPath} (${String(consult.length)} chars)\n`,
  );
}

await main();
