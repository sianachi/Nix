import { describe, expect, it } from 'vitest';
import { renderSite } from './render.js';
import { aManifest, aPage, listViews } from './site.test-helper.js';

describe('published chat transcripts', () => {
  it('publishes adjacent storage chunks as one full message', () => {
    const beginning = 'x'.repeat(3000);
    const result = renderSite({
      manifest: aManifest({ pageCount: 3 }),
      pages: [
        aPage({ itemId: 'root', path: '/', views: listViews('chat') }),
        aPage({
          itemId: 'part0',
          path: '/part0/',
          parentItemId: 'root',
          ordinal: 1,
          properties: {
            chat_role: 'assistant',
            chat_message_id: 'long',
            chat_part: 0,
            chat_text: beginning,
          },
        }),
        aPage({
          itemId: 'part1',
          path: '/part1/',
          parentItemId: 'root',
          ordinal: 2,
          properties: {
            chat_role: 'assistant',
            chat_message_id: 'long',
            chat_part: 1,
            chat_text: '<ending>',
          },
        }),
      ],
      bodies: new Map(),
      assets: new Map(),
    });
    const html = new TextDecoder().decode(
      result.files.find((file) => file.path === 'index.html')?.bytes,
    );
    expect(html).toContain(`<p>${beginning}&lt;ending&gt;</p>`);
    expect(html.match(/<strong>assistant<\/strong>/g)).toHaveLength(1);
  });

  it('publishes full escaped messages in child order without a composer', () => {
    const result = renderSite({
      manifest: aManifest({ pageCount: 3 }),
      pages: [
        aPage({ itemId: 'root', path: '/', views: listViews('chat') }),
        aPage({
          itemId: 'm1',
          path: '/m1/',
          parentItemId: 'root',
          ordinal: 1,
          properties: { chat_role: 'user', chat_text: 'Question <script>bad</script>' },
        }),
        aPage({
          itemId: 'm2',
          path: '/m2/',
          parentItemId: 'root',
          ordinal: 2,
          properties: { chat_role: 'assistant', chat_text: 'Complete response\nSecond paragraph' },
        }),
      ],
      bodies: new Map(),
      assets: new Map(),
    });
    const home = result.files.find((file) => file.path === 'index.html');
    const html = new TextDecoder().decode(home?.bytes);
    expect(html).toContain('Question &lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('Complete response');
    expect(html).toContain('Second paragraph');
    expect(html.indexOf('Question &lt;')).toBeLessThan(html.indexOf('Complete response'));
    expect(html).not.toContain('<textarea');
    expect(result.loss).toEqual([]);
  });
});
