import { describe, expect, it } from 'vitest';
import { conversationSchema, createConversationInputSchema } from './conversations.js';
import * as conversations from '../resources/conversations.js';
const id = '11111111-1111-4111-8111-111111111111';
describe('conversation boundaries', () => {
  it('keeps permission capabilities separate from source availability', () => {
    const value = conversationSchema.parse({
      itemId: id,
      workspaceId: id,
      title: 'Research',
      sourceWorkspaceIds: [id],
      petId: id,
      revision: 2,
      canEdit: true,
      canSend: false,
      turn: null,
    });
    expect(value.canEdit).toBe(true);
    expect(value.canSend).toBe(false);
  });
  it('requires a pet, explicit destination and a nonempty source selection', () => {
    expect(
      createConversationInputSchema.safeParse({
        title: 'Research',
        parentId: null,
        sourceWorkspaceIds: [],
        petId: id,
      }).success,
    ).toBe(false);
    expect(
      createConversationInputSchema.parse({
        title: 'Research',
        parentId: null,
        sourceWorkspaceIds: [id],
        petId: id,
      }).parentId,
    ).toBeNull();
  });
  it('carries request identity and revision to Core without provider session data', () => {
    expect(conversations.send(id, { requestId: id, text: 'Compare priorities' }).body).toEqual({
      requestId: id,
      text: 'Compare priorities',
    });
    expect(conversations.sources(id, [id], 3).body).toEqual({
      sourceWorkspaceIds: [id],
      expectedRevision: 3,
    });
    expect(
      conversations.importTranscript(id, {
        title: 'Saved',
        parentId: null,
        petId: id,
        sourceWorkspaceIds: [id],
        messages: [{ role: 'assistant', text: 'An insight' }],
      }).path,
    ).toBe(`/api/v1/workspaces/${id}/conversations/import`);
  });
});
