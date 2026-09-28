/**
 * Generates the pet's capability catalog from `buildCatalog()` and `buildPetTools()` and writes
 * it in the shapes consumers need: the machine JSON `src/generated/catalog.json`, the two plain
 * text catalogs (`chat.txt`, `consult.txt`) and the three typed-tool JSON files (`tools-chat.json`,
 * `tools-consult.json`, `tool-examples.json`) the Go worker embeds. Committed outputs, never
 * hand-edited - `pnpm --filter @nix/structure-spec catalog` is the only way they change. CI
 * (`.github/workflows/ci-frontend.yml`) and `scripts/changed-path-checks.sh` both re-run this and
 * diff the result against what is committed.
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
import {
  buildCatalog,
  buildPetTools,
  renderChat,
  renderConsult,
  WORKSPACE_OPERATIONS,
} from '@nix/structure-spec';
import { flattenToolExample, TOOL_EXAMPLES } from '@nix/structure-spec/testing';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');

const catalogJsonPath = resolve(packageRoot, 'src/generated/catalog.json');
const patternsPath = resolve(packageRoot, 'catalog/patterns.txt');
const companionCatalogDir = resolve(repoRoot, 'apps/go-workers/internal/companion/catalog');
const chatTxtPath = resolve(companionCatalogDir, 'chat.txt');
const consultTxtPath = resolve(companionCatalogDir, 'consult.txt');
const toolsChatJsonPath = resolve(companionCatalogDir, 'tools-chat.json');
const toolsConsultJsonPath = resolve(companionCatalogDir, 'tools-consult.json');
const toolExamplesJsonPath = resolve(companionCatalogDir, 'tool-examples.json');

async function main(): Promise<void> {
  const catalog = buildCatalog();
  const patterns = await readFile(patternsPath, 'utf8');

  const chat = renderChat(catalog);
  const consult = renderConsult(catalog, patterns);
  const toolsChat = buildPetTools('chat');
  const toolsConsult = buildPetTools('consult');

  // The examples every WorkspaceOperation's typed tool call may look like, plus the flat
  // {operation, itemId, ...} shape the Go worker's flattenToolCall must produce from it - written
  // once here so apps/go-workers/internal/companion's Go test table reads the identical fixture
  // this package's own tools.test.ts checks against @nix/companion's workspaceToolSchema.
  const toolExamples = WORKSPACE_OPERATIONS.map((operation) => ({
    operation,
    arguments: TOOL_EXAMPLES[operation],
    flat: flattenToolExample(operation, TOOL_EXAMPLES[operation]),
  }));

  // Two-space indent, trailing newline: a diff-friendly, deterministic form so the drift checks
  // (CI and changed-path-checks.sh) are meaningful rather than reordering noise on every run. Key
  // order is stable because `buildCatalog()` always builds the same object literal in the same
  // order; a replacer is not needed and would filter nested keys by name instead of reordering
  // them. Piped through prettier (below) so `pnpm lint`'s format check accepts it, the same way
  // `@nix/api-client`'s `generate` script formats its own generated file.
  const catalogJson = JSON.stringify(catalog, null, 2) + '\n';
  const toolsChatJson = JSON.stringify(toolsChat, null, 2) + '\n';
  const toolsConsultJson = JSON.stringify(toolsConsult, null, 2) + '\n';
  const toolExamplesJson = JSON.stringify(toolExamples, null, 2) + '\n';

  await mkdir(dirname(catalogJsonPath), { recursive: true });
  await mkdir(companionCatalogDir, { recursive: true });

  await writeFile(catalogJsonPath, catalogJson, 'utf8');
  await writeFile(chatTxtPath, chat.trimEnd() + '\n', 'utf8');
  await writeFile(consultTxtPath, consult.trimEnd() + '\n', 'utf8');
  await writeFile(toolsChatJsonPath, toolsChatJson, 'utf8');
  await writeFile(toolsConsultJsonPath, toolsConsultJson, 'utf8');
  await writeFile(toolExamplesJsonPath, toolExamplesJson, 'utf8');

  process.stdout.write(
    `Wrote ${catalogJsonPath}\nWrote ${chatTxtPath} (${String(chat.length)} chars)\nWrote ${consultTxtPath} (${String(consult.length)} chars)\nWrote ${toolsChatJsonPath} (${String(toolsChat.length)} tools)\nWrote ${toolsConsultJsonPath} (${String(toolsConsult.length)} tools)\nWrote ${toolExamplesJsonPath} (${String(toolExamples.length)} examples)\n`,
  );
}

await main();
