import * as sql from 'mssql';
import * as fs from 'fs';
import * as path from 'path';
import { SoftTradeBrain } from '../../packages/core/dist/index.js';
import { config } from './config';

export interface ClientDatabaseInfo {
  clientRegId: number;
  regNo: number;
  regName: string;
  server: string;
  database: string;
  port: number;
  user: string;
  password: string;
  webDataCode?: string;
  appSoftCode?: string;
  appSoftType?: string;
  resolvedAt: number;
}

interface CachedClientBrain {
  info: ClientDatabaseInfo;
  brain: SoftTradeBrain;
  expiresAt: number;
}

const CLIENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const clientBrainCache = new Map<string, CachedClientBrain>();
let defaultBrain: SoftTradeBrain | null = null;
let csinfoPoolPromise: Promise<sql.ConnectionPool> | null = null;

function isLocalPlaceholder(ip: string | undefined | null): boolean {
  if (!ip) return true;
  const normalized = ip.trim().toLowerCase();
  return !normalized || normalized === '(local)' || normalized === '.' || normalized === 'localhost';
}

function buildCsinfoPoolConfig(useFallback = false): sql.config {
  const server = useFallback ? config.csinfo.fallbackServer : config.csinfo.server;
  const user = useFallback ? config.csinfo.fallbackUser : config.csinfo.user;
  const password = useFallback ? config.csinfo.fallbackPassword : config.csinfo.password;

  return {
    server,
    database: config.csinfo.database,
    user,
    password,
    port: config.csinfo.instanceName ? undefined : config.csinfo.port,
    requestTimeout: 15000,
    connectionTimeout: 10000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: config.csinfo.encrypt,
      trustServerCertificate: config.csinfo.trustServerCertificate,
      instanceName: config.csinfo.instanceName,
      readOnlyIntent: true,
    },
  };
}

export async function getCsinfoPool(): Promise<sql.ConnectionPool> {
  if (!csinfoPoolPromise) {
    csinfoPoolPromise = new sql.ConnectionPool(buildCsinfoPoolConfig(false))
      .connect()
      .then((pool) => {
        console.log(`[csinfo] Connected to CSInfo on ${config.csinfo.server}/${config.csinfo.database}`);
        pool.on('error', (err) => console.error('[csinfo] Pool error:', err));
        return pool;
      })
      .catch(async (primaryErr) => {
        console.warn(
          `[csinfo] Primary CSInfo server (${config.csinfo.server}) failed: ${primaryErr.message}. Trying fallback (${config.csinfo.fallbackServer})...`
        );
        try {
          const fallbackPool = await new sql.ConnectionPool(buildCsinfoPoolConfig(true)).connect();
          console.log(`[csinfo] Connected to fallback CSInfo on ${config.csinfo.fallbackServer}/${config.csinfo.database}`);
          fallbackPool.on('error', (err) => console.error('[csinfo] Fallback pool error:', err));
          return fallbackPool;
        } catch (fallbackErr) {
          csinfoPoolPromise = null;
          throw primaryErr;
        }
      });
  }
  return csinfoPoolPromise;
}

/**
 * Fallback reader for D:\WebCode\Logins\<ClientRegId> if CSInfo DB is unreachable.
 */
function tryReadLocalLoginFile(clientRegId: number): ClientDatabaseInfo | null {
  const candidates = [
    path.resolve(process.cwd(), '..', 'Logins', String(clientRegId)),
    path.resolve(process.cwd(), '..', '..', 'Logins', String(clientRegId)),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
        const vars: Record<string, string> = {};
        for (const line of lines) {
          const idx = line.indexOf('=');
          if (idx > 0) {
            vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
        }
        const ip1 = vars['DataServerIP'] || '';
        const ip2 = vars['DataServerIP2'] || '';
        const server = !isLocalPlaceholder(ip2) ? ip2 : !isLocalPlaceholder(ip1) ? ip1 : config.csinfo.server;
        const database = vars['DatabaseName'] || '';
        const portRaw = Number(vars['DataServerPortNo'] || '0');
        const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 1433;
        const user = vars['DataServerUserID'] || config.db.user || 'SoftTradeWebUser';
        const password = vars['DataServerUserPassword'] || config.db.password || 'SoftTrade$2336225';

        if (server && database) {
          return {
            clientRegId,
            regNo: 0,
            regName: `Client #${clientRegId}`,
            server,
            database,
            port,
            user,
            password,
            webDataCode: vars['WebDataCode'],
            resolvedAt: Date.now(),
          };
        }
      } catch {
        // Ignore and continue
      }
    }
  }
  return null;
}

