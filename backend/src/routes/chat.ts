import { Router } from 'express';
import { runQuery } from '../db';
import { getSchema, renderSchemaForPrompt, renderTableNamesForPrompt } from '../schema';
import {
  explainResult,
  planQuery,
  repairQuery,
  selectTables,
  toTableFilter,
  type ChatTurn,
} from '../llm';
import { guardSql, UnsafeSqlError } from '../sqlGuard';

export const chatRouter = Router();

interface ChatRequestBody {
  message?: unknown;
  history?: unknown;
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
    .slice(-10);
}

chatRouter.post('/chat', async (req, res) => {
  const body = req.body as ChatRequestBody;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const history = parseHistory(body.history);

  if (!message) {
    return res.status(400).json({ error: 'A "message" string is required.' });
  }

  try {
    const schema = await getSchema();

    // Pick the relevant tables first, then send only those columns. Sending all 246 tables
    // costs ~25k tokens per question and trips the account's tokens-per-minute limit.
    const selected = await selectTables(message, history, renderTableNamesForPrompt(schema));
    const schemaText = renderSchemaForPrompt(schema, toTableFilter(selected));

    let plan = await planQuery(message, history, schemaText, schema.notes);

    if (plan.action === 'answer') {
      return res.json({ answer: plan.message, sql: null, rows: [], columns: [], rowCount: 0 });
    }

    let guarded = guardSql(plan.sql);
    let result;

    try {
      result = await runQuery(guarded.sql);
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
          rows: [],
          columns: [],
          rowCount: 0,
          error: dbMessage,
        });
      }

      plan = retryPlan;
      guarded = guardSql(retryPlan.sql);
      result = await runQuery(guarded.sql);
    }

    const answer = await explainResult(message, guarded.sql, result, schema.notes);

    return res.json({
      answer,
      sql: guarded.sql,
      intent: plan.intent,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
    });
  } catch (error) {
    if (error instanceof UnsafeSqlError) {
      return res.status(400).json({ error: error.message });
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[chat] failed:', detail);
    return res.status(500).json({ error: detail });
  }
});

chatRouter.get('/schema', async (_req, res) => {
  try {
    const schema = await getSchema(_req.query['refresh'] === 'true');
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
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
