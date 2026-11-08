// Types shared by the repository modules (plan 4.1), Postgres and SQLite alike.
//
// Types only: no repository requires this file at run time. Each one names
// what it needs with a type query, `type Db = import('./types.ts').Db;`, which
// erases to nothing, so the modules stay CommonJS (docs/native/JARVISD.md).

/** A row as the driver returns it: column name to value. */
export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  rowCount?: number | null;
}

/** One connection or transaction: what withTx hands its function. */
export interface Client {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

/** A backend (src/db, src/db/sqlite.js, repo/index.js clientBackend): what every aggregate's create() gets. */
export interface Db {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  rows(text: string, params?: unknown[]): Promise<Row[]>;
  one(text: string, params?: unknown[]): Promise<Row | null>;
  withTx<T>(fn: (client: Client) => Promise<T>): Promise<T>;
  notify?(channel: string, payload: string): Promise<unknown>;
  dialect?: string;
  inTx?: boolean;
  session?: { id: string; listen(channel: string): void };
}
