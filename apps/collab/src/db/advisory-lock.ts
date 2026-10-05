import { Client } from 'pg';

/**
 * Per-document ownership claims, held as Postgres session-level advisory locks.
 *
 * A resident document must live on exactly one process: two instances each holding a
 * `Y.Doc` for the same document would both accept updates, both allocate flush batches
 * against the same `head_seq`, and their clients would see two presence rosters that never
 * meet - the split-awareness failure the deployment notes warn `replicas: 2` silently
 * causes. The lock makes the failure loud instead: a second instance asked for a document
 * another one owns refuses the connection, and the client retries against the owner.
 *
 * **Session-level on one dedicated connection, never inside the tenant scope.** An
 * advisory lock lives exactly as long as the session that took it, which is the property
 * that makes crash release automatic - a process that dies drops its connection and every
 * claim with it. Taking locks on pooled connections would tie each claim's lifetime to
 * whichever lease happened to hold it. The connection authenticates as the same runtime
 * role as everything else; advisory locks touch no table, so row-level security has
 * nothing to say here.
 */
export interface DocumentLocks {
  /** Claims a document. False means another live process owns it. */
  acquire(docId: string): Promise<boolean>;

  /** Releases a claim, on eviction. Releasing an unheld claim is a quiet no-op. */
  release(docId: string): Promise<void>;

  /** Closes the connection, releasing every claim at once. For shutdown. */
  close(): Promise<void>;
}

/**
 * Connects the dedicated lock session.
 *
 * `onSessionLost` fires if the connection dies while claims are outstanding. The server
 * must treat that as losing every claim at once - drop each resident document and close
 * its sockets - because the locks were already released on the Postgres side, and another
 * instance may legitimately own those documents before this process notices.
 */
export async function connectDocumentLocks(options: {
  databaseUrl: string;
  onSessionLost: () => void;
}): Promise<DocumentLocks> {
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();

  let closed = false;
  client.on('error', () => {
    if (!closed) {
      closed = true;
      options.onSessionLost();
    }
  });
  client.on('end', () => {
    if (!closed) {
      closed = true;
      options.onSessionLost();
    }
  });

  return {
    async acquire(docId: string): Promise<boolean> {
      // The 64-bit key is derived in Postgres so every instance - whatever its runtime or
      // hash library - agrees on it. The seed keeps document claims out of the keyspace
      // any other advisory-lock user of the same database might pick.
      const { rows } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 7042)) AS acquired',
        [docId],
      );
      return rows[0]?.acquired === true;
    },

    async release(docId: string): Promise<void> {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 7042))', [docId]);
    },

    async close(): Promise<void> {
      closed = true;
      await client.end();
    },
  };
}
