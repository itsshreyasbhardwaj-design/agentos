import { AgentOSError } from '@agentos/core';

export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/**
 * The minimum a SQL backend must provide. Keeping it this small is what lets
 * the same statements run against node-postgres in production and PGlite (an
 * in-process WASM Postgres) in the test suite — so the SQL itself is verified,
 * not merely written.
 */
export interface SqlDriver {
  readonly dialect: 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
  /**
   * Run a script that may contain several statements. Prepared statements can
   * only carry one, so schema migrations go through here instead of `query`.
   */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back on any throw. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PgClientLike {
  query(config: { text: string; values?: unknown[] }): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release?(): void;
}

interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

/** node-postgres driver. Used in production deployments. */
export class PgDriver implements SqlDriver {
  readonly dialect = 'postgres' as const;

  constructor(private readonly pool: PgPoolLike, private readonly owned = false) {}

  static async connect(connectionString: string, options: { max?: number } = {}): Promise<PgDriver> {
    let Pool: new (config: Record<string, unknown>) => PgPoolLike;
    try {
      const mod = (await import('pg')) as unknown as {
        default?: { Pool: new (c: Record<string, unknown>) => PgPoolLike };
        Pool?: new (c: Record<string, unknown>) => PgPoolLike;
      };
      const resolved = mod.Pool ?? mod.default?.Pool;
      if (!resolved) throw new Error('pg did not export Pool');
      Pool = resolved;
    } catch (error) {
      throw new AgentOSError('internal', 'the "pg" package is required for the Postgres store', { cause: error });
    }
    return new PgDriver(new Pool({ connectionString, max: options.max ?? 10 }), true);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
    const result = await this.pool.query({ text: sql, values: params });
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query({ text: sql });
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: SqlDriver = {
      dialect: 'postgres',
      query: async <R>(sql: string, params: unknown[] = []) => {
        const result = await client.query({ text: sql, values: params });
        return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
      },
      exec: async (script: string) => {
        await client.query({ text: script });
      },
      transaction: async (inner) => inner(tx),
      close: async () => undefined,
    };
    try {
      await tx.query('BEGIN');
      const value = await fn(tx);
      await tx.query('COMMIT');
      return value;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  async close(): Promise<void> {
    if (this.owned) await this.pool.end();
  }
}

interface PgliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * PGlite driver: a real Postgres compiled to WASM, running in-process.
 *
 * This is what the SQL store's tests run against, so the schema and every
 * statement are executed for real without needing a database server.
 */
export class PgliteDriver implements SqlDriver {
  readonly dialect = 'postgres' as const;
  private depth = 0;

  constructor(private readonly db: PgliteLike) {}

  static async create(dataDir?: string): Promise<PgliteDriver> {
    const { PGlite } = (await import('@electric-sql/pglite')) as unknown as {
      PGlite: new (dataDir?: string) => PgliteLike;
    };
    return new PgliteDriver(new PGlite(dataDir));
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
    const result = await this.db.query(sql, params);
    // An UPDATE/DELETE without RETURNING yields no rows, so the affected-row
    // count is the only signal that the statement matched anything.
    return { rows: result.rows as T[], rowCount: result.affectedRows ?? (result.rows as T[]).length };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    // PGlite is single-connection: nested transactions use savepoints.
    const isNested = this.depth > 0;
    const name = `sp_${this.depth}`;
    this.depth += 1;
    try {
      await this.query(isNested ? `SAVEPOINT ${name}` : 'BEGIN');
      const value = await fn(this);
      await this.query(isNested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
      return value;
    } catch (error) {
      await this.query(isNested ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
