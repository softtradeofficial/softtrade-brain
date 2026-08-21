import * as sql from 'mssql';
import { config } from './config';

/** One pool per database, so switching client databases does not tear down the others. */
const pools = new Map<string, Promise<sql.ConnectionPool>>();

function buildConfig(database: string): sql.config {
  const base: sql.config = {
    server: config.db.server,
    database,
    port: config.db.instanceName ? undefined : config.db.port,
    requestTimeout: config.queryTimeoutMs,
    connectionTimeout: 15000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
      instanceName: config.db.instanceName,
      // Keeps the API from ever holding locks on production tables.
      readOnlyIntent: true,
    },
  };

  if (config.db.user) {
    base.user = config.db.user;
    base.password = config.db.password;
  } else {
    // Windows integrated authentication (no user/password in .env).
    (base as sql.config & { driver?: string }).driver = 'msnodesqlv8';
    base.options = { ...base.options, trustedConnection: true } as sql.IOptions;
  }

  return base;
}

export function getPool(database?: string): Promise<sql.ConnectionPool> {
  const target = database || config.db.database;
  let pending = pools.get(target);

  if (!pending) {
    pending = new sql.ConnectionPool(buildConfig(target))
      .connect()
      .then((pool) => {
        console.log(`[db] connected to ${config.db.server}/${target}`);
        pool.on('error', (err) => console.error(`[db] pool error (${target})`, err));
        return pool;
      })
      .catch((err) => {
        pools.delete(target);
        throw err;
      });
    pools.set(target, pending);
  }

  return pending;
}

export interface DatabaseInfo {
  name: string;
  isDefault: boolean;
}

const DATABASES_SQL = `
SELECT [name]
FROM sys.databases
WHERE [state] = 0
  AND [name] NOT IN ('master', 'model', 'msdb', 'tempdb')
  AND HAS_DBACCESS([name]) = 1
ORDER BY [name];
`;

let databaseCache: { value: DatabaseInfo[]; expiresAt: number } | null = null;

/** Databases this login can read, narrowed by ALLOWED_DATABASES / DB_NAME_PATTERN. */
export async function listDatabases(forceRefresh = false): Promise<DatabaseInfo[]> {
  if (!forceRefresh && databaseCache && databaseCache.expiresAt > Date.now()) {
    return databaseCache.value;
  }

  const allowed = config.db.allowedDatabases;
  let names: string[];

  if (allowed.length) {
    // An explicit allowlist is authoritative - never probe the server for anything else.
    names = [...allowed];
  } else {
    const pool = await getPool();
    const result = await pool.request().query(DATABASES_SQL);
    names = (result.recordset as { name: string }[]).map((row) => row.name);

    if (config.db.namePattern) {
      const pattern = likeToRegExp(config.db.namePattern);
      names = names.filter((name) => pattern.test(name));
    }
  }

  // The configured default is always offered, even when a filter would hide it.
  if (!names.some((name) => name.toLowerCase() === config.db.database.toLowerCase())) {
    names.unshift(config.db.database);
  }

  const value = names.map((name) => ({
    name,
    isDefault: name.toLowerCase() === config.db.database.toLowerCase(),
  }));

  databaseCache = { value, expiresAt: Date.now() + config.schemaTtlMs };
  return value;
}

/** Translates a SQL LIKE pattern (% and _) into an anchored, case-insensitive expression. */
function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
  const body = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

export class UnknownDatabaseError extends Error {
  constructor(name: string) {
    super(`Database "${name}" is not available. Pick one from GET /api/databases.`);
    this.name = 'UnknownDatabaseError';
  }
}

/**
 * Maps a requested database name onto one we actually offer. The name goes into a
 * connection string rather than into SQL text, but it still has to come from our own list.
 */
export async function resolveDatabase(requested?: unknown): Promise<string> {
  if (typeof requested !== 'string' || !requested.trim()) return config.db.database;

  const wanted = requested.trim().toLowerCase();
  if (wanted === config.db.database.toLowerCase()) return config.db.database;

  const available = await listDatabases();
  const match = available.find((entry) => entry.name.toLowerCase() === wanted);
  if (!match) throw new UnknownDatabaseError(requested.trim());
  return match.name;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

/** Runs a read-only query and normalises the result for the API layer. */
export async function runQuery(query: string, database?: string): Promise<QueryResult> {
  const pool = await getPool(database);
  const started = Date.now();
  const request = pool.request();
  const result = await request.query(query);
  const elapsedMs = Date.now() - started;

  const raw = (result.recordset ?? []) as Record<string, unknown>[];
  const truncated = raw.length > config.maxRows;
  const rows = truncated ? raw.slice(0, config.maxRows) : raw;

  const columns =
    result.recordset && result.recordset.columns
      ? Object.keys(result.recordset.columns)
      : rows.length
      ? Object.keys(rows[0])
      : [];

  return { columns, rows: rows.map(serialiseRow), rowCount: raw.length, truncated, elapsedMs };
}

/** Dates and Buffers do not survive JSON cleanly; normalise them up front. */
function serialiseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (Buffer.isBuffer(value)) {
      out[key] = `0x${value.toString('hex')}`;
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}