/**
 * Resolves a client's SQL Server IP, port, credentials, and DatabaseName from CSInfo (CS_installInfo)
 * using ClientRegId (or RegNo fallback).
 */
export async function resolveClientDbFromCsinfo(
  clientRegId?: number,
  regNo?: number
): Promise<ClientDatabaseInfo> {
  if ((!clientRegId || clientRegId <= 0) && (!regNo || regNo === 0)) {
    throw new Error('A valid ClientRegId (or RegNo) is required to resolve the client database from CSInfo.');
  }

  const cacheKey = clientRegId && clientRegId > 0 ? `id:${clientRegId}` : `regNo:${regNo}`;
  const existing = clientBrainCache.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.info;
  }

  let row: Record<string, any> | undefined;

  try {
    const pool = await getCsinfoPool();

    if (clientRegId && clientRegId > 0) {
      const reqById = pool.request();
      reqById.input('clientRegId', sql.Int, clientRegId);
      const resById = await reqById.query(`
        SELECT TOP (1)
          [ID],
          [RegNo],
          [RegName],
          [DataServerIP],
          [DataServerIP2],
          [DataServerPortNo],
          [DataServerUserID],
          [DataServerUserPassword],
          [DatabaseName],
          [WebDataCode],
          [AppSoftCode],
          [AppSoftType]
        FROM [dbo].[CS_installInfo]
        WHERE [ID] = @clientRegId;
      `);
      row = resById.recordset?.[0];
    }

    if (!row && regNo && regNo !== 0) {
      const reqByRegNo = pool.request();
      reqByRegNo.input('regNo', sql.Int, regNo);
      const resByRegNo = await reqByRegNo.query(`
        SELECT TOP (1)
          [ID],
          [RegNo],
          [RegName],
          [DataServerIP],
          [DataServerIP2],
          [DataServerPortNo],
          [DataServerUserID],
          [DataServerUserPassword],
          [DatabaseName],
          [WebDataCode],
          [AppSoftCode],
          [AppSoftType]
        FROM [dbo].[CS_installInfo]
        WHERE [RegNo] = @regNo;
      `);
      row = resByRegNo.recordset?.[0];
    }
  } catch (err: any) {
    console.warn(`[csinfo] Query to CSInfo failed (${err.message}), checking local Logins file fallback...`);
    if (clientRegId && clientRegId > 0) {
      const localInfo = tryReadLocalLoginFile(clientRegId);
      if (localInfo) return localInfo;
    }
    throw err;
  }

  if (!row) {
    if (clientRegId && clientRegId > 0) {
      const localInfo = tryReadLocalLoginFile(clientRegId);
      if (localInfo) return localInfo;
    }
    throw new Error(
      `Client with ClientRegId=${clientRegId ?? 'N/A'} (RegNo=${regNo ?? 'N/A'}) was not found in CSInfo [dbo].[CS_installInfo].`
    );
  }

  const ip1 = String(row['DataServerIP'] ?? '').trim();
  const ip2 = String(row['DataServerIP2'] ?? '').trim();

  // In CS_installInfo, DataServerIP is often '(local)' while DataServerIP2 holds the external server IP.
  const server = !isLocalPlaceholder(ip2)
    ? ip2
    : !isLocalPlaceholder(ip1)
    ? ip1
    : config.csinfo.server;

  const database = String(row['DatabaseName'] ?? '').trim();
  if (!database) {
    throw new Error(
      `DatabaseName is empty in CSInfo [dbo].[CS_installInfo] for ClientRegId=${row['ID']} (${row['RegName'] || 'Unknown'}).`
    );
  }

  const rawPort = Number(row['DataServerPortNo'] ?? 0);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 1433;
  const user = String(row['DataServerUserID'] ?? '').trim() || config.db.user || 'SoftTradeWebUser';
  const password = String(row['DataServerUserPassword'] ?? '').trim() || config.db.password || 'SoftTrade$2336225';

  return {
    clientRegId: Number(row['ID']),
    regNo: Number(row['RegNo'] ?? 0),
    regName: String(row['RegName'] ?? '').trim(),
    server,
    database,
    port,
    user,
    password,
    webDataCode: row['WebDataCode'] ? String(row['WebDataCode']).trim() : undefined,
    appSoftCode: row['AppSoftCode'] ? String(row['AppSoftCode']).trim() : undefined,
    appSoftType: row['AppSoftType'] ? String(row['AppSoftType']).trim() : undefined,
    resolvedAt: Date.now(),
  };
}

