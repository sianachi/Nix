import { useState } from 'react';

/** What the one polite announcer says: each finished reply once (its first 160 characters, never a
 * draft or a token), and a wait for approval. History already on screen when the chat opens is not read. */
export function useReplyAnnouncer({
  messages,
  petName,
  ready,
  approvalPending,
}: {
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }[];
  readonly petName: string;
  readonly ready: boolean;
  readonly approvalPending: boolean;
}): string {
  const [state, setState] = useState<{
    seen: string | null | undefined;
    approval: boolean;
    text: string;
  }>({ seen: undefined, approval: false, text: '' });
  const last = messages.findLast(
    (message) => message.role === 'assistant' && !message.id.includes(':draft:'),
  );
  // Adjusted during render, not in an effect: the announcement is derived from what just changed.
  if (ready && (state.seen === undefined || state.seen !== (last?.id ?? null))) {
    setState({
      seen: last?.id ?? null,
      approval: state.approval,
      text:
        state.seen === undefined || !last ? state.text : `${petName}: ${last.text.slice(0, 160)}`,
    });
  } else if (approvalPending !== state.approval) {
    setState({
      ...state,
      approval: approvalPending,
      text: approvalPending ? `${petName} is waiting for your approval` : state.text,
    });
  }
  return state.text;
}
