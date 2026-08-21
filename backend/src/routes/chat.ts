import { Router } from 'express';
import { listDatabases, resolveDatabase, runQuery, UnknownDatabaseError } from '../db';
import { getSchema, renderSchemaForPrompt, renderTableNamesForPrompt } from '../schema';
import {
  explainResult,
  planQuery,
  recentTables,
  repairQuery,
  selectTables,
  tablesMatchingQuestion,
  toTableFilter,
  type ChatTurn,
} from '../llm';
import { guardSql, UnsafeSqlError } from '../sqlGuard';

export const chatRouter = Router();

interface ChatRequestBody {
  message?: unknown;
  history?: unknown;
  database?: unknown;
}

function parseHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (turn): turn is ChatTurn =>
        !!turn &&
        typeof turn === 'object' &&
        typeof (turn as ChatTurn).content === 'string' &&
        ((turn as ChatTurn).role === 'user' || (turn as ChatTurn).role === 'assistant')
    )
    .slice(-10)
    .map((turn) => ({
      role: turn.role,
      content: turn.content,
      sql: typeof turn.sql === 'string' ? turn.sql : undefined,
    }));
}

chatRouter.post('/chat', async (req, res) => {
  const body = req.body as ChatRequestBody;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const history = parseHistory(body.history);

  if (!message) {
    return res.status(400).json({ error: 'A "message" string is required.' });
  }

  try {
    // Every question is answered against the database the user picked in the sidebar.
    const database = await resolveDatabase(body.database);
    const schema = await getSchema(database);

    // Pick the relevant tables first, then send only those columns. Sending all 246 tables
    // costs ~25k tokens per question and trips the account's tokens-per-minute limit.
    //
    // Two hints go in alongside the question: the tables the last answer used, so a follow-up
    // keeps the subject it was already about, and any whose name literally matches the
    // question, because the model-driven pick can miss a subject the glossary never mentions.
    const qualifiedNames = schema.tables.map((table) => `${table.schema}.${table.name}`);
    const carried = recentTables(history);
    const matched = tablesMatchingQuestion(message, qualifiedNames);

    const selected = await selectTables(
      message,
      history,
      renderTableNamesForPrompt(schema),
      carried,
      matched
    );
    const schemaText = renderSchemaForPrompt(schema, toTableFilter(selected, [...carried, ...matched]));

    let plan = await planQuery(message, history, schemaText, schema.notes);

    if (plan.action === 'answer') {
      return res.json({
        answer: plan.message,
        sql: null,
        database,
        rows: [],
        columns: [],
        rowCount: 0,
      });
    }

    let guarded = guardSql(plan.sql);
    let result;

    try {
      result = await runQuery(guarded.sql, database);
    } catch (dbError) {
      // One self-correction pass: SQL Server's own error message is usually enough
      // for the model to fix a wrong column or join.
      const dbMessage = dbError instanceof Error ? dbError.message : String(dbError);
      console.warn('[chat] first query failed, retrying:', dbMessage);

      const retryPlan = await repairQuery(message, guarded.sql, dbMessage, schemaText, schema.notes);
      if (retryPlan.action !== 'query') {
        return res.json({
          answer: retryPlan.action === 'answer' ? retryPlan.message : dbMessage,
          sql: guarded.sql,
          database,
          rows: [],
          columns: [],
          rowCount: 0,
          error: dbMessage,
        });
      }

      plan = retryPlan;
      guarded = guardSql(retryPlan.sql);
      result = await runQuery(guarded.sql, database);
    }

    const answer = await explainResult(message, guarded.sql, result, schema.notes);

    return res.json({
      answer,
      sql: guarded.sql,
      database,
      intent: plan.intent,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
    });
  } catch (error) {
    if (error instanceof UnsafeSqlError || error instanceof UnknownDatabaseError) {
      return res.status(400).json({ error: error.message });
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[chat] failed:', detail);
    return res.status(500).json({ error: detail });
  }
});

chatRouter.get('/databases', async (req, res) => {
  try {
    const databases = await listDatabases(req.query['refresh'] === 'true');
    res.json({ databases, current: databases.find((entry) => entry.isDefault)?.name });
  } catch (error) {
    const status = error instanceof UnknownDatabaseError ? 400 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

chatRouter.get('/schema', async (_req, res) => {
  try {
    const database = await resolveDatabase(_req.query['database']);
    const schema = await getSchema(database, _req.query['refresh'] === 'true');
    res.json({
      database: schema.database,
      loadedAt: schema.loadedAt,
      tables: schema.tables.map((table) => ({
        name: `${table.schema}.${table.name}`,
        kind: table.kind,
        columns: table.columns.map((column) => column.name),
      })),
    });
  } catch (error) {
    const status = error instanceof UnknownDatabaseError ? 400 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
