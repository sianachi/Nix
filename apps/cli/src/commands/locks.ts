/**
 * `nixctl item lock`: an item's password lock, read and managed.
 *
 * A lock withholds an item's body from every session that has not presented the password recently;
 * it does not encrypt what is stored. An unlock belongs to the credential that asked - here, the
 * profile's access token - so unlocking from the command line opens the body to this profile and
 * nowhere else, and only for as long as Core says (`unlockedUntil`).
 *
 * Passwords are read from stdin, never from an argument: an argument is visible to every process
 * list and lands in shell history.
 */

import { locks } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/**
 * Prints whether the item is locked and, if this profile has it open, until when. A lock covers
 * its subtree, so `lockItemId` says which item's password opens this one - an ancestor's when
 * `selfLocked` is false - and that is the id to pass to `unlock`.
 */
export async function lockStatus(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const state = await session.client.query(locks.getItemLock(itemId), { forceRefresh: true });
  printResult(
    {
      id: itemId,
      locked: state.locked,
      unlockedUntil: state.unlockedUntil,
      lockItemId: state.lockItemId,
      selfLocked: state.selfLocked,
    },
    output,
  );
}

/** Locks an item, or changes the password when `currentPassword` is given. */
export async function setLock(
  profileName: string | undefined,
  itemId: string,
  password: string,
  currentPassword: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(locks.setItemLock(itemId, password, currentPassword));
  printResult({ id: itemId, locked: true, changed: currentPassword !== undefined }, output);
}

/** Removes an item's lock. */
export async function removeLock(
  profileName: string | undefined,
  itemId: string,
  password: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(locks.removeItemLock(itemId, password));
  printResult({ id: itemId, locked: false }, output);
}

/** Opens a locked body to this profile's token for a while. */
export async function openLock(
  profileName: string | undefined,
  itemId: string,
  password: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const result = await session.client.execute(locks.unlockItem(itemId, password));
  printResult({ id: itemId, unlockedUntil: result.unlockedUntil }, output);
}

/** Closes a locked body to this profile's token again. */
export async function closeLock(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  await session.client.execute(locks.relockItem(itemId));
  printResult({ id: itemId, unlockedUntil: null }, output);
}

/**
 * Splits what was piped to a lock command into its passwords, one per line.
 *
 * Only the final line break is dropped, so a password may carry any other whitespace it was set
 * with. `expected` is how many lines the command needs: two for a change (current, then new), one
 * otherwise.
 */
export function readPasswords(stdin: string, expected: 1 | 2): readonly string[] {
  const lines = stdin.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== expected || lines.some((line) => line.length === 0)) {
    throw new Error(
      expected === 1
        ? 'Pipe the password on stdin, on one line.'
        : 'Pipe the current password and then the new one on stdin, one per line.',
    );
  }
  return lines;
}
