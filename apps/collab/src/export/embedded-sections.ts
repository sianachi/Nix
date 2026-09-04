import type { ItemBody } from '@nix/export';

/** Conversion-only projection. Source bodies never become children or durable parent content. */
export async function expandEmbeddedSections(
  body: ItemBody | null,
  resolve: (
    targetId: string,
  ) => Promise<{ readonly title: string; readonly body: ItemBody | null } | null>,
): Promise<ItemBody | null> {
  if (body === null || !('prosemirror' in body)) return body;
  let remaining = 100;
  let remainingBytes = 8 * 1024 * 1024;
  const sources = new Map<string, Awaited<ReturnType<typeof resolve>>>();
  const text = (value: string): unknown => ({
    type: 'paragraph',
    content: [{ type: 'text', text: value }],
  });
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const visit = async (node: unknown, depth: number): Promise<unknown> => {
    if (!record(node)) return node;
    if (depth > 100) throw new Error('Embedded section nesting exceeds the export limit.');
    const attrs = record(node.attrs) ? node.attrs : {};
    if (
      node.type === 'itemBlock' &&
      (attrs.presentation === 'embed' || attrs.presentation === 'subpage')
    ) {
      if (--remaining < 0 || remainingBytes < 0)
        return text('Embedded note omitted: export section limit reached.');
      const id = attrs.targetId;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
        return text('Embedded note unavailable.');
      if (!sources.has(id)) sources.set(id, await resolve(id));
      const source = sources.get(id);
      if (source === null || source === undefined)
        return text('Embedded note unavailable or outside the authorized export scope.');
      const prose =
        source.body !== null && 'prosemirror' in source.body ? source.body.prosemirror : null;
      const content = record(prose) && Array.isArray(prose.content) ? prose.content : [];
      remainingBytes -= Buffer.byteLength(JSON.stringify(content));
      if (remainingBytes < 0) return text('Embedded note omitted: export content limit reached.');
      // Do not recurse into the source: deeper embeds remain source links, including cycles.
      return {
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: source.title || 'Untitled' }] },
          { type: 'detailsContent', content: content.length > 0 ? content : [text('Empty note.')] },
        ],
      };
    }
    if (!Array.isArray(node.content)) return node;
    const content: unknown[] = [];
    for (const child of node.content) content.push(await visit(child, depth + 1));
    return { ...node, content };
  };
  return { ...body, prosemirror: await visit(body.prosemirror, 0) };
}
