import { describe, expect, it } from 'vitest';

import { collectFileReferences } from './references.js';
import { aPage, prose } from './site.test-helper.js';

describe('collectFileReferences', () => {
  it('finds body images and nix-file properties, once each, and ignores outside URLs', () => {
    const page = aPage({
      itemId: 'p',
      path: '/',
      properties: {
        cover: 'nix-file:f2',
        link: 'https://x.test/a.png',
        note: 'nix-file:../../etc',
      },
    });
    const body = prose(
      { type: 'image', attrs: { fileItemId: 'f1' } },
      { type: 'paragraph', content: [{ type: 'image', attrs: { fileItemId: 'f1' } }] },
    );
    expect(collectFileReferences([page], new Map([['p', body]]))).toEqual([
      { pageItemId: 'p', fileItemId: 'f1', kind: 'embed' },
      { pageItemId: 'p', fileItemId: 'f2', kind: 'embed' },
    ]);
  });

  it('finds captured Mermaid pictures, and only on Mermaid code blocks', () => {
    const page = aPage({ itemId: 'p', path: '/' });
    const body = prose(
      { type: 'codeBlock', attrs: { language: 'Mermaid', renderFileId: 'd1' } },
      { type: 'codeBlock', attrs: { language: 'ts', renderFileId: 'd2' } },
    );
    expect(collectFileReferences([page], new Map([['p', body]]))).toEqual([
      { pageItemId: 'p', fileItemId: 'd1', kind: 'embed' },
    ]);
  });

  it('asks about linked blocks and references that are not pages, and file lists in properties', () => {
    const page = aPage({ itemId: 'p', path: '/', properties: { files: ['nix-file:f3', 7] } });
    const other = aPage({ itemId: 'q', path: '/q/', parentItemId: 'p' });
    const body = prose(
      { type: 'itemBlock', attrs: { targetId: 'f1', presentation: 'attachment' } },
      { type: 'itemBlock', attrs: { targetId: 'q' } },
      {
        type: 'paragraph',
        content: [
          { type: 'reference', attrs: { targetId: 'f2', kind: 'item', label: 'cv.pdf' } },
          { type: 'reference', attrs: { targetId: 'u1', kind: 'user', label: 'Ada' } },
        ],
      },
    );
    expect(collectFileReferences([page, other], new Map([['p', body]]))).toEqual([
      { pageItemId: 'p', fileItemId: 'f1', kind: 'link' },
      { pageItemId: 'p', fileItemId: 'f2', kind: 'link' },
      { pageItemId: 'p', fileItemId: 'f3', kind: 'embed' },
    ]);
  });
});
