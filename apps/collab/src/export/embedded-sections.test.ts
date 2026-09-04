import { describe, expect, it, vi } from 'vitest';
import { expandEmbeddedSections } from './embedded-sections.ts';
const id = '00000000-0000-4000-8000-000000000001';
const embed = { type: 'itemBlock', attrs: { targetId: id, presentation: 'embed' } };
const body = { schemaVersion: 4, prosemirror: { type: 'doc', content: [embed] } };
describe('embedded export sections', () => {
  it.each(['embed', 'subpage'])(
    'includes a %s snapshot without rewriting durable content or recursively expanding cycles',
    async (presentation) => {
      const body = {
        schemaVersion: 4,
        prosemirror: {
          type: 'doc',
          content: [{ ...embed, attrs: { ...embed.attrs, presentation } }],
        },
      };
      const resolve = vi.fn(() => Promise.resolve({ title: 'Source', body }));
      const output = await expandEmbeddedSections(body, resolve);
      expect(resolve).toHaveBeenCalledExactlyOnceWith(id);
      expect(output !== null && 'prosemirror' in output ? output.prosemirror : null).toMatchObject({
        content: [
          {
            type: 'details',
            content: [
              { type: 'detailsSummary', content: [{ text: 'Source' }] },
              { type: 'detailsContent', content: body.prosemirror.content },
            ],
          },
        ],
      });
      expect(body.prosemirror.content[0]?.attrs.presentation).toBe(presentation);
    },
  );
  it('never fabricates content or labels for an unavailable source', async () => {
    const output = await expandEmbeddedSections(body, () => Promise.resolve(null));
    expect(JSON.stringify(output)).toContain('outside the authorized export scope');
    expect(JSON.stringify(output)).not.toContain(id);
  });
  it('bounds repeated embeds and reports omitted sections', async () => {
    const resolve = vi.fn(() => Promise.resolve({ title: 'Source', body: null }));
    const output = await expandEmbeddedSections(
      { ...body, prosemirror: { type: 'doc', content: Array.from({ length: 102 }, () => embed) } },
      resolve,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output)).toContain('export section limit reached');
  });
});
