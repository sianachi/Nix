import { z } from 'zod';

/**
 * The copy of a recording that survives the tab.
 *
 * A meeting is recorded for an hour and uploaded once, at the end, so a crash, a reload or a
 * closed lid in between would otherwise lose all of it. Each slice the recorder produces is
 * written here as it arrives, under the session it belongs to, and the session is discarded only
 * after the upload is confirmed. What is left behind by a tab that died is offered back the next
 * time the workspace opens.
 *
 * This is a safety net and never the recorder's own source: the store keeps its slices in memory
 * and finishes from those, so storage that is full, blocked or absent costs the recovery and not
 * the recording.
 */

const DB = 'nix-recordings';
const SESSIONS = 'sessions';
const CHUNKS = 'chunks';

const sessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /**
   * Whose recording it is. A session is only ever offered back to the person who made it: the
   * spool is cleared on sign-out, but a session that expired or a cleanup that failed must not
   * leave one person's meeting on offer to the next person at this device.
   */
  principalId: z.string(),
  startedAt: z.number(),
  /** The recorder's own type string, kept so recovered slices are reassembled as what they are. */
  mimeType: z.string(),
  /** Recorded time written so far, in milliseconds; a recovered file's length. */
  durationMs: z.number().nonnegative(),
  /**
   * Whether the microphone and the shared audio are on separate channels, which is what lets a
   * transcript tell the person from everybody else. False for a session spooled before this was
   * recorded.
   */
  twoChannels: z.boolean().default(false),
});
export type SpooledSession = z.infer<typeof sessionSchema>;

// Bytes, not the Blob the recorder hands over: a buffer is stored the same way by every browser,
// where a stored Blob has been a reference that some of them lose.
const chunkSchema = z.object({
  sessionId: z.string(),
  index: z.number().int().nonnegative(),
  // By tag rather than `instanceof`: a buffer read back from storage can belong to another realm.
  bytes: z.custom<ArrayBuffer>(
    (value) => Object.prototype.toString.call(value) === '[object ArrayBuffer]',
  ),
});

export interface RecordingSpool {
  begin(session: SpooledSession): Promise<void>;
  append(session: SpooledSession, index: number, blob: Blob): Promise<void>;
  sessions(workspaceId: string, principalId: string): Promise<SpooledSession[]>;
  read(sessionId: string): Promise<Blob[]>;
  discard(sessionId: string): Promise<void>;
}

let database: Promise<IDBDatabase> | undefined;
/**
 * Sessions let go in this tab, and a count of the times everything was. A slice is read before it
 * is written, so one already on its way when its session is discarded would otherwise write the
 * session back and leave a recording nobody made on offer as "interrupted".
 */
const discarded = new Set<string>();
let cleared = 0;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SESSIONS, { keyPath: 'id' });
      request.result.createObjectStore(CHUNKS, { keyPath: ['sessionId', 'index'] });
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Recording storage could not be opened.'));
    };
    request.onblocked = () => {
      reject(new Error('Recording storage is blocked.'));
    };
  });
  // A failed open is not remembered, so a later recording can try again.
  database.catch(() => {
    database = undefined;
  });
  return database;
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, done: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SESSIONS, CHUNKS], mode);
    let result: T;
    tx.oncomplete = () => {
      resolve(result);
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('Recording storage failed.'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('Recording storage aborted.'));
    };
    run(tx, (value) => {
      result = value;
    });
  });
}

function chunkRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
}

export const browserRecordingSpool: RecordingSpool = {
  async begin(session) {
    await transaction<undefined>('readwrite', (tx, done) => {
      tx.objectStore(SESSIONS).put(session);
      done(undefined);
    });
  },

  async append(session, index, blob) {
    // Read before the transaction opens: one left idle across an await closes itself.
    const before = cleared;
    const bytes = await blob.arrayBuffer();
    if (before !== cleared || discarded.has(session.id)) return;
    await transaction<undefined>('readwrite', (tx, done) => {
      tx.objectStore(CHUNKS).put({ sessionId: session.id, index, bytes });
      // The session's length moves with its slices, so a recovered file knows how long it is.
      tx.objectStore(SESSIONS).put(session);
      done(undefined);
    });
  },

  async sessions(workspaceId, principalId) {
    return transaction('readonly', (tx, done) => {
      const request = tx.objectStore(SESSIONS).getAll();
      request.onsuccess = () => {
        const all: unknown[] = request.result;
        done(
          all
            .map((entry) => sessionSchema.safeParse(entry))
            .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
            .filter(
              (session) =>
                session.workspaceId === workspaceId && session.principalId === principalId,
            )
            .sort((a, b) => a.startedAt - b.startedAt),
        );
      };
    });
  },

  async read(sessionId) {
    return transaction('readonly', (tx, done) => {
      const request = tx.objectStore(CHUNKS).getAll(chunkRange(sessionId));
      request.onsuccess = () => {
        const chunks = z.array(chunkSchema).safeParse(request.result);
        done(chunks.success ? chunks.data.map((chunk) => new Blob([chunk.bytes])) : []);
      };
    });
  },

  async discard(sessionId) {
    discarded.add(sessionId);
    await transaction<undefined>('readwrite', (tx, done) => {
      tx.objectStore(SESSIONS).delete(sessionId);
      tx.objectStore(CHUNKS).delete(chunkRange(sessionId));
      done(undefined);
    });
  },
};

/** Forgets every spooled recording on this device. Called when the person signs out. */
export async function clearRecordingSpool(): Promise<void> {
  cleared += 1;
  if (typeof indexedDB === 'undefined') return;
  await transaction<undefined>('readwrite', (tx, done) => {
    tx.objectStore(SESSIONS).clear();
    tx.objectStore(CHUNKS).clear();
    done(undefined);
  });
}
