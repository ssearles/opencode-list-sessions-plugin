/**
 * Ambient declaration for Bun's built-in SQLite module.
 *
 * `src/db.ts` resolves a driver at runtime — `bun:sqlite` under Bun,
 * `node:sqlite` under Node 22+ — and imports the Bun one dynamically behind a
 * try/catch, so the plugin still loads when only the Node driver exists.
 *
 * TypeScript still resolves the specifier at compile time and fails with
 * TS2307 without this, even though the import never runs outside Bun. Only the
 * surface `db.ts` actually touches is declared; anything else stays an error,
 * so a genuine misuse of the driver is not silenced.
 *
 * Upstream's Node-only types are the fallback, and `node:sqlite` ships its own.
 */

declare module "bun:sqlite" {
  export interface Statement {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }

  export class Database {
    constructor(path?: string, options?: { readonly?: boolean })
    prepare(sql: string): Statement
    exec(sql: string): void
    close(): void
  }
}
