import type { Request, Response } from 'express';
import type { SoftTradeBrain } from './SoftTradeBrain';
import type { ChatTurn, UserContext } from './types';
import { UnsafeSqlError } from './sqlGuard';

export interface BrainRequestHandlerOptions {
  getUserContext?: (req: Request) => Promise<UserContext | undefined> | UserContext | undefined;
}

export function createChatHandler(brain: SoftTradeBrain, options: BrainRequestHandlerOptions = {}) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      const history = Array.isArray(req.body?.history) ? (req.body.history as ChatTurn[]) : [];

      if (!message) {
        res.status(400).json({ error: 'A "message" string is required in request body.' });
        return;
      }

      let user: UserContext | undefined;
      if (options.getUserContext) {
        user = await options.getUserContext(req);
      } else if ((req as any).user) {
        user = (req as any).user as UserContext;
      }

      const response = await brain.ask(message, history, { user });
      res.json(response);
    } catch (error) {
      if (error instanceof UnsafeSqlError) {
        res.status(400).json({ error: error.message });
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[SoftTradeBrain API Error]:', detail);
      res.status(500).json({ error: detail });
    }
  };
}

export function createSchemaHandler(brain: SoftTradeBrain) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const refresh = req.query['refresh'] === 'true';
      const schema = await brain.getSchema(refresh);
      res.json({
        database: schema.database,
        loadedAt: schema.loadedAt,
        tables: schema.tables.map((t) => ({
          name: t.schema + '.' + t.name,
          kind: t.kind,
          columns: t.columns.map((c) => c.name),
        })),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: detail });
    }
  };
}
