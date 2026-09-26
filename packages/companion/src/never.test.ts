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
      expect(source, file).not.toMatch(forbidden);
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
