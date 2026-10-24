declare module 'node-firebird' {
  export interface Options {
    host?: string
    port?: number
    database: string
    user?: string
    password?: string
    role?: string
    lowercase_keys?: boolean
    pageSize?: number
    retryConnectionInterval?: number
    blobAsText?: boolean
    encoding?: string
  }

  export interface Database {
    query(
      sql: string,
      params: unknown[],
      callback: (error: Error | null, rows: Record<string, unknown>[]) => void
    ): void
    execute(
      sql: string,
      params: unknown[],
      callback: (error: Error | null, rows: Record<string, unknown>[]) => void
    ): void
    detach(callback?: (error: Error | null) => void): void
  }

  const Firebird: {
    attach(options: Options, callback: (error: Error | null, db: Database) => void): void
    escape(value: unknown): string
  }

  export default Firebird
}
