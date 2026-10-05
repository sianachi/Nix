import type { NixClient } from '@nix/api-client';

/** `runWorkspaceTool` never reads the wall clock directly, so a fixed fake can
 * stand in for it in tests. (`CompanionBodies.append` still calls
 * `crypto.randomUUID()` for its own idempotency key; that is unrelated to the
 * executor's id port and is not yet routed through `CompanionIds`.) */
export interface CompanionClock {
  today(): string;
  timeZone(): string;
  now(): Date;
}

export interface CompanionIds {
  uuid(): string;
}

export interface CompanionBodies {
  read(itemId: string, signal: AbortSignal): Promise<unknown>;
  append(itemId: string, markdown: string, signal: AbortSignal): Promise<unknown>;
}

/** Everything the executor touches outside its own pure logic, gathered so a
 * caller supplies exactly one object and a test supplies exactly one fake. */
export interface CompanionPorts {
  core: NixClient;
  collab: NixClient;
  bodies: CompanionBodies;
  clock: CompanionClock;
  ids: CompanionIds;
}

export function defaultClock(): CompanionClock {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    today() {
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    },
    timeZone() {
      return timeZone;
    },
    now() {
      return new Date();
    },
  };
}

export function defaultIds(): CompanionIds {
  return {
    uuid() {
      return crypto.randomUUID();
    },
  };
}
