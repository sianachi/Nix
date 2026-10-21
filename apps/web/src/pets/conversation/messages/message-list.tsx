import { type PetConnection, type PetProfile, type PetSettings } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { Pencil, RefreshCw } from 'lucide-react';
import { type ReactElement } from 'react';
import { type NixClient } from '@nix/api-client';
import { type ProgramPiece } from '../../../openui/fence';
import { PetAvatar } from '../../pet-avatar';
import { PetChatViewport } from '../../pet-chat-viewport';
import { PetWorkTools } from '../../pet-work-tools';
import { PetEmptyState } from './empty-state';
import { PetMessageEditor } from './message-editor';
import { PetMessageRow } from './message-row';
import { toolInsertIndex } from './tool-insert-index';

type Message = NonNullable<PetConnection['messages']>[number];

export function MessageList({
  client,
  workspaceId,
  pet,
  settings,
  runtime,
  messages,
  piecesBefore,
  running,
  busy,
  hasDraft,
  approvalPending,
  workspaceAccess,
  suggestions,
  onPick,
  onAsk,
  setRuntime,
  reportNeedsDecision,
  applyWithoutAsking,
  applyExemptToolIds,
  noteScope,
  editing,
  setEditing,
  enterToSend,
  resendTurn,
  retryLastTurn,
  onSaveInsight,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly runtime: PetConnection;
  readonly messages: readonly Message[];
  readonly piecesBefore: readonly (readonly ProgramPiece[] | undefined)[];
  readonly running: boolean;
  readonly busy: boolean;
  readonly hasDraft: boolean;
  readonly approvalPending: boolean;
  readonly workspaceAccess: boolean;
  readonly suggestions: readonly string[];
  readonly onPick: (suggestion: string) => void;
  readonly onAsk: (text: string) => void;
  readonly setRuntime: (runtime: PetConnection) => void;
  readonly reportNeedsDecision: (toolIds: readonly string[]) => void;
  readonly applyWithoutAsking: boolean;
  readonly applyExemptToolIds: readonly string[];
  readonly noteScope:
    { readonly rootItemId: string; readonly title: string; readonly readOnly: boolean } | undefined;
  readonly editing: { readonly id: string; readonly text: string } | null;
  readonly setEditing: (value: { readonly id: string; readonly text: string } | null) => void;
  readonly enterToSend: boolean;
  readonly resendTurn: (text: string, replaceFromMessageId: string) => unknown;
  readonly retryLastTurn: () => void;
  readonly onSaveInsight: (text: string) => void;
}): ReactElement {
  const tools = (
    <PetWorkTools
      client={client}
      runtime={runtime}
      workspaceId={workspaceId}
      petId={pet.id}
      petName={pet.name}
      onChange={setRuntime}
      onNeedsDecisionChange={reportNeedsDecision}
      applyWithoutAsking={applyWithoutAsking}
      applyExemptToolIds={applyExemptToolIds}
      noteScope={noteScope}
    />
  );
  return (
    <PetChatViewport
      latestKey={`${messages.at(-1)?.id ?? ''}:${runtime.tools?.at(-1)?.id ?? ''}:${running ? 'thinking' : 'idle'}`}
    >
      {runtime.state === 'error' ? (
        <div className="flex items-center justify-between gap-2">
          <Text role="alert">{runtime.reason || 'The response did not finish. Try again.'}</Text>
          <Button variant="ghost" onClick={retryLastTurn}>
            Try again
          </Button>
        </div>
      ) : null}
      {messages.length === 0 ? (
        <>
          <PetEmptyState
            petName={pet.name}
            workspaceAccess={workspaceAccess}
            suggestions={suggestions}
            onPick={onPick}
          />
          {tools}
        </>
      ) : (
        (() => {
          const splitAt = toolInsertIndex(messages);
          // Only the last turn can be redone: its user message and the reply after it.
          const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
          const lastReplyIndex = messages.findIndex(
            (message, index) =>
              index > lastUserIndex &&
              message.id === `${messages[lastUserIndex]?.id ?? ''}:assistant`,
          );
          const idle = !running && !busy;
          const row = (message: Message, index: number) => {
            const edit = editing?.id === message.id ? editing : null;
            return (
              <div key={message.id} className="flex flex-col gap-2">
                <PetMessageRow
                  key={message.id}
                  message={message}
                  petName={pet.name}
                  workspaceId={workspaceId}
                  latest={index === messages.length - 1}
                  onAsk={onAsk}
                  applyWithoutAsking={applyWithoutAsking}
                  earlierPieces={piecesBefore[index]}
                  followsLockedRead={runtime.lockedRead}
                  noteScope={noteScope}
                  editor={
                    edit ? (
                      <PetMessageEditor
                        text={edit.text}
                        enterToSend={enterToSend}
                        busy={running || busy}
                        onChange={(text) => {
                          setEditing({ id: message.id, text });
                        }}
                        onSend={() => {
                          setEditing(null);
                          void resendTurn(edit.text, message.id);
                        }}
                        onCancel={() => {
                          setEditing(null);
                        }}
                      />
                    ) : undefined
                  }
                  action={
                    !idle || edit
                      ? undefined
                      : index === lastUserIndex
                        ? {
                            label: 'Edit',
                            icon: Pencil,
                            onClick: () => {
                              setEditing({ id: message.id, text: message.text });
                            },
                          }
                        : index === lastReplyIndex
                          ? { label: 'Regenerate', icon: RefreshCw, onClick: retryLastTurn }
                          : undefined
                  }
                />
                {message.role === 'assistant' && idle ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      onSaveInsight(message.text);
                    }}
                  >
                    Save insight as note
                  </Button>
                ) : null}
              </div>
            );
          };
          return (
            <>
              {messages.slice(0, splitAt).map((message, index) => row(message, index))}
              {tools}
              {messages.slice(splitAt).map((message, offset) => row(message, splitAt + offset))}
            </>
          );
        })()
      )}
      {running && !hasDraft && !approvalPending ? (
        // The pet itself, in its thinking pose: the avatar owns the motion preference and
        // shows a still frame under reduced motion. The header status carries the label.
        <div className="flex items-center gap-2" aria-hidden="true">
          <PetAvatar
            appearance={pet.appearance}
            motion={settings.motion}
            state="thinking"
            label={`${pet.name}: thinking`}
            size="compact"
          />
          <Text variant="note" tone="muted">
            {pet.name} is thinking
          </Text>
        </div>
      ) : null}
    </PetChatViewport>
  );
}
