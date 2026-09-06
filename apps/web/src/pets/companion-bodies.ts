import { companionBodies, type CompanionBodies, type NixClient } from '@nix/api-client';
import { nixSchema } from '@nix/editor-schema';
import { documentToMarkdown, markdownToDocument } from '@nix/markdown';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';

export function createCompanionBodies(client: NixClient): CompanionBodies {
  async function load(itemId: string, signal: AbortSignal) {
    const doc = new Y.Doc();
    let after = '0';
    let bytes = 0;
    try {
      for (let count = 0; count < 64; count++) {
        const page = await client.query(companionBodies.bodyUpdates(itemId, after), {
          signal,
          forceRefresh: true,
        });
        for (const entry of page.updates) {
          bytes += entry.update.length;
          if (bytes > 4 * 1024 * 1024 || BigInt(entry.seq) <= BigInt(after))
            throw new Error('This note exceeds the companion reading limit.');
          Y.applyUpdate(
            doc,
            Uint8Array.from(atob(entry.update), (char) => char.charCodeAt(0)),
          );
          after = entry.seq;
        }
        if (!page.hasMore) return doc;
        if (!page.updates.length) throw new Error('The note history is incomplete.');
      }
      throw new Error('This note has too much history for the companion.');
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }
  return {
    async read(itemId, signal) {
      const doc = await load(itemId, signal);
      try {
        const content = documentToMarkdown(
          yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('default'), nixSchema).toJSON(),
        );
        return {
          markdown: content.markdown.slice(0, 14000),
          losses: content.losses,
          truncated: content.markdown.length > 14000,
        };
      } finally {
        doc.destroy();
      }
    },
    async append(itemId, markdown, signal) {
      if (!markdown.trim() || markdown.length > 16000)
        throw new Error('Provide up to 16,000 characters of Markdown.');
      const parsed = markdownToDocument(markdown);
      if (!parsed.ok) throw new Error('The proposed Markdown is invalid.');
      const doc = await load(itemId, signal);
      const added = new Y.Doc();
      try {
        const fragment = doc.getXmlFragment('default');
        const incoming = prosemirrorJSONToYXmlFragment(
          nixSchema,
          parsed.doc,
          added.getXmlFragment('default'),
        );
        const before = Y.encodeStateVector(doc);
        // Append cloned blocks only: never reserialize or replace the user's existing rich content.
        const blocks = incoming.toArray().map((node) => {
          if (!(node instanceof Y.XmlElement) && !(node instanceof Y.XmlText))
            throw new Error('Unsupported note block.');
          return node.clone();
        });
        doc.transact(() => {
          fragment.insert(fragment.length, blocks);
        });
        const delta = Y.encodeStateAsUpdate(doc, before);
        let binary = '';
        for (const byte of delta) binary += String.fromCharCode(byte);
        await client.execute(
          companionBodies.appendBodyUpdate(itemId, btoa(binary), `pet-${crypto.randomUUID()}`),
          { signal },
        );
        return { id: itemId, appended: true, markdownChanges: parsed.scan };
      } finally {
        doc.destroy();
        added.destroy();
      }
    },
  };
}
