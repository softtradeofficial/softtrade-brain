import { config } from './config';
import { getPool } from './db';
import { isExcludedTable, FRESHNESS_QUERY, freshnessNote, unfamiliarDatabaseNote } from './domain';

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

/** Schema cache per database - each client database has its own tables and glossary notes. */
const cache = new Map<string, { value: DatabaseSchema; expiresAt: number }>();

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

async function introspect(database: string): Promise<DatabaseSchema> {
  const pool = await getPool(database);
  const [columnsResult, fkResult, freshness] = await Promise.all([
    pool.request().query(COLUMNS_SQL),
    pool.request().query(FOREIGN_KEYS_SQL),
    // Best effort - the glossary table may not exist in every SoftTrade database.
    pool.request().query(FRESHNESS_QUERY).catch(() => null),
  ]);

  const freshRow = freshness?.recordset?.[0] as Record<string, unknown> | undefined;
  const dataNote = freshRow ? freshnessNote(freshRow['lastBill'], freshRow['bills']) : '';

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

  const tables = [...byTable.values()];
  const tableNames = tables.map((table) => `${table.schema}.${table.name}`);

  return {
    database,
    tables,
    foreignKeys,
    notes: [unfamiliarDatabaseNote(database, tableNames), dataNote].filter(Boolean).join('\n\n'),
    loadedAt: new Date().toISOString(),
  };
}

export async function getSchema(database?: string, forceRefresh = false): Promise<DatabaseSchema> {
  const target = database || config.db.database;
  const cached = cache.get(target);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = await introspect(target);
  cache.set(target, { value, expiresAt: Date.now() + config.schemaTtlMs });
  console.log(
    `[schema] ${target}: loaded ${value.tables.length} tables/views, ${value.foreignKeys.length} foreign keys`
  );
  return value;
}

/** Just the table names - cheap enough to send when asking which tables a question needs. */
export function renderTableNamesForPrompt(schema: DatabaseSchema): string {
  return schema.tables
    .map((table) => `${table.schema}.${table.name}${table.kind === 'view' ? ' (view)' : ''}`)
    .join('\n');
}

/**
 * How many columns the whole schema may cost before the "nothing matched" fallback gives up
 * and sends bare table names instead. A 220-table SoftTrade database is far past this; the
 * small companion databases on the same server are nowhere near it.
 */
const FALLBACK_COLUMN_BUDGET = 800;

/**
 * Compact, token-efficient rendering of the schema for the system prompt.
 * Passing `only` restricts it to the tables a question actually needs, which keeps the
 * prompt inside the account's tokens-per-minute limit on a 246-table database.
 */
export function renderSchemaForPrompt(schema: DatabaseSchema, only?: Set<string>): string {
  const lines: string[] = [`Database: ${schema.database} (Microsoft SQL Server)`, '', 'TABLES AND VIEWS:'];

  let wanted = only
    ? schema.tables.filter(
        (table) =>
          only.has(`${table.schema}.${table.name}`.toLowerCase()) ||
          only.has(table.name.toLowerCase())
      )
    : schema.tables;

  // The selection step matches nothing on a database that does not follow the SoftTrade
  // layout, and an empty schema makes the model ask the user for one. Send the whole thing
  // instead whenever it is small enough to afford.
  if (only && !wanted.length) {
    const columnCount = schema.tables.reduce((total, table) => total + table.columns.length, 0);
    wanted = columnCount <= FALLBACK_COLUMN_BUDGET ? schema.tables : [];
  }

  if (!wanted.length) {
    // Too large to send in full, and nothing matched. Names alone still let the model say
    // what this database holds rather than guess at columns it has never seen.
    lines.push(
      '(no table matched this question - only the names are listed, so do not guess at columns)',
      renderTableNamesForPrompt(schema)
    );
    return lines.join('\n');
  }

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
