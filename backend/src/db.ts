import * as sql from 'mssql';
import { config } from './config';

let poolPromise: Promise<sql.ConnectionPool> | null = null;

function buildConfig(): sql.config {
  const base: sql.config = {
    server: config.db.server,
    database: config.db.database,
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

export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildConfig())
      .connect()
      .then((pool) => {
        console.log(`[db] connected to ${config.db.server}/${config.db.database}`);
        pool.on('error', (err) => console.error('[db] pool error', err));
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

/** Runs a read-only query and normalises the result for the API layer. */
export async function runQuery(query: string): Promise<QueryResult> {
  const pool = await getPool();
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
