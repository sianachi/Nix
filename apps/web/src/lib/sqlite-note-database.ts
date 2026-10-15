import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { z } from 'zod';
import {
  NoteStorageClosed,
  noteDatabases,
  type NoteDatabaseName,
  type NoteEntry,
  type NoteIndex,
  type NoteQuery,
  type NoteStoreDefinition,
  type NoteTable,
  type NoteTransaction,
} from './note-database';

export interface NoteSqlite {
  execute: (sql: string, transaction?: boolean) => Promise<unknown>;
  run: (sql: string, values?: unknown[], transaction?: boolean) => Promise<unknown>;
  query: (sql: string, values?: unknown[]) => Promise<{ values?: unknown[] }>;
  beginTransaction: () => Promise<unknown>;
  commitTransaction: () => Promise<unknown>;
  rollbackTransaction: () => Promise<unknown>;
}
const bytesSchema = z.object({
  $nixBytes: z.string(),
  $nixType: z.enum(['bytes', 'blob']),
  mediaType: z.string().optional(),
});
const rowSchema = z.object({ key: z.string(), indexes: z.string(), data: z.string().optional() });
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(text);
}
async function encode(value: unknown): Promise<unknown> {
  if (value instanceof Uint8Array) return { $nixType: 'bytes', $nixBytes: base64(value) };
  if (value instanceof Blob)
    return {
      $nixType: 'blob',
      $nixBytes: base64(new Uint8Array(await value.arrayBuffer())),
      mediaType: value.type,
    };
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value !== null && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, field]) => [key, await encode(field)]),
    );
    return Object.fromEntries(entries);
  }
  return value;
}
function decode(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown): unknown => {
    const parsed = bytesSchema.safeParse(value);
    if (!parsed.success) return value;
    const bytes = Uint8Array.from(atob(parsed.data.$nixBytes), (character) =>
      character.charCodeAt(0),
    );
    return parsed.data.$nixType === 'bytes'
      ? bytes
      : new Blob([bytes], { type: parsed.data.mediaType ?? '' });
  });
}
const keySchema = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]);
function keyValue(
  record: Record<string, unknown>,
  path: string | string[],
): z.infer<typeof keySchema> {
  return keySchema.parse(Array.isArray(path) ? path.map((field) => record[field]) : record[path]);
}
function querySql(
  expression: string,
  query: NoteQuery | undefined,
): { clause: string; values: unknown[] } {
  if (query === null || query === undefined) return { clause: '', values: [] };
  if (query instanceof IDBKeyRange) {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.lower !== undefined) {
      clauses.push(`${expression} ${query.lowerOpen ? '>' : '>='} json_extract(?, '$')`);
      values.push(JSON.stringify(keySchema.parse(query.lower)));
    }
    if (query.upper !== undefined) {
      clauses.push(`${expression} ${query.upperOpen ? '<' : '<='} json_extract(?, '$')`);
      values.push(JSON.stringify(keySchema.parse(query.upper)));
    }
    return { clause: clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`, values };
  }
  return {
    clause: ` AND ${expression} = json_extract(?, '$')`,
    values: [JSON.stringify(keySchema.parse(query))],
  };
}

export function createSqliteNoteStorage(open: () => Promise<NoteSqlite>): {
  transaction: <T>(
    name: NoteDatabaseName,
    stores: string | string[],
    mode: IDBTransactionMode,
    admitted: () => boolean,
    run: (tx: NoteTransaction) => Promise<T>,
  ) => Promise<T>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  async function transaction<T>(
    name: NoteDatabaseName,
    stores: string | string[],
    mode: IDBTransactionMode,
    admitted: () => boolean,
    run: (tx: NoteTransaction) => Promise<T>,
  ): Promise<T> {
    const previous = queue;
    const operation = (async () => {
      await previous.catch(() => undefined);
      const db = await open();
      function check(): void {
        if (!admitted()) throw new NoteStorageClosed();
      }
      check();
      await db.beginTransaction();
      try {
        const allowed = new Set(typeof stores === 'string' ? [stores] : stores);
        const definitions: Record<string, NoteStoreDefinition> = noteDatabases[name].stores;
        function table(storeName: string): NoteTable {
          const found = definitions[storeName];
          if (!allowed.has(storeName) || found === undefined)
            throw new Error('Unknown note store.');
          const definition = found;
          const where = 'database_name = ? AND store_name = ?';
          const scope = [name, storeName];
          function writeCheck(): void {
            check();
            if (mode !== 'readwrite') throw new Error('This note transaction is read-only.');
          }
          function index(indexName?: string): NoteIndex {
            if (indexName !== undefined && !(indexName in definition.indexes))
              throw new Error('Unknown note index.');
            const expression =
              indexName === undefined
                ? "json_extract(key, '$')"
                : `json_extract(indexes, '$.${indexName}')`;
            async function entries(
              query?: NoteQuery,
              direction?: IDBCursorDirection,
              keysOnly = false,
            ): Promise<NoteEntry[]> {
              check();
              const filter = querySql(expression, query);
              const rows = z
                .array(rowSchema)
                .parse(
                  (
                    await db.query(
                      `SELECT key, indexes${keysOnly ? '' : ', data'} FROM note_records WHERE ${where}${filter.clause} ORDER BY ${expression} ${direction?.startsWith('prev') ? 'DESC' : 'ASC'}, key`,
                      [...scope, ...filter.values],
                    )
                  ).values ?? [],
                );
              check();
              return rows.map((row) => {
                const primaryKey = keySchema.parse(JSON.parse(row.key));
                const indexes = z.record(z.string(), z.unknown()).parse(JSON.parse(row.indexes));
                return {
                  key: indexName === undefined ? primaryKey : keySchema.parse(indexes[indexName]),
                  primaryKey,
                  value: row.data === undefined ? undefined : decode(row.data),
                };
              });
            }
            return {
              entries,
              getAll: async (query) => (await entries(query)).map((entry) => entry.value),
              getKey: async (query) => (await entries(query, undefined, true))[0]?.primaryKey,
            };
          }
          return {
            ...index(),
            index,
            get: async (key) => {
              check();
              const rows = z
                .array(z.object({ data: z.string() }))
                .parse(
                  (
                    await db.query(`SELECT data FROM note_records WHERE ${where} AND key = ?`, [
                      ...scope,
                      JSON.stringify(keySchema.parse(key)),
                    ])
                  ).values ?? [],
                );
              check();
              return rows[0] === undefined ? undefined : decode(rows[0].data);
            },
            put: async (value) => {
              const record = z.record(z.string(), z.unknown()).parse(value);
              const key = JSON.stringify(keyValue(record, definition.key));
              const indexes = JSON.stringify(
                Object.fromEntries(
                  Object.entries(definition.indexes).map(([index, path]) => [
                    index,
                    keyValue(record, path),
                  ]),
                ),
              );
              const data = JSON.stringify(await encode(record));
              writeCheck();
              await db.run(
                'INSERT INTO note_records(database_name, store_name, key, indexes, data) VALUES(?, ?, ?, ?, ?) ON CONFLICT(database_name, store_name, key) DO UPDATE SET indexes = excluded.indexes, data = excluded.data',
                [...scope, key, indexes, data],
                false,
              );
            },
            delete: async (query) => {
              writeCheck();
              const filter = querySql("json_extract(key, '$')", query);
              await db.run(
                `DELETE FROM note_records WHERE ${where}${filter.clause}`,
                [...scope, ...filter.values],
                false,
              );
            },
            clear: async () => {
              writeCheck();
              await db.run(`DELETE FROM note_records WHERE ${where}`, scope, false);
            },
          };
        }
        const value = await run({ table });
        check();
        await db.commitTransaction();
        check();
        return value;
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
    })();
    queue = operation;
    return operation;
  }
  return { transaction };
}
const sqlite = new SQLiteConnection(CapacitorSQLite);
let opening: Promise<NoteSqlite> | undefined;
async function open(): Promise<NoteSqlite> {
  opening ??= (async () => {
    await sqlite.checkConnectionsConsistency();
    const exists = (await sqlite.isConnection('nix_notes', false)).result === true;
    const connection = exists
      ? await sqlite.retrieveConnection('nix_notes', false)
      : await sqlite.createConnection('nix_notes', false, 'no-encryption', 1, false);
    await connection.open();
    await connection.execute(
      `PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS note_records(database_name TEXT NOT NULL, store_name TEXT NOT NULL, key TEXT NOT NULL, indexes TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(database_name, store_name, key));
      CREATE INDEX IF NOT EXISTS note_records_scope ON note_records(database_name, store_name, json_extract(indexes, '$.scope'));
      CREATE INDEX IF NOT EXISTS note_records_subject ON note_records(database_name, store_name, json_extract(indexes, '$.subject'));
      CREATE INDEX IF NOT EXISTS note_records_saved ON note_records(database_name, store_name, json_extract(indexes, '$.savedAt'));`,
      false,
    );
    return connection;
  })();
  try {
    return await opening;
  } catch (error) {
    opening = undefined;
    throw error;
  }
}
export const sqliteNoteTransaction = createSqliteNoteStorage(open).transaction;
