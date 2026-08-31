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

export const config = {
  port: num('PORT', 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',

  db: {
    server: required('DB_SERVER'),
    database: required('DB_DATABASE'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: num('DB_PORT', 1433),
    instanceName: process.env.DB_INSTANCE || undefined,
    encrypt: process.env.DB_ENCRYPT !== 'false',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
    // Windows integrated auth is used when no user/password is supplied.
    trustedConnection: !process.env.DB_USER,
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
