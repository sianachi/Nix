import { createHash } from 'node:crypto';

import { createLossReport } from '@nix/export';
import { describe, expect, it } from 'vitest';

import { safeHref } from './html/escape.js';
import { renderProse, type ProseContext } from './html/prose.js';

const DIAGRAM = 'graph TD\n  accTitle: Release flow\n  A-->B';
const DIAGRAM_SHA = createHash('sha256').update(DIAGRAM).digest('hex');

const context: ProseContext = {
  pathOf: (id) => (id === 'published' ? '/a/' : null),
  titleOf: (id) => (id === 'published' ? 'Page A' : null),
  asset: (id) => (id === 'img' ? { url: '/_nix/assets/abc.png', width: 10, height: 5 } : null),
  diagram: (id, sha) =>
    id === 'svg' && sha === DIAGRAM_SHA
      ? { url: '/_nix/assets/def.svg', width: 80, height: 40 }
      : null,
  download: (id) =>
    id === 'cv'
      ? { url: '/_nix/files/abc/CV.pdf', name: 'CV.pdf', label: 'PDF, 84 KB', isVideo: false }
      : id === 'clip'
        ? { url: '/_nix/files/abc/clip.mp4', name: 'clip.mp4', label: 'MP4, 2 MB', isVideo: true }
        : null,
};

function render(...content: unknown[]) {
  const report = createLossReport();
  const rendered = renderProse({ type: 'doc', content }, 'item', report, context);
  return { ...rendered, loss: report.entries() };
}

const text = (value: string, marks: unknown[] = []) => ({ type: 'text', text: value, marks });

describe('renderProse', () => {
  it('escapes script in text', () => {
    const { html } = render({ type: 'paragraph', content: [text('<script>alert(1)</script>')] });
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes attributes and refuses javascript: links', () => {
    const { html, loss } = render(
      {
        type: 'paragraph',
        content: [text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])],
      },
      {
        type: 'paragraph',
        content: [text('y', [{ type: 'link', attrs: { href: 'https://a.test/?q="><b>' } }])],
      },
      { type: 'image', attrs: { fileItemId: 'img', alt: '" onerror="x' } },
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://a.test/?q=&quot;&gt;&lt;b&gt;"');
    expect(html).toContain('alt="&quot; onerror=&quot;x"');
    expect(loss.map((entry) => entry.kind)).toContain('reference-flattened');
  });

  it.each([
    ['java\tscript:alert(1)', null],
    [' JAVASCRIPT:alert(1)', null],
    ['data:text/html,x', null],
    ['//evil.test', null],
    ['mailto:a@b.test', 'mailto:a@b.test'],
    ['/local/', '/local/'],
    ['#here', '#here'],
  ])('safeHref(%j)', (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });

  it('gives headings unique anchors, starting at h2', () => {
    const heading = { type: 'heading', attrs: { level: 1 }, content: [text('Set up')] };
    const { html, headings } = render(heading, heading);
    expect(headings.map((entry) => entry.id)).toEqual(['set-up', 'set-up-2']);
    expect(html).toContain('<h2 id="set-up">');
  });

  it('highlights known languages and reports Mermaid', () => {
    const { html, loss } = render(
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = "<b>";')] },
      { type: 'codeBlock', attrs: { language: 'mermaid' }, content: [text('graph LR')] },
    );
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('graph LR');
    expect(loss.map((entry) => entry.kind)).toContain('image-not-embedded');
  });

  it('renders a fence named after an Object property as escaped text', () => {
    for (const language of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { html } = render({
        type: 'codeBlock',
        attrs: { language },
        content: [text('const a = "<b>";')],
      });
      expect(html).toContain('const a = &quot;&lt;b&gt;&quot;;');
      expect(html).not.toContain('hljs-keyword');
    }
  });

  it('publishes a captured Mermaid picture with its source, and falls back when stale', () => {
    const block = (source: string, renderFileId: string | null) => ({
      type: 'codeBlock',
      attrs: { language: 'mermaid', renderFileId },
      content: [text(source)],
    });
    const fresh = render(block(DIAGRAM, 'svg'));
    expect(fresh.loss).toEqual([]);
    expect(fresh.html).toContain(
      '<figure class="nix-figure nix-diagram"><img src="/_nix/assets/def.svg" alt="Diagram: Release flow" width="80" height="40"',
    );
    expect(fresh.html).toContain('<summary>Diagram source</summary>');
    expect(fresh.html).toContain('A--&gt;B');

    const stale = render(block(`${DIAGRAM}\n  B-->C`, 'svg'));
    expect(stale.html).not.toContain('<img');
    expect(stale.html).toContain('nix-notice');
    expect(stale.loss[0]?.detail).toMatch(/changed after its picture was captured/);
  });

  it('links references on the site and flattens the rest', () => {
    const { html, loss } = render({
      type: 'paragraph',
      content: [
        { type: 'reference', attrs: { targetId: 'published', label: 'A' } },
        { type: 'reference', attrs: { targetId: 'hidden', label: 'Secret plan' } },
      ],
    });
    expect(html).toContain('<a class="nix-ref" href="/a/">A</a>');
    expect(html).not.toContain('hidden');
    expect(loss).toHaveLength(1);
  });

  it('turns an embed of an unpublished item into a notice and never names it', () => {
    const { html, loss } = render({ type: 'itemBlock', attrs: { targetId: 'hidden' } });
    expect(html).toContain('nix-notice');
    expect(loss[0]?.kind).toBe('reference-flattened');
  });

  it('records unknown nodes rather than dropping them silently', () => {
    const { loss } = render({ type: 'pluginBlock', content: [] });
    expect(loss[0]?.kind).toBe('unknown-node');
  });

  it('publishes outside images as links only', () => {
    const { html } = render({ type: 'image', attrs: { src: 'https://cdn.test/a.png', alt: 'A' } });
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://cdn.test/a.png"');
  });

  it('links attached files as downloads, from a file block and an inline reference', () => {
    const { html, loss } = render(
      { type: 'itemBlock', attrs: { targetId: 'cv', presentation: 'attachment' } },
      {
        type: 'paragraph',
        content: [
          text('Read '),
          { type: 'reference', attrs: { targetId: 'cv', kind: 'item', label: 'my CV' } },
        ],
      },
    );
    expect(html).toBe(
      '<p class="nix-file"><a class="nix-file-link" href="/_nix/files/abc/CV.pdf">CV.pdf</a><span class="nix-file-meta">PDF, 84 KB</span></p>\n<p>Read <a class="nix-ref" href="/_nix/files/abc/CV.pdf">my CV</a></p>',
    );
    expect(loss).toEqual([]);
  });

  it('plays an attached video in a player, with the download link under it', () => {
    const { html } = render({
      type: 'itemBlock',
      attrs: { targetId: 'clip', presentation: 'attachment' },
    });
    expect(html).toBe(
      '<figure class="nix-video"><video controls preload="metadata" src="/_nix/files/abc/clip.mp4"></video><figcaption><a class="nix-file-link" href="/_nix/files/abc/clip.mp4">clip.mp4</a><span class="nix-file-meta">MP4, 2 MB</span></figcaption></figure>',
    );
  });

  it('cuts its summary from body blocks, never joining a heading to the next paragraph', () => {
    const { summary } = render(
      { type: 'heading', attrs: { level: 1 }, content: [text('Overview')] },
      { type: 'paragraph', content: [text('First words.')] },
      { type: 'codeBlock', content: [text('x = 1')] },
      { type: 'heading', attrs: { level: 2 }, content: [text('Next')] },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('Item')] }] }],
      },
    );
    expect(summary).toBe('First words. Item');
  });
});
