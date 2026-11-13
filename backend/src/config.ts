import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positivePort(name: string, fallback: number): number {
  const parsed = num(name, fallback);
  return parsed > 0 ? parsed : fallback;
}

export const config = {
  port: num('PORT', 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  /** Central CSInfo database used to resolve each client's DB & Server IP by ClientRegId */
  csinfo: {
    server: process.env.CSINFO_DB_SERVER ?? '165.99.53.25',
    database: process.env.CSINFO_DB_DATABASE ?? 'CSinfo',
    user: process.env.CSINFO_DB_USER ?? 'SoftTradeUser',
    password: process.env.CSINFO_DB_PASSWORD ?? 'SoftTrade$2336225',
    port: positivePort('CSINFO_DB_PORT', 1433),
    instanceName: process.env.CSINFO_DB_INSTANCE || undefined,
    encrypt: process.env.CSINFO_DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.CSINFO_DB_TRUST_SERVER_CERTIFICATE !== 'false',
    fallbackServer: process.env.CSINFO_FALLBACK_SERVER || '162.4.140.2',
    fallbackUser: process.env.CSINFO_FALLBACK_USER || 'SoftTradeWebUser',
    fallbackPassword: process.env.CSINFO_FALLBACK_PASSWORD || process.env.CSINFO_DB_PASSWORD || 'SoftTrade$2336225',
  },

  /** Optional default/fallback database when no ClientRegId is provided */
  db: {
    server: process.env.DB_SERVER || '',
    database: process.env.DB_DATABASE || '',
    user: process.env.DB_USER || 'SoftTradeWebUser',
    password: process.env.DB_PASSWORD || 'SoftTrade$2336225',
    port: positivePort('DB_PORT', 1433),
    instanceName: process.env.DB_INSTANCE || undefined,
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
    trustedConnection: !process.env.DB_USER && !!process.env.DB_SERVER,
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL ?? 'gemini-3.6-flash',
    fastModel: process.env.FAST_MODEL ?? 'gemini-3.5-flash-lite',
    standardModel: process.env.STANDARD_MODEL ?? process.env.OPENAI_MODEL ?? 'gemini-3.6-flash',
    baseURL: process.env.OPENAI_BASE_URL,
  },

  /** Hard cap on rows returned to the browser / fed back to the model. */
  maxRows: num('MAX_ROWS', 200),
  /** Rows actually shown to the model when it writes the final answer. */
  maxRowsForSummary: num('MAX_ROWS_FOR_SUMMARY', 50),
  /** Query timeout in milliseconds. */
  queryTimeoutMs: num('QUERY_TIMEOUT_MS', 30000),
  /** How long the introspected schema is cached, in milliseconds. */
  schemaTtlMs: num('SCHEMA_TTL_MS', 10 * 60 * 1000),
  /** Only these schemas are exposed to the model. Empty = all. */
  allowedSchemas: (process.env.ALLOWED_SCHEMAS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
