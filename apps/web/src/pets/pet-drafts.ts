import { useSyncExternalStore } from 'react';
import { type PetConversationMode } from './device-preferences';

// The unsent message, per workspace, pet and mode. Module-level so it survives the conversation
// moving between the floating panel and the page (each mounts its own `Conversation`). In memory
// only, on purpose: it is an unfinished message rather than a document, so it is never written to
// storage and a reload dropping it is the intended end of its life.
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function draftKey(workspaceId: string, petId: string, mode: PetConversationMode): string {
  return `${workspaceId}:${petId}:${mode}`;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function writeDraft(key: string, next: string): void {
  if (next === (drafts.get(key) ?? '')) return;
  if (next === '') drafts.delete(key);
  else drafts.set(key, next);
  listeners.forEach((listener) => {
    listener();
  });
}

export function usePetDraft(
  workspaceId: string,
  petId: string,
  mode: PetConversationMode,
): readonly [string, (next: string) => void] {
  const key = draftKey(workspaceId, petId, mode);
  const draft = useSyncExternalStore(
    subscribe,
    () => drafts.get(key) ?? '',
    () => '',
  );
  return [
    draft,
    (next) => {
      writeDraft(key, next);
    },
  ];
}

/** Unsent messages belong to the outgoing account, including on shared workspaces. */
export function clearPetDrafts(): void {
  drafts.clear();
  listeners.forEach((listener) => {
    listener();
  });
}
