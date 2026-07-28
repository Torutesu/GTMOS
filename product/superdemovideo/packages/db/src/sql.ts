/**
 * Minimal Postgres-compatible query surface.
 *
 * Both drivers speak plain Postgres SQL with $1-style parameters, so the
 * application layer never learns which one it is talking to. Swapping the
 * embedded database for a real cluster is a URL, not a rewrite.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** Which driver backs this handle — used by the queue to pick a locking strategy. */
  readonly kind: "pglite" | "pg";
}

export async function openDb(opts: {
  databaseUrl: string | null;
  dbDir: string;
}): Promise<Db> {
  if (opts.databaseUrl) return openPg(opts.databaseUrl);
  return openPglite(opts.dbDir);
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = await PGlite.create({ dataDir: dir });

  return {
    kind: "pglite",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params as never[]);
      return res.rows;
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params as never[]);
      return res.rows[0] ?? null;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  };
}

async function openPg(url: string): Promise<Db> {
  // Optional dependency: only installed when someone points at a real cluster.
  // The specifier is indirect so the embedded path never needs `pg` present.
  const specifier = "pg";
  const pgMod = (await import(specifier)) as unknown as {
    default?: { Pool: new (c: { connectionString: string }) => PgPool };
    Pool?: new (c: { connectionString: string }) => PgPool;
  };
  const Pool = pgMod.default?.Pool ?? pgMod.Pool;
  if (!Pool) throw new Error("DATABASE_URL is set but the 'pg' package is not installed");
  const pool = new Pool({ connectionString: url });

  return {
    kind: "pg",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return (res.rows[0] as T) ?? null;
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
