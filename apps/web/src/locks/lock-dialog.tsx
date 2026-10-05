import { Button, Dialog, Field, Input, Text } from '@nix/ui';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';

/**
 * Setting, changing and removing an item's lock, in one dialog.
 *
 * **Which form it shows follows from the lock, not from a menu.** An unlocked item can only be
 * locked; a locked one that is open here can be locked again now, have its password changed, or
 * have its lock removed. Offering "remove" on an item with no lock would be a control that can only
 * fail.
 *
 * **Every change needs the password that is in force.** The server enforces it; the form asks for
 * it up front so the refusal is never a surprise.
 *
 * **It says what a lock costs before it is set.** A locked body leaves search and cannot be
 * exported, and a forgotten password cannot be recovered from here. Somebody who finds that out
 * afterwards concludes search is broken, or that their note is gone.
 *
 * Focus is placed deliberately, because the forms replace one another inside one dialog: a form
 * focuses its first field when it opens, a validation error focuses the field it is about, and
 * cancelling back to the menu returns focus to the button that opened the form.
 */

export interface LockDialogProps {
  readonly title: string;

  /** What kind of thing is locked - "note", "canvas" - for the copy. */
  readonly noun: string;

  /** Whether the item is locked now. An unlocked item offers only "lock". */
  readonly locked: boolean;

  readonly onClose: () => void;
  readonly onSetLock: (password: string, currentPassword?: string) => Promise<string | null>;
  readonly onRemoveLock: (password: string) => Promise<string | null>;
  readonly onRelock: () => Promise<string | null>;
}

type Mode = 'lock' | 'change' | 'remove';

const MINIMUM_LENGTH = 4;
const MAXIMUM_LENGTH = 256;

export function LockDialog(props: LockDialogProps): ReactNode {
  const { title, noun, locked, onClose, onSetLock, onRemoveLock, onRelock } = props;
  const [mode, setMode] = useState<Mode | null>(locked ? null : 'lock');
  const [returnTo, setReturnTo] = useState<'change' | 'remove' | null>(null);
  const name = title.length > 0 ? title : 'Untitled';

  // For an unlocked item the dialog is one field's worth of purpose, so it opens on that field.
  // Handed to the dialog rather than focused by the form, because the dialog places its own
  // initial focus after its children mount.
  const firstFieldRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open
      title={locked ? 'Lock settings' : `Lock ${name}`}
      onClose={onClose}
      {...(locked ? {} : { initialFocus: firstFieldRef })}
    >
      {mode === null ? (
        <LockMenu
          noun={noun}
          returnTo={returnTo}
          onRelock={onRelock}
          onClose={onClose}
          onChoose={(chosen) => {
            setMode(chosen);
          }}
        />
      ) : (
        <LockForm
          mode={mode}
          noun={noun}
          onCancel={
            locked
              ? () => {
                  setReturnTo(mode === 'lock' ? null : mode);
                  setMode(null);
                }
              : onClose
          }
          onDone={onClose}
          passwordRef={firstFieldRef}
          onSetLock={onSetLock}
          onRemoveLock={onRemoveLock}
        />
      )}
    </Dialog>
  );
}

interface LockMenuProps {
  readonly noun: string;
  readonly returnTo: 'change' | 'remove' | null;
  readonly onRelock: () => Promise<string | null>;
  readonly onClose: () => void;
  readonly onChoose: (mode: 'change' | 'remove') => void;
}

