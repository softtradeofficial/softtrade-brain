import { DatabaseClient } from './db';
import { SchemaManager } from './schema';
import { LLMClient } from './llm';
import { guardSql } from './sqlGuard';
import { resolveUserContextFromDb, filterTablesForUser } from './permissions';
import type {
  AskOptions,
  BrainConfig,
  BrainResponse,
  ChatTurn,
  DatabaseSchema,
  QueryResult,
  TableInfo,
  UserContext,
} from './types';

export class SoftTradeBrain {
  private readonly db: DatabaseClient;
  private readonly schemaMgr: SchemaManager;
  private readonly llm: LLMClient;

  constructor(private readonly config: BrainConfig) {
    this.db = new DatabaseClient(config.db, config.queryTimeoutMs);
    this.schemaMgr = new SchemaManager(this.db, config);
    this.llm = new LLMClient(config);
  }

  public async getSchema(forceRefresh = false): Promise<DatabaseSchema> {
    return this.schemaMgr.getSchema(forceRefresh);
  }

  public async resolveUser(userId: number): Promise<UserContext> {
    const pool = await this.db.getPool();
    return resolveUserContextFromDb(pool, userId);
  }

  public async ask(
    question: string,
    history: ChatTurn[] = [],
    options: AskOptions = {}
  ): Promise<BrainResponse> {
    const trimmed = question.trim();
    if (!trimmed) {
      return { answer: 'Please provide a valid question.', sql: null, rowCount: 0, rows: [], columns: [] };
    }

    const user = options.user;
    const maxTables = options.maxSelectedTables ?? 12;
    const maxRows = this.config.maxRows ?? 200;

    const schema = await this.getSchema();
    const tableNames = this.schemaMgr.renderTableNames(schema, user);

    const selected = await this.llm.selectTables(trimmed, history, tableNames, user, maxTables);
    const schemaText = this.schemaMgr.renderSchemaForPrompt(schema, this.llm.toTableFilter(selected), user);

    let plan = await this.llm.planQuery(trimmed, history, schemaText, schema.notes, user, selected);

    if (plan.action === 'answer') {
      return {
        answer: plan.message,
        sql: null,
        rows: [],
        columns: [],
        rowCount: 0,
        modelUsed: plan.modelUsed,
        isComplex: plan.isComplex,
      };
    }

    let guarded = guardSql(plan.sql, maxRows);

    // Hard server-side security check: verify that all referenced tables are permitted for this user
    if (user && !user.isSuperUser) {
      const allowedTables = filterTablesForUser(schema.tables, user);
      const allowedSet = new Set(allowedTables.map((t) => t.name.toLowerCase()));

      const tableRefRegex = /(?:FROM|JOIN)\s+(?:\[?dbo\]?\.)?\[?([a-zA-Z0-9_]+)\]?/gi;
      let match: RegExpExecArray | null;
      while ((match = tableRefRegex.exec(guarded.sql)) !== null) {
        const tbl = match[1].toLowerCase();
        if (!allowedSet.has(tbl)) {
          return {
            answer:
              'Access Denied: Your account role (' +
              (user.roleName || 'Restricted') +
              ") does not have permission to view '" +
              match[1] +
              "' data.",
            sql: guarded.sql,
            rows: [],
            columns: [],
            rowCount: 0,
            error: 'Unauthorized table access: ' + match[1],
          };
        }
      }
    }

    let result: QueryResult;

    try {
      result = await this.db.runQuery(guarded.sql, maxRows);
    } catch (dbError) {
      const dbMessage = dbError instanceof Error ? dbError.message : String(dbError);

      const retryPlan = await this.llm.repairQuery(
        trimmed,
        guarded.sql,
        dbMessage,
        schemaText,
        schema.notes,
        user
      );

      if (retryPlan.action !== 'query') {
        return {
          answer: retryPlan.action === 'answer' ? retryPlan.message : dbMessage,
          sql: guarded.sql,
          rows: [],
          columns: [],
          rowCount: 0,
          error: dbMessage,
        };
      }

      plan = retryPlan;
      guarded = guardSql(retryPlan.sql, maxRows);
      result = await this.db.runQuery(guarded.sql, maxRows);
    }

    const answer = await this.llm.explainResult(trimmed, guarded.sql, result, schema.notes, plan.isComplex);

    return {
      answer,
      sql: guarded.sql,
      intent: plan.intent,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
      modelUsed: plan.modelUsed,
      isComplex: plan.isComplex,
    };
  }

  public async executeRawQuery(sql: string): Promise<QueryResult> {
    const guarded = guardSql(sql, this.config.maxRows ?? 200);
    return this.db.runQuery(guarded.sql, this.config.maxRows ?? 200);
  }

  public async destroy(): Promise<void> {
    await this.db.close();
  }
}
