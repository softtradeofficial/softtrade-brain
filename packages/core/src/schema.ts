import type { DatabaseClient } from './db';
import type { BrainConfig, DatabaseSchema, ForeignKeyInfo, TableInfo, UserContext } from './types';
import { createTableFilter, buildFreshnessQuery, freshnessNote } from './domain';
import { filterTablesForUser } from './permissions';

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
    return type + '(' + (maxLength === -1 ? 'max' : maxLength) + ')';
  }
  if (type === 'decimal' || type === 'numeric') {
    return type + '(' + precision + ',' + scale + ')';
  }
  return type;
}

export class SchemaManager {
  private cache: { value: DatabaseSchema; expiresAt: number } | null = null;
  private isExcluded: (tableName: string) => boolean;

  constructor(private readonly db: DatabaseClient, private readonly config: BrainConfig) {
    this.isExcluded = createTableFilter(config);
  }

  public async getSchema(forceRefresh = false): Promise<DatabaseSchema> {
    if (!forceRefresh && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    const pool = await this.db.getPool();
    const allowed = this.config.allowedSchemas || ['dbo'];
    const freshnessQuery = buildFreshnessQuery(this.config);

    const [columnsResult, fkResult, freshness] = await Promise.all([
      pool.request().query(COLUMNS_SQL),
      pool.request().query(FOREIGN_KEYS_SQL),
      pool.request().query(freshnessQuery).catch(() => null),
    ]);

    const freshRow = freshness?.recordset?.[0] as Record<string, unknown> | undefined;
    const notes = freshRow ? freshnessNote(freshRow['lastBill'], freshRow['bills']) : '';

    const byTable = new Map<string, TableInfo>();

    for (const row of columnsResult.recordset as Record<string, unknown>[]) {
      const schema = String(row['schema']);
      if (allowed.length && !allowed.includes(schema)) continue;

      const name = String(row['table']);
      if (this.isExcluded(name)) continue;

      const key = schema + '.' + name;
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

    const value: DatabaseSchema = {
      database: this.config.db.database,
      tables: [...byTable.values()],
      foreignKeys,
      notes,
      loadedAt: new Date().toISOString(),
    };

    this.cache = { value, expiresAt: Date.now() + (this.config.schemaTtlMs ?? 600000) };
    return value;
  }

  public renderTableNames(schema: DatabaseSchema, user?: UserContext): string {
    const filtered = filterTablesForUser(schema.tables, user);
    return filtered
      .map((table) => table.schema + '.' + table.name + (table.kind === 'view' ? ' (view)' : ''))
      .join('\n');
  }

  public renderSchemaForPrompt(
    schema: DatabaseSchema,
    only?: Set<string>,
    user?: UserContext
  ): string {
    const lines: string[] = ['Database: ' + schema.database + ' (Microsoft SQL Server)', '', 'TABLES AND VIEWS:'];
    const filtered = filterTablesForUser(schema.tables, user);

    const wanted = only
      ? filtered.filter(
          (table) =>
            only.has((table.schema + '.' + table.name).toLowerCase()) ||
            only.has(table.name.toLowerCase())
        )
      : filtered;

    for (const table of wanted) {
      const cols = table.columns
        .map((c) => c.name + ' ' + c.type + (c.nullable ? '' : ' NOT NULL'))
        .join(', ');
      lines.push('- [' + table.schema + '].[' + table.name + ']' + (table.kind === 'view' ? ' (view)' : '') + ': ' + cols);
    }

    const relevantKeys = only
      ? schema.foreignKeys.filter(
          (fk) => only.has(fk.from.toLowerCase()) || only.has(fk.to.toLowerCase())
        )
      : schema.foreignKeys;

    if (relevantKeys.length) {
      lines.push('', 'FOREIGN KEYS:');
      for (const fk of relevantKeys) {
        lines.push('- ' + fk.from + '.' + fk.fromColumn + ' -> ' + fk.to + '.' + fk.toColumn);
      }
    }

    return lines.join('\n');
  }
}
