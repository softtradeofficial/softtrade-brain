import { Router, Request } from 'express';
import { UnsafeSqlError, ERPContextPayload, UserContext } from '../../../packages/core/dist/index.js';
import { config } from '../config';
import { getBrainForClient } from '../csinfo';

export const chatRouter = Router();

interface ChatRequestBody {
  message?: unknown;
  history?: unknown;
  userId?: number;
  clientRegId?: number;
  regNo?: number;
  user?: UserContext;
  erpContext?: ERPContextPayload;
  ClientRegId?: number;
  CoSoftId?: number;
  UserId?: number;
  DivId?: number;
  CoFinyear?: number;
  CommonSalesOrder?: boolean;
  UserName?: string;
  RoleId?: number;
  UserRole?: string;
  RegNo?: number;
  AppSoftCode?: string;
  AppSoftType?: string;
}

function parseNum(val: unknown): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(val: unknown): boolean | undefined {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
  }
  return undefined;
}

export function extractErpContext(req: Request): ERPContextPayload {
  const body = (req.body || {}) as ChatRequestBody;
  const erp = body.erpContext || {};
  const headers = req.headers;
  const query = req.query || {};

  const ClientRegId =
    parseNum(erp.ClientRegId) ??
    parseNum(body.clientRegId) ??
    parseNum(body.ClientRegId) ??
    parseNum(headers['x-client-reg-id']) ??
    parseNum(query['clientRegId']) ??
    parseNum(query['ClientRegId']);

  const RegNo =
    parseNum(erp.RegNo) ??
    parseNum(body.regNo) ??
    parseNum(body.RegNo) ??
    parseNum(headers['x-reg-no']) ??
    parseNum(query['regNo']) ??
    parseNum(query['RegNo']);

  const UserId =
    parseNum(erp.UserId) ??
    parseNum(body.userId) ??
    parseNum(body.UserId) ??
    parseNum(headers['x-user-id']) ??
    parseNum(query['userId']);

  const CoSoftId =
    parseNum(erp.CoSoftId) ??
    parseNum(body.CoSoftId) ??
    parseNum(headers['x-cosoft-id']) ??
    parseNum(query['coSoftId']);

  const DivId =
    parseNum(erp.DivId) ??
    parseNum(body.DivId) ??
    parseNum(headers['x-div-id']) ??
    parseNum(query['divId']);

  const CoFinyear =
    parseNum(erp.CoFinyear) ??
    parseNum(body.CoFinyear) ??
    parseNum(headers['x-cofinyear']) ??
    parseNum(query['coFinyear']);

  const CommonSalesOrder =
    parseBool(erp.CommonSalesOrder) ??
    parseBool(body.CommonSalesOrder) ??
    parseBool(headers['x-common-sales-order']);

  const RoleId =
    parseNum(erp.RoleId) ??
    parseNum(body.RoleId) ??
    parseNum(headers['x-role-id']);

  const UserName =
    erp.UserName ??
    body.UserName ??
    (typeof headers['x-user-name'] === 'string' ? headers['x-user-name'] : undefined);

  const UserRole =
    erp.UserRole ??
    body.UserRole ??
    (typeof headers['x-user-role'] === 'string' ? headers['x-user-role'] : undefined);

  const AppSoftCode =
    erp.AppSoftCode ??
    body.AppSoftCode ??
    (typeof headers['x-app-soft-code'] === 'string' ? headers['x-app-soft-code'] : undefined);

  const AppSoftType =
    erp.AppSoftType ??
    body.AppSoftType ??
    (typeof headers['x-app-soft-type'] === 'string' ? headers['x-app-soft-type'] : undefined);

  return {
    ClientRegId,
    RegNo,
    UserId,
    CoSoftId,
    DivId,
    CoFinyear,
    CommonSalesOrder,
    RoleId,
    UserName,
    UserRole,
    AppSoftCode,
    AppSoftType,
  };
}

