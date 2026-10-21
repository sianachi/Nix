import { Text } from '@nix/ui';
import { EMPTY_MARKDOWN_IMPORT_SCAN } from '@nix/markdown/scan';
import type { ReactNode } from 'react';

import { affectedPathsClause } from './import-format';
import type { PlannedNode } from './import-plan';

export function containers(node: PlannedNode): number {
  let total = node.kind === 'container' ? 1 : 0;
  for (const child of node.children) {
    total += containers(child);
  }
  return total;
}

export interface ContentChangeSource {
  readonly path: string;
  readonly scan: PlannedNode['scan'];
  readonly droppedFrontMatter: readonly string[];
  readonly bodyError?: string;
}

export function planSources(node: PlannedNode | null): readonly ContentChangeSource[] {
  const sources: ContentChangeSource[] = [];
  if (node !== null) {
    collectPlanSources(node, sources);
  }
  return sources;
}

export function collectPlanSources(node: PlannedNode, sources: ContentChangeSource[]): void {
  sources.push(node);
  for (const child of node.children) {
    collectPlanSources(child, sources);
  }
}

export function contentChangeCount(sources: readonly ContentChangeSource[]): number {
  return sources.reduce(
    (total, source) =>
      total +
      effectiveScan(source).unresolvedWikiLinks +
      effectiveScan(source).unresolvedObsidianEmbeds +
      effectiveScan(source).unresolvedLocalImages +
      effectiveScan(source).unsupportedImageAddresses +
      effectiveScan(source).inlineImagesFlattened +
      source.droppedFrontMatter.length,
    0,
  );
}

export function ContentChanges({
  sources,
  mode,
}: {
  readonly sources: readonly ContentChangeSource[];
  readonly mode: 'preview' | 'receipt';
}): ReactNode {
  const messages = contentChangeMessages(sources, mode);
  if (messages.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="import-content-changes-heading" className="flex flex-col gap-2">
      <Text id="import-content-changes-heading" variant="h6" as="h3">
        {mode === 'preview' ? 'Review before importing' : 'Changes in imported content'}
      </Text>
      <ul className="flex flex-col gap-2">
        {messages.map((message) => (
          <li key={message}>
            <Text variant="note" tone="muted">
              {message}
            </Text>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function effectiveScan(source: ContentChangeSource): PlannedNode['scan'] {
  return source.bodyError === undefined ? source.scan : EMPTY_MARKDOWN_IMPORT_SCAN;
}

export function contentChangeMessages(
  sources: readonly ContentChangeSource[],
  mode: 'preview' | 'receipt',
): readonly string[] {
  const messages: string[] = [];
  const add = (
    read: (source: ContentChangeSource) => number,
    sentence: (count: number) => string,
  ) => {
    const count = sources.reduce((total, source) => total + read(source), 0);
    if (count === 0) {
      return;
    }
    const paths = sources.filter((source) => read(source) > 0).map((source) => source.path);
    messages.push(`${sentence(count)} Affected files: ${affectedPathsClause(paths)}.`);
  };

  add(
    (source) => effectiveScan(source).unresolvedWikiLinks,
    (count) =>
      mode === 'preview'
        ? `${String(count)} wiki ${count === 1 ? 'link will' : 'links will'} stay as text and will not open another note.`
        : `${String(count)} wiki ${count === 1 ? 'link stayed' : 'links stayed'} as text and ${count === 1 ? 'does' : 'do'} not open another note.`,
  );
  add(
    (source) => effectiveScan(source).unresolvedObsidianEmbeds,
    (count) =>
      mode === 'preview'
        ? `${String(count)} Obsidian ${count === 1 ? 'embed will' : 'embeds will'} stay as ![[...]] text; ${count === 1 ? 'the linked note or file will' : 'their linked notes or files will'} not be embedded.`
        : `${String(count)} Obsidian ${count === 1 ? 'embed was' : 'embeds were'} kept as ![[...]] text; ${count === 1 ? 'the linked note or file was' : 'their linked notes or files were'} not embedded.`,
  );
  add(
    (source) => effectiveScan(source).unresolvedLocalImages,
    (count) =>
      mode === 'preview'
        ? `${String(count)} local picture ${count === 1 ? 'path will be kept, but its picture file will not be copied, so it will' : 'paths will be kept, but picture files will not be copied, so they will'} not display in Nix.`
        : `${String(count)} local picture ${count === 1 ? 'path was kept, but its picture file was not copied, so it does' : 'paths were kept, but picture files were not copied, so they do'} not display in Nix.`,
  );
  add(
    (source) => effectiveScan(source).unsupportedImageAddresses,
    (count) =>
      mode === 'preview'
        ? `${String(count)} picture ${count === 1 ? 'address cannot' : 'addresses cannot'} be displayed safely; readable source text will be kept.`
        : `${String(count)} picture ${count === 1 ? 'address could' : 'addresses could'} not be displayed safely; readable source text was kept.`,
  );
  add(
    (source) => effectiveScan(source).inlineImagesFlattened,
    (count) =>
      mode === 'preview'
        ? `${String(count)} inline ${count === 1 ? 'picture will' : 'pictures will'} no longer display as ${count === 1 ? 'a picture' : 'pictures'}; ${count === 1 ? 'its link or readable text will be' : 'their links or readable text will be'} kept.`
        : `${String(count)} inline ${count === 1 ? 'picture no longer displays' : 'pictures no longer display'} as ${count === 1 ? 'a picture' : 'pictures'}; ${count === 1 ? 'its link or readable text was' : 'their links or readable text were'} kept.`,
  );
  add(
    (source) => source.droppedFrontMatter.length,
    (count) =>
      mode === 'preview'
        ? `${String(count)} unsupported front matter ${count === 1 ? 'line will' : 'lines will'} be left out.`
        : `${String(count)} unsupported front matter ${count === 1 ? 'line was' : 'lines were'} left out.`,
  );
  return messages;
}
