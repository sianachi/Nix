import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : entry.isFile() && path.endsWith('.ts')
          ? [path]
          : [];
    }),
  );
  return nested.flat();
}

describe('pet executor never-operation guard', () => {
  it('does not reference forbidden endpoints or publish a form', async () => {
    const files = await sourceFiles(new URL('.', import.meta.url).pathname);
    const forbidden =
      /\b(?:setItemSchema|setContainerViews|publicLink|purgeItem|clearRecurrence|checkIn|undoCheckIn)\b|publishInteractiveFormViewId\s*:(?!\s*null\b)\s*\S+/;
    for (const file of files) {
      if (file === new URL(import.meta.url).pathname) continue;
      const source = await readFile(file, 'utf8');
      if (file.endsWith('/blueprint/build.ts')) {
        // A blueprint may set the schema only on a node created earlier in this build.
        // The executor resolves nodeId from its local ledger; it rejects external itemIds.
        expect(source).toMatch(/structure\.setItemSchema\(targetId/);
        expect(source).toMatch(/nodeItems\.get\(raw\.target\.nodeId\)/);
        expect(source.replace('setItemSchema', ''), file).not.toMatch(forbidden);
      } else if (file.endsWith('/structure/update-view.ts')) {
        // A strict settings patch compiles the complete current view set in the same order.
        // The shared run loop fences every setting; the compiler cannot remove or create a view.
        expect(source).toMatch(/compileUpdateView\(spec, context\)/);
        expect(source).toMatch(/!step\.viewUpdate/);
        expect(source).toMatch(/step\.schema\.properties\.length > 0/);
        expect(source.replace('setContainerViews', ''), file).not.toMatch(forbidden);
      } else {
        expect(source, file).not.toMatch(forbidden);
      }
    }
  });

  it('only replaces a view setup with an empty original property key set', async () => {
    const files = await sourceFiles(new URL('.', import.meta.url).pathname);
    const callers: { file: string; source: string }[] = [];
    for (const file of files) {
      if (file.endsWith('.test.ts')) continue;
      const source = await readFile(file, 'utf8');
      if (source.includes('.replaceViewSetup(')) callers.push({ file, source });
    }
    expect(callers).toHaveLength(1);
    expect(callers[0]?.file).toMatch(/structure\/edit-form\.ts$/);
    expect(callers[0]?.source).toMatch(/originalPropertyKeys:\s*\[\]/);
  });
});