chatRouter.get('/health', async (req, res) => {
  const erpContext = extractErpContext(req);
  const modelLabel = `Hybrid (${config.openai.fastModel} / ${config.openai.standardModel})`;

  try {
    if (
      (erpContext.ClientRegId && erpContext.ClientRegId > 0) ||
      (erpContext.RegNo && erpContext.RegNo !== 0) ||
      (config.db.server && config.db.database)
    ) {
      const { clientInfo } = await getBrainForClient(erpContext.ClientRegId, erpContext.RegNo);
      return res.json({
        status: 'ok',
        mode: 'hybrid-dynamic-router',
        fastModel: config.openai.fastModel,
        standardModel: config.openai.standardModel,
        model: modelLabel,
        database: clientInfo?.database || config.db.database,
        clientName: clientInfo?.regName,
        clientRegId: clientInfo?.clientRegId,
        server: clientInfo?.server,
      });
    }

    return res.json({
      status: 'waiting_for_client',
      mode: 'hybrid-dynamic-router',
      fastModel: config.openai.fastModel,
      standardModel: config.openai.standardModel,
      model: modelLabel,
      database: 'Waiting for Client Context (CSInfo)...',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      status: 'error',
      model: modelLabel,
      database: 'Connection Error',
      error: detail,
    });
  }
});

chatRouter.post('/chat', async (req, res) => {
  const body = req.body as ChatRequestBody;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const history = Array.isArray(body.history) ? (body.history as any[]) : [];

  if (!message) {
    return res.status(400).json({ error: 'A "message" string is required.' });
  }

  try {
    const erpContext = extractErpContext(req);
    const { brain, clientInfo } = await getBrainForClient(erpContext.ClientRegId, erpContext.RegNo);

    // Resolve user context from header, body, or ERP context
    let user: UserContext | undefined = body.user;
    const userId = erpContext.UserId;

    if (!user && userId !== undefined && userId !== 0) {
      try {
        user = await brain.resolveUser(userId, erpContext);
      } catch (err) {
        console.warn(`[chat] Could not resolve user ${userId}:`, err);
      }
    } else if (!user && (erpContext.CoSoftId || erpContext.CoFinyear || erpContext.DivId)) {
      user = await brain.resolveUser(-1, erpContext);
    }

    const response = await brain.ask(message, history, { user });
    return res.json({
      ...response,
      database: clientInfo?.database || config.db.database,
      clientName: clientInfo?.regName,
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

chatRouter.get('/schema', async (req, res) => {
  try {
    const erpContext = extractErpContext(req);
    if (
      (!erpContext.ClientRegId || erpContext.ClientRegId <= 0) &&
      (!erpContext.RegNo || erpContext.RegNo === 0) &&
      (!config.db.server || !config.db.database)
    ) {
      return res.json({
        database: 'Waiting for Client Context (CSInfo)...',
        loadedAt: new Date().toISOString(),
        tables: [],
      });
    }

    const { brain, clientInfo } = await getBrainForClient(erpContext.ClientRegId, erpContext.RegNo);
    const schema = await brain.getSchema(req.query['refresh'] === 'true');
    return res.json({
      database: clientInfo?.database || schema.database,
      clientName: clientInfo?.regName,
      clientRegId: clientInfo?.clientRegId,
      loadedAt: schema.loadedAt,
      tables: schema.tables.map((table) => ({
        name: `${table.schema}.${table.name}`,
        kind: table.kind,
        columns: table.columns.map((column) => column.name),
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

chatRouter.get('/users', async (req, res) => {
  try {
    const erpContext = extractErpContext(req);
    const { brain } = await getBrainForClient(erpContext.ClientRegId, erpContext.RegNo);
    const result = await brain.executeRawQuery(`
      SELECT TOP (10) u.[id], u.[userCode], u.[userName], u.[Superuser], u.[RoleId], u.[CoSoftId],
             r.[Name] AS [RoleName]
      FROM [dbo].[usermast] u
      LEFT JOIN [dbo].[RoleMaster] r ON r.[id] = u.[RoleId]
      WHERE u.[deactivate] = 0 OR u.[deactivate] IS NULL
      ORDER BY u.[id];
    `);
    return res.json(result.rows);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
