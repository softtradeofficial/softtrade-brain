export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Sent back with the history so follow-up questions keep the previous answer's tables. */
  sql?: string;
}

export interface DatabaseInfo {
  name: string;
  isDefault: boolean;
}

export interface DatabaseListPayload {
  databases: DatabaseInfo[];
  current?: string;
}

export interface QueryResultPayload {
  answer: string;
  sql: string | null;
  database?: string;
  intent?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
  error?: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  failed?: boolean;
  sql?: string | null;
  intent?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
  showSql?: boolean;
}

export interface SchemaTable {
  name: string;
  kind: 'table' | 'view';
  columns: string[];
}

export interface SchemaPayload {
  database: string;
  loadedAt: string;
  tables: SchemaTable[];
}
