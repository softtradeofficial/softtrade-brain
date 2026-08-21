import * as sql from 'mssql';
import type { DatabaseConfig, QueryResult } from './types';

export class DatabaseClient {
  private poolPromise: Promise<sql.ConnectionPool> | null = null;

  constructor(private readonly config: DatabaseConfig, private readonly queryTimeoutMs: number = 30000) {}

  private buildConfig(): sql.config {
    const base: sql.config = {
      server: this.config.server,
      database: this.config.database,
      port: this.config.instanceName ? undefined : (this.config.port ?? 1433),
      requestTimeout: this.queryTimeoutMs,
      connectionTimeout: 15000,
      pool: {
        max: this.config.pool?.max ?? 10,
        min: this.config.pool?.min ?? 0,
        idleTimeoutMillis: this.config.pool?.idleTimeoutMillis ?? 30000,
      },
      options: {
        encrypt: this.config.encrypt ?? true,
        trustServerCertificate: this.config.trustServerCertificate ?? true,
        instanceName: this.config.instanceName,
        readOnlyIntent: true,
      },
    };

    if (this.config.user) {
      base.user = this.config.user;
      base.password = this.config.password;
    } else {
      (base as sql.config & { driver?: string }).driver = 'msnodesqlv8';
      base.options = { ...base.options, trustedConnection: true } as sql.IOptions;
    }

    return base;
  }

  public getPool(): Promise<sql.ConnectionPool> {
    if (!this.poolPromise) {
      this.poolPromise = new sql.ConnectionPool(this.buildConfig())
        .connect()
        .then((pool) => {
          pool.on('error', (err) => console.error('[SoftTradeBrain DB Pool Error]:', err));
          return pool;
        })
        .catch((err) => {
          this.poolPromise = null;
          throw err;
        });
    }
    return this.poolPromise;
  }

  public async runQuery(query: string, maxRows = 200): Promise<QueryResult> {
    const pool = await this.getPool();
    const started = Date.now();
    const request = pool.request();
    const result = await request.query(query);
    const elapsedMs = Date.now() - started;

    const raw = (result.recordset ?? []) as Record<string, unknown>[];
    const truncated = raw.length > maxRows;
    const rows = truncated ? raw.slice(0, maxRows) : raw;

    const columns =
      result.recordset && result.recordset.columns
        ? Object.keys(result.recordset.columns)
        : rows.length
        ? Object.keys(rows[0])
        : [];

    return {
      columns,
      rows: rows.map(serialiseRow),
      rowCount: raw.length,
      truncated,
      elapsedMs,
    };
  }

  public async close(): Promise<void> {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.close();
      this.poolPromise = null;
    }
  }
}

function serialiseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (Buffer.isBuffer(value)) {
      out[key] = '0x' + value.toString('hex');
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}