function createBrainInstance(dbConfig: {
  server: string;
  database: string;
  port?: number;
  instanceName?: string;
  user?: string;
  password?: string;
}): SoftTradeBrain {
  return new SoftTradeBrain({
    db: {
      server: dbConfig.server,
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
      instanceName: dbConfig.instanceName,
      port: dbConfig.port && dbConfig.port > 0 ? dbConfig.port : 1433,
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
    },
    openai: {
      apiKey: config.openai.apiKey,
      model: config.openai.model,
      fastModel: config.openai.fastModel,
      standardModel: config.openai.standardModel,
      baseURL: config.openai.baseURL,
    },
    maxRows: config.maxRows,
    maxRowsForSummary: config.maxRowsForSummary,
    queryTimeoutMs: config.queryTimeoutMs,
    schemaTtlMs: config.schemaTtlMs,
    allowedSchemas: config.allowedSchemas,
  });
}

/**
 * Returns a cached or newly created SoftTradeBrain instance for the given ClientRegId / RegNo.
 * Falls back to the default .env DB configuration if no ClientRegId is provided and DB_SERVER/DB_DATABASE are set.
 */
export async function getBrainForClient(
  clientRegId?: number,
  regNo?: number
): Promise<{ brain: SoftTradeBrain; clientInfo?: ClientDatabaseInfo }> {
  if ((clientRegId && clientRegId > 0) || (regNo && regNo !== 0)) {
    const cacheKey = clientRegId && clientRegId > 0 ? `id:${clientRegId}` : `regNo:${regNo}`;
    const cached = clientBrainCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { brain: cached.brain, clientInfo: cached.info };
    }

    const info = await resolveClientDbFromCsinfo(clientRegId, regNo);

    // Reuse existing SoftTradeBrain instance if server/database/user did not change
    if (
      cached &&
      cached.info.server === info.server &&
      cached.info.database === info.database &&
      cached.info.port === info.port &&
      cached.info.user === info.user
    ) {
      cached.info = info;
      cached.expiresAt = Date.now() + CLIENT_CACHE_TTL_MS;
      return { brain: cached.brain, clientInfo: info };
    }

    console.log(
      `[csinfo] Resolved ClientRegId=${info.clientRegId} ("${info.regName}") -> ${info.server}:${info.port}/${info.database}`
    );
    const brain = createBrainInstance({
      server: info.server,
      database: info.database,
      port: info.port,
      user: info.user,
      password: info.password,
    });

    const entry: CachedClientBrain = {
      info,
      brain,
      expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
    };
    clientBrainCache.set(`id:${info.clientRegId}`, entry);
    if (info.regNo) {
      clientBrainCache.set(`regNo:${info.regNo}`, entry);
    }

    return { brain, clientInfo: info };
  }

  // Fallback if DB_SERVER and DB_DATABASE are explicitly configured in .env
  if (config.db.server && config.db.database) {
    if (!defaultBrain) {
      defaultBrain = createBrainInstance({
        server: config.db.server,
        database: config.db.database,
        port: config.db.port,
        instanceName: config.db.instanceName,
        user: config.db.user,
        password: config.db.password,
      });
    }
    return { brain: defaultBrain };
  }

  throw new Error(
    'No ClientRegId was provided in the request. Please open SoftTrade Brain from MandiAngular (or pass X-Client-Reg-Id / clientRegId).'
  );
}
