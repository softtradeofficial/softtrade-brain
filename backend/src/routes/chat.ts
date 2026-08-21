import { Router } from 'express';
import { SoftTradeBrain, UnsafeSqlError } from '../../../packages/core/dist/index.js';
import { config } from '../config';

export const chatRouter = Router();

const brain = new SoftTradeBrain({
  db: {
    server: config.db.server,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    instanceName: config.db.instanceName,
    port: config.db.port,
    encrypt: config.db.encrypt,
    trustServerCertificate: config.db.trustServerCertificate,
  },
  openai: {
    apiKey: config.openai.apiKey,
    model: config.openai.model,
  },
  maxRows: config.maxRows,
  maxRowsForSummary: config.maxRowsForSummary,
  queryTimeoutMs: config.queryTimeoutMs,
  schemaTtlMs: config.schemaTtlMs,
  allowedSchemas: config.allowedSchemas,
});

interface ChatRequestBody {
  message?: unknown;
  history?: unknown;
  userId?: number;
  user?: any;
}

chatRouter.post('/chat', async (req, res) => {
  const body = req.body as ChatRequestBody;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const history = Array.isArray(body.history) ? (body.history as any[]) : [];

  if (!message) {
    return res.status(400).json({ error: 'A "message" string is required.' });
  }

  try {
    // Resolve user context from header, body, or session
    let user = body.user;
    const userId = body.userId ?? (req.headers['x-user-id'] ? Number(req.headers['x-user-id']) : undefined);

    if (!user && userId) {
      try {
        user = await brain.resolveUser(userId);
      } catch (err) {
        console.warn(`[chat] Could not resolve user ${userId}:`, err);
      }
    }

    const response = await brain.ask(message, history, { user });
    return res.json(response);
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
    const schema = await brain.getSchema(_req.query['refresh'] === 'true');
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

chatRouter.get('/users', async (_req, res) => {
  try {
    const result = await brain.executeRawQuery(`
      SELECT TOP (10) u.[id], u.[userCode], u.[userName], u.[Superuser], u.[RoleId], u.[CoSoftId],
             r.[Name] AS [RoleName]
      FROM [dbo].[usermast] u
      LEFT JOIN [dbo].[RoleMaster] r ON r.[id] = u.[RoleId]
      WHERE u.[deactivate] = 0 OR u.[deactivate] IS NULL
      ORDER BY u.[id];
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