function LockMenu({ noun, returnTo, onRelock, onClose, onChoose }: LockMenuProps): ReactNode {
  const changeRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back from a form: focus the button that opened it, not whatever the dialog lands on first.
  useEffect(() => {
    if (returnTo === 'change') changeRef.current?.focus();
    if (returnTo === 'remove') removeRef.current?.focus();
  }, [returnTo]);

  async function relock(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const refused = await onRelock();
    setBusy(false);
    if (refused === null) {
      onClose();
    } else {
      setError(refused);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Text variant="note" tone="muted">
        This {noun} is locked and open in this browser. Lock it again to close it now.
      </Text>
      {error === null ? null : (
        <Text variant="note" role="alert">
          {error}
        </Text>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            void relock();
          }}
        >
          {busy ? 'Locking…' : 'Lock now'}
        </Button>
        <Button
          ref={changeRef}
          variant="secondary"
          disabled={busy}
          onClick={() => {
            onChoose('change');
          }}
        >
          Change password
        </Button>
        <Button
          ref={removeRef}
          variant="secondary"
          disabled={busy}
          onClick={() => {
            onChoose('remove');
          }}
        >
          Remove lock
        </Button>
      </div>
    </div>
  );
}

interface LockFormProps {
  readonly mode: Mode;
  readonly noun: string;
  readonly onCancel: () => void;
  readonly onDone: () => void;

  /** The new-password field, which the dialog focuses when the form is all it holds. */
  readonly passwordRef: RefObject<HTMLInputElement | null>;
  readonly onSetLock: LockDialogProps['onSetLock'];
  readonly onRemoveLock: LockDialogProps['onRemoveLock'];
}

type FieldName = 'current' | 'password' | 'confirm';

function LockForm(props: LockFormProps): ReactNode {
  const { mode, noun, onCancel, onDone, passwordRef, onSetLock, onRemoveLock } = props;
  const currentRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<{ field: FieldName; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const needsCurrent = mode !== 'lock';
  const needsNew = mode !== 'remove';

  function refFor(field: FieldName) {
    return field === 'current' ? currentRef : field === 'password' ? passwordRef : confirmRef;
  }

  // The form replaced the menu inside an open dialog; its first field is where somebody starts.
  useEffect(() => {
    (needsCurrent ? currentRef : passwordRef).current?.focus();
  }, [needsCurrent, passwordRef]);

  function refuse(field: FieldName, message: string): void {
    setError({ field, message });
    refFor(field).current?.focus();
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;

    if (needsCurrent && current.length === 0) {
      refuse('current', 'Enter the current password.');
      return;
    }
    if (needsNew && (password.length < MINIMUM_LENGTH || password.length > MAXIMUM_LENGTH)) {
      refuse(
        'password',
        `Use a password of ${String(MINIMUM_LENGTH)} to ${String(MAXIMUM_LENGTH)} characters.`,
      );
      return;
    }
    if (needsNew && password !== confirm) {
      refuse('confirm', 'The two passwords do not match.');
      return;
    }

    setBusy(true);
    const refused =
      mode === 'remove'
        ? await onRemoveLock(current)
        : await onSetLock(password, mode === 'change' ? current : undefined);
    setBusy(false);

    if (refused !== null) {
      refuse(needsCurrent ? 'current' : 'password', refused);
      return;
    }
    onDone();
  }

  const submitLabel =
    mode === 'lock' ? `Lock ${noun}` : mode === 'change' ? 'Change password' : 'Remove lock';

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {mode === 'lock' ? (
        <>
          <Text variant="note" tone="muted">
            Anyone who opens this {noun} will need the password to read it, including you in another
            browser. Its title and properties stay visible. While it is locked, its text does not
            appear in search and it cannot be exported. The lock hides the text; it is not
            encryption, so whoever runs this Nix server can still read it.
          </Text>
          <Text variant="note">
            If the password is forgotten, nobody can open this {noun} or remove the lock here.
          </Text>
        </>
      ) : (
        <Text variant="note" tone="muted">
          {mode === 'change'
            ? `Other browsers that have this ${noun} open will need the new password.`
            : `Anyone who can see this ${noun} will be able to read it again, and it will return to search.`}
        </Text>
      )}

      {needsCurrent ? (
        <Field label="Current password" error={error?.field === 'current' ? error.message : null}>
          {(control) => (
            <Input
              {...control}
              ref={currentRef}
              type="password"
              autoComplete="current-password"
              readOnly={busy}
              value={current}
              onChange={(event) => {
                setCurrent(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
      ) : null}

      {needsNew ? (
        <>
          <Field
            label={mode === 'change' ? 'New password' : 'Password'}
            hint={`${String(MINIMUM_LENGTH)} to ${String(MAXIMUM_LENGTH)} characters.`}
            error={error?.field === 'password' ? error.message : null}
          >
            {(control) => (
              <Input
                {...control}
                ref={passwordRef}
                type="password"
                autoComplete="new-password"
                readOnly={busy}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
          <Field label="Confirm password" error={error?.field === 'confirm' ? error.message : null}>
            {(control) => (
              <Input
                {...control}
                ref={confirmRef}
                type="password"
                autoComplete="new-password"
                readOnly={busy}
                value={confirm}
                onChange={(event) => {
                  setConfirm(event.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
        </>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
