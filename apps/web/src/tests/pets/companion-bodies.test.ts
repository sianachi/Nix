import { describe, expect, it, vi } from 'vitest';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';
import { nixSchema } from '@nix/editor-schema';
import type { NixClient } from '@nix/api-client';
import { createCompanionBodies } from '../../pets/companion-bodies';

const itemId = '22222222-2222-4222-8222-222222222222';
function encode(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}
describe('companion note bodies', () => {
  it('appends content while preserving the existing rich body', async () => {
    const original = new Y.Doc();
    prosemirrorJSONToYXmlFragment(
      nixSchema,
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Keep this', marks: [{ type: 'bold' }] }],
          },
        ],
      },
      original.getXmlFragment('default'),
    );
    const query = vi.fn().mockResolvedValue({
      hasMore: false,
      updates: [{ seq: '1', update: encode(Y.encodeStateAsUpdate(original)) }],
    });
    const execute = vi.fn().mockImplementation((endpoint: { body: { update: string } }) => {
      Y.applyUpdate(
        original,
        Uint8Array.from(atob(endpoint.body.update), (char) => char.charCodeAt(0)),
      );
      return Promise.resolve({ seq: '2' });
    });
    const bodies = createCompanionBodies({ query, execute } as unknown as NixClient);
    await bodies.append(itemId, 'Added by the pet', new AbortController().signal);
    const json = yXmlFragmentToProseMirrorRootNode(
      original.getXmlFragment('default'),
      nixSchema,
    ).toJSON() as { content: unknown[] };
    expect(json.content).toHaveLength(2);
    expect(json.content[0]).toMatchObject({
      content: [{ text: 'Keep this', marks: [{ type: 'bold' }] }],
    });
    expect(JSON.stringify(json.content[1])).toContain('Added by the pet');
    original.destroy();
  });
  it('refuses incomplete history instead of writing over an uncertain base', async () => {
    const query = vi.fn().mockResolvedValue({ hasMore: true, updates: [] });
    const execute = vi.fn();
    const bodies = createCompanionBodies({ query, execute } as unknown as NixClient);
    await expect(bodies.append(itemId, 'New text', new AbortController().signal)).rejects.toThrow(
      'incomplete',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
