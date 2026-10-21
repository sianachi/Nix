import { type PetProfile, type PetSettings } from '@nix/api-client';
import { Button, ContextMenu, Icon, Menu, Select, Text, focusRing, type MenuEntry } from '@nix/ui';
import { MoreHorizontal, X } from 'lucide-react';
import { type ReactElement, type RefObject } from 'react';
import { Link } from 'react-router';
import { PetAvatar, type PetAnimationState } from '../../pet-avatar';
import { TitleEditor } from '../../pet-history';

function renderMenuLink({
  href,
  children,
  ...rest
}: Parameters<NonNullable<Parameters<typeof Menu>[0]['renderLink']>>[0]): ReactElement {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

export function ConversationHeader({
  layout,
  zen,
  workspaceId,
  petName,
  appearance,
  motion,
  animation,
  status,
  title,
  renaming,
  renameBusy,
  renameError,
  onRename,
  onCancelRename,
  menuItems,
  menuTrigger,
  onClose,
  noteScope,
  locked,
}: {
  readonly layout: string;
  readonly zen: boolean;
  readonly workspaceId: string;
  readonly petName: string;
  readonly appearance: PetProfile['appearance'];
  readonly motion: PetSettings['motion'];
  readonly animation: PetAnimationState;
  readonly status: string;
  readonly title: string | undefined;
  readonly renaming: boolean;
  readonly renameBusy: boolean;
  readonly renameError: string;
  readonly onRename: (title: string) => void;
  readonly onCancelRename: () => void;
  readonly menuItems: MenuEntry[];
  readonly menuTrigger: RefObject<{ current: HTMLButtonElement | null } | null>;
  readonly onClose: (() => void) | undefined;
  readonly noteScope:
    | {
        readonly rootItemId: string;
        readonly title: string;
        readonly readOnly: boolean;
        readonly onReadOnlyChange: (readOnly: boolean) => void;
      }
    | undefined;
  /** A turn is running: the note access cannot change. */
  readonly locked: boolean;
}): ReactElement {
  return (
    <ContextMenu label="Conversation actions" items={menuItems} renderLink={renderMenuLink}>
      {(target) => (
        <div
          {...target}
          className={`flex shrink-0 select-none flex-col gap-2 border-b border-divider bg-surface p-3 @sm:px-4 ${layout === 'page' && zen ? 'pr-16 @sm:pr-16' : ''}`}
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="hidden shrink-0 @md:block">
                <PetAvatar
                  appearance={appearance}
                  motion={motion}
                  state={animation}
                  label={`${petName}: ${animation}`}
                  size="compact"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <Text variant="h5" as="h2" title={petName} truncate>
                  {petName}
                </Text>
                <Text role="status" variant="note" tone="muted" truncate>
                  {status}
                </Text>
                {title && !renaming ? (
                  <Text variant="note" truncate title={title}>
                    {title}
                  </Text>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Menu label="Conversation actions" items={menuItems} renderLink={renderMenuLink}>
                {(trigger) => {
                  menuTrigger.current = trigger.ref;
                  return (
                    <Button {...trigger} variant="icon" aria-label="More conversation actions">
                      <Icon icon={MoreHorizontal} size="sm" />
                    </Button>
                  );
                }}
              </Menu>
              {onClose ? (
                <Button
                  data-context-menu-ignore
                  variant="icon"
                  aria-label="Close"
                  onClick={onClose}
                >
                  <Icon icon={X} size="sm" />
                </Button>
              ) : null}
            </div>
          </div>
          {renaming ? (
            <div data-context-menu-ignore className="flex min-w-0 flex-col gap-1">
              <TitleEditor
                initial={title ?? ''}
                busy={renameBusy}
                onSave={onRename}
                onCancel={onCancelRename}
              />
              {renameError ? <Text role="alert">{renameError}</Text> : null}
            </div>
          ) : null}
          {noteScope ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Link
                to={`/w/${workspaceId}?item=${noteScope.rootItemId}`}
                className={`min-w-0 truncate underline ${focusRing}`}
              >
                <Text as="span" variant="note" truncate>
                  {noteScope.title}
                </Text>
              </Link>
              <Select
                aria-label="Note chat access"
                value={noteScope.readOnly ? 'read' : 'edit'}
                disabled={locked}
                className="min-w-0 max-w-full"
                title="Reads this note and its readable children on demand. Every change asks first."
                onChange={(event) => {
                  noteScope.onReadOnlyChange(event.currentTarget.value === 'read');
                }}
              >
                <option value="read">Read only</option>
                <option value="edit">Approved edits</option>
              </Select>
              <Text variant="note" tone="muted" className="hidden @md:block">
                Reads this note and its readable children on demand. Search and results can be
                partial. Every change asks first.
              </Text>
            </div>
          ) : null}
        </div>
      )}
    </ContextMenu>
  );
}
