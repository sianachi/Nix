import type { ReactElement } from 'react';

import { LockDialog } from './lock-dialog';
import { LockedBody } from './locked-body';

export default { title: 'Nix/Locks', parameters: { layout: 'fullscreen' } };

const refuseWrongPassword = (password: string): Promise<string | null> =>
  Promise.resolve(password === 'hunter22' ? null : 'That password is not right.');

const noop = (): void => undefined;
const accept = (): Promise<string | null> => Promise.resolve(null);
const done = (): Promise<string | null> => Promise.resolve(null);

/** Where a locked body would be: the prompt that stands in for it. */
export function LockedNote(): ReactElement {
  return (
    <div className="flex h-96">
      <LockedBody title="Diary" noun="note" onUnlock={refuseWrongPassword} />
    </div>
  );
}

/** A note with no lock can only be locked. */
export function LockAnUnlockedNote(): ReactElement {
  return (
    <LockDialog
      title="Diary"
      noun="note"
      locked={false}
      onClose={noop}
      onSetLock={accept}
      onRemoveLock={accept}
      onRelock={done}
    />
  );
}

/** A locked note that is open here: lock it again now, change the password, or remove the lock. */
export function ManageAnOpenLock(): ReactElement {
  return (
    <LockDialog
      title="Diary"
      noun="note"
      locked
      onClose={noop}
      onSetLock={accept}
      onRemoveLock={accept}
      onRelock={done}
    />
  );
}

/** The prompt after the fifteen minutes ran out while somebody was reading. */
export function LockedAgainAfterExpiry(): ReactElement {
  return (
    <div className="flex h-96">
      <LockedBody title="Diary" noun="note" reason="expired" onUnlock={refuseWrongPassword} />
    </div>
  );
}

/** A canvas says canvas, not note. */
export function LockedCanvas(): ReactElement {
  return (
    <div className="flex h-96">
      <LockedBody title="Floor plan" noun="canvas" onUnlock={refuseWrongPassword} />
    </div>
  );
}
