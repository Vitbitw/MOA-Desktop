declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database
  }

  interface Database {
    exec(sql: string): void
    prepare(sql: string): Statement
    run(sql: string, params?: unknown[]): void
    export(): Uint8Array
    close(): void
    getRowsModified(): number
  }

  interface Statement {
    bind(params?: unknown[]): boolean
    step(): boolean
    getAsObject<T = Record<string, unknown>>(): T
    free(): void
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}
