export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface QueryResultPayload {
  answer: string;
  sql: string | null;
  intent?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
  error?: string;
  modelUsed?: string;
  isComplex?: boolean;
  database?: string;
  clientName?: string;
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
  modelUsed?: string;
  isComplex?: boolean;
}

export interface SchemaTable {
  name: string;
  kind: 'table' | 'view';
  columns: string[];
}

export interface SchemaPayload {
  database: string;
  clientName?: string;
  clientRegId?: number;
  loadedAt: string;
  tables: SchemaTable[];
}
