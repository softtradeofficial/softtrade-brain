import { config } from './config';
import { getPool } from './db';
import { isExcludedTable, FRESHNESS_QUERY, freshnessNote } from './domain';

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

let cache: { value: DatabaseSchema; expiresAt: number } | null = null;

const COLUMNS_SQL = `
SELECT
  t.TABLE_SCHEMA        AS [schema],
  t.TABLE_NAME          AS [table],
  t.TABLE_TYPE          AS [tableType],
  c.COLUMN_NAME         AS [column],
  c.DATA_TYPE           AS [dataType],
  c.CHARACTER_MAXIMUM_LENGTH AS [maxLength],
  c.NUMERIC_PRECISION   AS [precision],
  c.NUMERIC_SCALE       AS [scale],
  c.IS_NULLABLE         AS [isNullable],
  c.ORDINAL_POSITION    AS [ordinal]
FROM INFORMATION_SCHEMA.TABLES t
JOIN INFORMATION_SCHEMA.COLUMNS c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
  AND t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION;
`;

const FOREIGN_KEYS_SQL = `
SELECT
  SCHEMA_NAME(pt.schema_id) + '.' + pt.name AS [fromTable],
  pc.name                                   AS [fromColumn],
  SCHEMA_NAME(rt.schema_id) + '.' + rt.name AS [toTable],
  rc.name                                   AS [toColumn]
FROM sys.foreign_key_columns fkc
JOIN sys.tables  pt ON pt.object_id = fkc.parent_object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables  rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id;
`;

function formatType(row: Record<string, unknown>): string {
  const type = String(row['dataType']);
  const maxLength = row['maxLength'] as number | null;
  const precision = row['precision'] as number | null;
  const scale = row['scale'] as number | null;

  if (maxLength != null) {
    return `${type}(${maxLength === -1 ? 'max' : maxLength})`;
  }
  if (type === 'decimal' || type === 'numeric') {
    return `${type}(${precision},${scale})`;
  }
  return type;
}

async function introspect(): Promise<DatabaseSchema> {
  const pool = await getPool();
  const [columnsResult, fkResult, freshness] = await Promise.all([
    pool.request().query(COLUMNS_SQL),
    pool.request().query(FOREIGN_KEYS_SQL),
    // Best effort - the glossary table may not exist in every SoftTrade database.
    pool.request().query(FRESHNESS_QUERY).catch(() => null),
  ]);

  const freshRow = freshness?.recordset?.[0] as Record<string, unknown> | undefined;
  const notes = freshRow ? freshnessNote(freshRow['lastBill'], freshRow['bills']) : '';

  const allowed = config.allowedSchemas;
  const byTable = new Map<string, TableInfo>();

  for (const row of columnsResult.recordset as Record<string, unknown>[]) {
    const schema = String(row['schema']);
    if (allowed.length && !allowed.includes(schema)) continue;

    const name = String(row['table']);
    if (isExcludedTable(name)) continue;
    const key = `${schema}.${name}`;
    let table = byTable.get(key);
    if (!table) {
      table = {
        schema,
        name,
        kind: row['tableType'] === 'VIEW' ? 'view' : 'table',
        columns: [],
      };
      byTable.set(key, table);
    }
    table.columns.push({
      name: String(row['column']),
      type: formatType(row),
      nullable: row['isNullable'] === 'YES',
    });
  }

  const foreignKeys: ForeignKeyInfo[] = (fkResult.recordset as Record<string, unknown>[])
    .map((row) => ({
      from: String(row['fromTable']),
      fromColumn: String(row['fromColumn']),
      to: String(row['toTable']),
      toColumn: String(row['toColumn']),
    }))
    .filter((fk) => byTable.has(fk.from) && byTable.has(fk.to));

  return {
    database: config.db.database,
    tables: [...byTable.values()],
    foreignKeys,
    notes,
    loadedAt: new Date().toISOString(),
  };
}

import * as fs from 'fs';
import * as path from 'path';

function findSchemaCachePath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'schema_cache.json'),
    path.resolve(process.cwd(), 'backend', 'schema_cache.json'),
    path.resolve(__dirname, '..', 'schema_cache.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(process.cwd(), 'schema_cache.json');
}

export async function getSchema(forceRefresh = false): Promise<DatabaseSchema> {
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  const cacheFilePath = findSchemaCachePath();

  if (!forceRefresh && fs.existsSync(cacheFilePath)) {
    try {
      const raw = fs.readFileSync(cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as DatabaseSchema;
      if (parsed && Array.isArray(parsed.tables)) {
        parsed.tables = parsed.tables.filter((t) => !isExcludedTable(t.name));
        cache = { value: parsed, expiresAt: Date.now() + config.schemaTtlMs };
        console.log(`[schema] loaded ${parsed.tables.length} tables from local cache file: ${cacheFilePath}`);
        return parsed;
      }
    } catch (err: any) {
      console.warn(`[schema] could not parse schema_cache.json: ${err.message}`);
    }
  }

  const value = await introspect();
  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(value, null, 2), 'utf-8');
    console.log(`[schema] saved schema to ${cacheFilePath}`);
  } catch (err: any) {
    console.warn(`[schema] could not save schema cache: ${err.message}`);
  }

  cache = { value, expiresAt: Date.now() + config.schemaTtlMs };
  console.log(`[schema] loaded ${value.tables.length} tables/views, ${value.foreignKeys.length} foreign keys`);
  return value;
}

/** Just the table names - cheap enough to send when asking which tables a question needs. */
export function renderTableNamesForPrompt(schema: DatabaseSchema): string {
  return schema.tables
    .map((table) => `${table.schema}.${table.name}${table.kind === 'view' ? ' (view)' : ''}`)
    .join('\n');
}

/**
 * Compact, token-efficient rendering of the schema for the system prompt.
 * Passing `only` restricts it to the tables a question actually needs, which keeps the
 * prompt inside the account's tokens-per-minute limit on a 246-table database.
 */
export function renderSchemaForPrompt(schema: DatabaseSchema, only?: Set<string>): string {
  const lines: string[] = [`Database: ${schema.database} (Microsoft SQL Server)`, '', 'TABLES AND VIEWS:'];

  const wanted = only
    ? schema.tables.filter(
        (table) =>
          only.has(`${table.schema}.${table.name}`.toLowerCase()) ||
          only.has(table.name.toLowerCase())
      )
    : schema.tables;

  for (const table of wanted) {
    const cols = table.columns
      .map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`)
      .join(', ');
    lines.push(`- [${table.schema}].[${table.name}]${table.kind === 'view' ? ' (view)' : ''}: ${cols}`);
  }

  const relevantKeys = only
    ? schema.foreignKeys.filter(
        (fk) => only.has(fk.from.toLowerCase()) || only.has(fk.to.toLowerCase())
      )
    : schema.foreignKeys;

  if (relevantKeys.length) {
    lines.push('', 'FOREIGN KEYS:');
    for (const fk of relevantKeys) {
      lines.push(`- ${fk.from}.${fk.fromColumn} -> ${fk.to}.${fk.toColumn}`);
    }
  }

  return lines.join('\n');
}
