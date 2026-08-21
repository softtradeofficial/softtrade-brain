import type * as sql from 'mssql';

export interface DatabaseConfig {
  server: string;
  database: string;
  user?: string;
  password?: string;
  port?: number;
  instanceName?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  trustedConnection?: boolean;
  pool?: {
    max?: number;
    min?: number;
    idleTimeoutMillis?: number;
  };
}

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
}

export interface BrainConfig {
  db: DatabaseConfig;
  openai: OpenAIConfig;
  salesInvoiceSeries?: string;
  purchaseInvoiceSeries?: string[];
  maxRows?: number;
  maxRowsForSummary?: number;
  queryTimeoutMs?: number;
  schemaTtlMs?: number;
  allowedSchemas?: string[];
  excludeTables?: string[];
  customGlossary?: string;
}

export interface UserContext {
  userId: number;
  userCode: string;
  userName?: string;
  isSuperUser?: boolean;
  roleId?: number;
  roleName?: string;
  coSoftId?: number;
  allowedDivisions?: number[];
  allowedItemGroups?: number[];
  allowedPartyTypes?: string[];
  allowedModules?: string[];
  allowedTables?: string[];
  restrictedTables?: string[];
  salesPersonId?: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskOptions {
  user?: UserContext;
  maxSelectedTables?: number;
}

export interface BrainResponse {
  answer: string;
  sql: string | null;
  intent?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
  error?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: ColumnInfo[];
}

export interface ForeignKeyInfo {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

export interface DatabaseSchema {
  database: string;
  tables: TableInfo[];
  foreignKeys: ForeignKeyInfo[];
  notes: string;
  loadedAt: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export type Plan =
  | { action: 'query'; sql: string; intent: string }
  | { action: 'answer'; message: string };
