import { Button, Icon, Listbox, Text, Textarea } from '@nix/ui';
import { ArrowUp, FilePlus, Square, TextQuote } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type RefObject } from 'react';
import { MAX_CONTEXTS, type SharedContext } from '../state/use-message-context';
import { composerRows } from './composer-rows';
import { ContextChips } from './context-chips';
import { type useSlashMenu } from './use-slash-menu';

export function Composer({
  petName,
  input,
  draft,
  onDraftChange,
  touchLikeComposer,
  slash,
  onSubmit,
  onInterrupt,
  running,
  canSend,
  chips,
  onRemoveChip,
  needsWorkspaceAccess,
  onTurnOnWorkspaceAccess,
  workspaceAccess,
  hasNoteScope,
  noteReadOnly,
  onToggleWorkspaceAccess,
  applyWithoutAsking,
  applyToggle,
  onApplyChange,
  hasPage,
  contextCount,
  hasSelection,
  onAttachPage,
  onShareSelection,
}: {
  readonly petName: string;
  readonly input: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly touchLikeComposer: boolean;
  readonly slash: ReturnType<typeof useSlashMenu>;
  readonly onSubmit: () => void;
  readonly onInterrupt: () => void;
  readonly running: boolean;
  readonly canSend: boolean;
  readonly chips: readonly SharedContext[];
  readonly onRemoveChip: (context: SharedContext) => void;
  readonly needsWorkspaceAccess: boolean;
  readonly onTurnOnWorkspaceAccess: () => void;
  readonly workspaceAccess: boolean;
  readonly hasNoteScope: boolean;
  readonly noteReadOnly: boolean;
  readonly onToggleWorkspaceAccess: () => void;
  readonly applyWithoutAsking: boolean;
  readonly applyToggle: RefObject<HTMLButtonElement | null>;
  readonly onApplyChange: (on: boolean) => void;
  readonly hasPage: boolean;
  readonly contextCount: number;
  readonly hasSelection: boolean;
  readonly onAttachPage: () => void;
  readonly onShareSelection: () => void;
}): ReactElement {
  const { options: slashOptions, listbox: slashListbox } = slash;

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // An IME's confirming Enter or arrow is the IME's, not the menu's.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (slashOptions.length > 0 && !composing) {
      if (event.key === 'Tab') {
        // Hide the menu before focus moves, so Tab leaves the field instead of entering the list.
        slash.dismiss();
        return;
      }
      if (event.key === 'Escape') {
        // The menu is the innermost layer, so the conversation behind it stays open.
        event.preventDefault();
        event.stopPropagation();
        slash.dismiss();
        return;
      }
      slashListbox.onKeyDown(event);
      if (event.defaultPrevented) return;
    }
    // Must-fix 18: an IME composition's confirming Enter arrives as `keyCode === 229` on some
    // browsers without `isComposing` also being set - both are checked so it is never mistaken
    // for a real submit.
    // `keyCode` is deprecated but is the only signal some browsers give for an IME's confirming
    // Enter once `isComposing` has already gone false.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.shiftKey || touchLikeComposer) return;
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="mx-auto flex min-w-0 w-full max-h-[50%] max-w-4xl shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-t border-divider p-3">
      <ContextChips chips={chips} onRemove={onRemoveChip} />
      {needsWorkspaceAccess ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-divider bg-surface px-3 py-2">
          <Text variant="note">{petName} needs workspace access for this.</Text>
          <Button variant="secondary" onClick={onTurnOnWorkspaceAccess}>
            Turn on
          </Button>
        </div>
      ) : null}
      {applyWithoutAsking ? (
        // Not a live region: the toggle's own pressed state already announces the change,
        // and a region that appears with its text already in it is read unreliably.
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-divider bg-accent/15 px-3 py-2">
          <Text variant="note">
            Applying changes without asking in this conversation. Moves, trash, template saves and
            external links still ask.
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              onApplyChange(false);
              // The banner goes with this button, so focus returns to the toggle it mirrors.
              applyToggle.current?.focus();
            }}
          >
            Turn off
          </Button>
        </div>
      ) : null}
      {slashOptions.length > 0 ? (
        <div className="flex max-h-48 shrink-0 flex-col overflow-y-auto rounded border border-divider bg-background">
          <Listbox
            label="Actions"
            options={slashOptions}
            controller={slashListbox}
            emptyMessage="No matching actions"
          />
        </div>
      ) : null}
      <label htmlFor="pet-message" className="sr-only">
        Message {petName}
      </label>
      <div className="flex min-w-0 items-end gap-2">
        <Textarea
          id="pet-message"
          ref={input}
          rows={composerRows(draft)}
          maxLength={8000}
          value={draft}
          placeholder={`Message ${petName}`}
          enterKeyHint={touchLikeComposer ? undefined : 'send'}
          resize="none"
          className="min-w-0 max-h-32 flex-1 @sm:max-h-48"
          onChange={(event) => {
            onDraftChange(event.currentTarget.value);
          }}
          aria-controls={slashOptions.length > 0 ? slashListbox.id : undefined}
          aria-activedescendant={slashOptions.length > 0 ? slashListbox.activeOptionId : undefined}
          onBlur={() => {
            if (slashOptions.length > 0) slash.dismiss();
          }}
          onKeyDown={onComposerKeyDown}
        />
        {running ? (
          <Button
            variant="icon"
            className="shrink-0"
            aria-label="Stop response"
            onClick={onInterrupt}
          >
            <Icon icon={Square} size="sm" />
          </Button>
        ) : (
          <Button
            variant="icon"
            className="shrink-0"
            aria-label="Send"
            disabled={!canSend}
            onClick={onSubmit}
          >
            <Icon icon={ArrowUp} size="sm" />
          </Button>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {!hasNoteScope ? (
          <Button
            variant="ghost"
            className={`shrink-0 ${workspaceAccess ? 'bg-accent/15 text-accent-text' : ''}`}
            aria-pressed={workspaceAccess}
            aria-describedby="pet-workspace-access-hint"
            disabled={running}
            onClick={onToggleWorkspaceAccess}
          >
            Workspace access
          </Button>
        ) : null}
        <Text as="span" variant="note" className="sr-only" id="pet-workspace-access-hint">
          Lets {petName} find and read your notes for this message. Changes ask first unless you
          turn on applying without asking.
        </Text>
        {workspaceAccess && !noteReadOnly ? (
          <>
            <Button
              ref={applyToggle}
              variant="ghost"
              className={`shrink-0 ${applyWithoutAsking ? 'bg-accent/15 text-accent-text' : ''}`}
              aria-pressed={applyWithoutAsking}
              aria-describedby="pet-apply-without-asking-hint"
              onClick={() => {
                onApplyChange(!applyWithoutAsking);
              }}
            >
              Apply without asking
            </Button>
            <Text as="span" variant="note" className="sr-only" id="pet-apply-without-asking-hint">
              Runs {petName}'s changes in this conversation once their preview shows no problems,
              using your Nix permissions. Trash, moves, template saves and external links still ask.
              Changes with problems go back to {petName} to fix. Each conversation starts from the
              pet's saved default in Settings.
            </Text>
          </>
        ) : null}
        <Button
          variant="icon"
          className="shrink-0"
          aria-label="Add this page to the message"
          disabled={!hasPage || contextCount >= MAX_CONTEXTS}
          onClick={onAttachPage}
        >
          <Icon icon={FilePlus} size="sm" />
        </Button>
        <Button
          variant="icon"
          className="shrink-0"
          aria-label={hasSelection ? 'Share selected text' : 'Select text on the page first'}
          disabled={!hasPage || !hasSelection || contextCount >= MAX_CONTEXTS}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={onShareSelection}
        >
          <Icon icon={TextQuote} size="sm" />
        </Button>
      </div>
    </div>
  );
}
