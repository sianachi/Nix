import * as Y from 'yjs';

/**
 * The document body's transport: post what you typed, poll for what everyone else did.
 *
 * **Local edits apply to the document immediately.** The network is catch-up, never the thing
 * between a keystroke and the screen - a person typing must never wait for a round trip, and with
 * a CRDT underneath they never have to, because the merge is correct whenever the bytes arrive.
 *
 * **Polling is a transport, not a design.** A WebSocket, presence and live cursors arrive later
 * and carry the same update payloads to the same append-only log; nothing about the data changes,
 * only how quickly it moves. Saying "seconds, not instant" in the interface is therefore honest
 * now and stays true after the upgrade, which is why the save indicator below distinguishes
 * *pending* from *saved* rather than claiming either.
 *
 * The client identifier is per tab and per document. It is not identity - the server records the
 * principal from the token - it is what lets a client recognise its own updates coming back and
 * skip re-applying what it already has.
 */

export type SyncState = 'connecting' | 'synced' | 'pending' | 'offline';

export interface CollabSyncOptions {
  readonly itemId: string;
  readonly doc: Y.Doc;
  readonly fragmentName: string;
  readonly getAccessToken: () => Promise<string | null>;
  readonly onState: (state: SyncState) => void;
  /** How often to ask for remote updates. */
  readonly pollMs?: number;
  /** How long to wait after a keystroke before posting. */
  readonly debounceMs?: number;
  readonly baseUrl?: string;
  /**
   * The fetch used for every request. Narrower than `typeof fetch` on purpose: this module only
   * ever calls it with a string URL, and saying so lets a test supply a stub without a cast.
   */
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface UpdateEnvelope {
  readonly seq: string;
  readonly clientId: string;
  readonly update: string;
}

interface CatchUpResponse {
  readonly docId: string;
  readonly headSeq: string;
  readonly updates: UpdateEnvelope[];
  readonly hasMore: boolean;
}

export interface CollabSync {
  /** Stops polling and posts anything still buffered. */
  destroy: () => void;
}

const DEFAULT_BASE_URL = '/collab';

export function startCollabSync(options: CollabSyncOptions): CollabSync {
  const {
    itemId,
    doc,
    getAccessToken,
    onState,
    pollMs = 2_000,
    debounceMs = 400,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  } = options;

  const clientId = crypto.randomUUID();
  let lastSeq = 0n;
  let destroyed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  // Updates produced locally since the last post, kept as bytes rather than merged into one:
  // merging would need a second Y.Doc, and posting them in order costs nothing.
  let pending: Uint8Array[] = [];

  async function authorized(path: string, init?: RequestInit): Promise<Response> {
    const token = await getAccessToken();
    return fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
    });
  }

  async function catchUp(): Promise<void> {
    const response = await authorized(`/documents/${itemId}/updates?after=${lastSeq.toString()}`);

    if (!response.ok) {
      onState('offline');
      return;
    }

    const page = (await response.json()) as CatchUpResponse;

    // One transaction for the whole page, so the editor re-renders once rather than once per
    // update - the difference between smooth and visibly stuttering on a long catch-up.
    Y.transact(
      doc,
      () => {
        for (const envelope of page.updates) {
          if (envelope.clientId === clientId) {
            // Already applied locally the moment it was typed. Re-applying is harmless with a
            // CRDT, but skipping it avoids a pointless render.
            lastSeq = BigInt(envelope.seq);
            continue;
          }

          Y.applyUpdate(doc, base64ToBytes(envelope.update), REMOTE_ORIGIN);
          lastSeq = BigInt(envelope.seq);
        }
      },
      REMOTE_ORIGIN,
    );

    onState(pending.length === 0 ? 'synced' : 'pending');
  }

  async function flush(): Promise<void> {
    if (pending.length === 0) {
      return;
    }

    const batch = pending;
    pending = [];

    for (let index = 0; index < batch.length; index += 1) {
      const update = batch[index];
      if (update === undefined) {
        continue;
      }

      const response = await authorized(`/documents/${itemId}/updates`, {
        method: 'POST',
        body: JSON.stringify({ update: bytesToBase64(update), clientId }),
      });

      if (!response.ok) {
        // Everything from here on goes back to the front of the queue, in order, and is tried
        // again on the next tick. Dropping it would lose an edit the person has already seen
        // applied on their own screen, which is the one outcome this whole design exists to
        // prevent. Order matters because a later update can reference an earlier one.
        pending = [...batch.slice(index), ...pending];
        onState('offline');
        return;
      }
    }

    onState(pending.length === 0 ? 'synced' : 'pending');
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
    }

    flushTimer = setTimeout(() => {
      void flush();
    }, debounceMs);
  }

  function onLocalUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === REMOTE_ORIGIN) {
      return;
    }

    pending.push(update);
    onState('pending');
    scheduleFlush();
  }

  doc.on('update', onLocalUpdate);

  function tick(): void {
    if (destroyed) {
      return;
    }

    void catchUp().finally(() => {
      if (!destroyed) {
        pollTimer = setTimeout(tick, pollMs);
      }
    });
  }

  onState('connecting');
  tick();

  return {
    destroy(): void {
      destroyed = true;
      doc.off('update', onLocalUpdate);

      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
      }

      // A last attempt on the way out. It is not a guarantee - a closing tab may not finish it -
      // which is exactly why the indicator says "pending" until the server has confirmed.
      void flush();
    },
  };
}

/**
 * Marks updates that came from the server, so the local handler does not post them straight back.
 *
 * A symbol rather than a string: origins are compared by identity, and a string could collide with
 * one some other plugin chose.
 */
const REMOTE_ORIGIN = Symbol('nix.collab.remote');

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
