import type * as sql from 'mssql';
import type { ERPContextPayload, TableInfo, UserContext } from './types';

export const MODULE_TABLE_MAP: Record<string, string[]> = {
  SALES: ['invtrantbl', 'sihdr', 'sidtl', 'ordhdr', 'orddtl', 'sigsttaxsummary'],
  PURCHASE: ['invtrantbl', 'grndtl', 'gsttrandtl', 'irhdr'],
  STOCK: ['stock', 'item', 'itembal', 'itemgroupbal', 'godownlotstk', 'itbatchbal', 'itlotstock', 'plotstock'],
  ACCOUNTS: ['account', 'vheader', 'vntype', 'acbal', 'accurbal', 'acrepbal', 'tdsvhdtl', 'bkdetail', 'bankacdetails'],
  PARTY: ['party', 'account', 'partysetting', 'partycatgcreditcontrol', 'partyitemgroup'],
  COMPANY: ['company', 'companydivisionrelation', 'companysession'],
  AREA: ['area', 'district', 'statemaster', 'station', 'country', 'headqtrdistrictrelation'],
};

const SENSITIVE_COLUMNS = new Set([
  'userpwd',
  'password',
  'refcode',
  'lockpwd',
]);

export async function resolveUserContextFromDb(
  pool: sql.ConnectionPool,
  userId: number,
  erpContext?: ERPContextPayload
): Promise<UserContext> {
  const sessionOverrides: Partial<UserContext> = {
    clientRegId: erpContext?.ClientRegId,
    regNo: erpContext?.RegNo,
    coSoftId: erpContext?.CoSoftId && erpContext.CoSoftId > 0 ? erpContext.CoSoftId : undefined,
    divId: erpContext?.DivId && erpContext.DivId > 0 ? erpContext.DivId : undefined,
    coFinyear: erpContext?.CoFinyear && erpContext.CoFinyear > 0 ? erpContext.CoFinyear : undefined,
    commonSalesOrder: erpContext?.CommonSalesOrder,
    appSoftCode: erpContext?.AppSoftCode,
    appSoftType: erpContext?.AppSoftType,
  };

  // Superadmin in SoftTrade ERP has UserId = -1 (or RoleId = -1 / 'admin') and no record in dbo.usermast
  if (
    userId === -1 ||
    erpContext?.RoleId === -1 ||
    (erpContext?.UserRole && erpContext.UserRole.toLowerCase().includes('admin')) ||
    (erpContext?.UserName && erpContext.UserName.toLowerCase() === 'admin')
  ) {
    return {
      userId: userId || -1,
      userCode: erpContext?.UserName || 'ADMIN',
      userName: erpContext?.UserName || 'Super Admin',
      isSuperUser: true,
      roleId: erpContext?.RoleId ?? -1,
      roleName: erpContext?.UserRole || 'SUPER ADMIN',
      allowedModules: Object.keys(MODULE_TABLE_MAP),
      ...sessionOverrides,
    };
  }

  // Built-in simulated store keeper profile for demo / testing
  if (userId === 999) {
    return {
      userId: 999,
      userCode: 'STORE_KEEPER',
      userName: 'Store Keeper (Simulated)',
      isSuperUser: false,
      roleId: 17,
      roleName: 'STORE KEEPER',
      allowedModules: ['STOCK', 'AREA', 'COMPANY'],
      restrictedTables: ['invtrantbl', 'sihdr', 'sidtl', 'ordhdr', 'orddtl', 'sigsttaxsummary', 'vheader', 'vntype', 'accurbal', 'acbal'],
      ...sessionOverrides,
    };
  }

  const req = pool.request();
  req.input('userId', userId);

  const [userRes, divRes, itemGroupRes, partyTypeRes] = await Promise.all([
    req.query(
      'SELECT u.[id], u.[userCode], u.[userName], u.[Superuser], u.[RoleId], u.[CoSoftId], u.[AllDivision], ' +
      'r.[Name] AS [RoleName] ' +
      'FROM [dbo].[usermast] u ' +
      'LEFT JOIN [dbo].[RoleMaster] r ON r.[id] = u.[RoleId] ' +
      'WHERE u.[id] = @userId;'
    ),
    req.query('SELECT [DivId] FROM [dbo].[UserDivision] WHERE [UserId] = @userId;'),
    req.query('SELECT [ItemGroupId] FROM [dbo].[UserItemGroups] WHERE [UserId] = @userId;'),
    req.query('SELECT [PtType] FROM [dbo].[UserPartyType] WHERE [UserId] = @userId;'),
  ]);

  const user = userRes.recordset[0];
  if (!user) {
    if (erpContext) {
      return {
        userId,
        userCode: erpContext.UserName || String(userId),
        userName: erpContext.UserName || 'User',
        isSuperUser: !erpContext.RoleId || erpContext.RoleId <= 0,
        roleId: erpContext.RoleId,
        roleName: erpContext.UserRole || 'User',
        allowedModules: Object.keys(MODULE_TABLE_MAP),
        ...sessionOverrides,
      };
    }
    throw new Error('User with id ' + userId + ' was not found in [dbo].[usermast].');
  }

  const isSuperUser = !!user.Superuser || user.RoleId === -1;
  const divisions = (divRes.recordset as Array<{ DivId: number }>).map((r) => r.DivId);
  const itemGroups = (itemGroupRes.recordset as Array<{ ItemGroupId: number }>).map((r) => r.ItemGroupId);
  const partyTypes = (partyTypeRes.recordset as Array<{ PtType: string }>).map((r) => r.PtType);

  if (isSuperUser) {
    return {
      userId: user.id,
      userCode: user.userCode,
      userName: erpContext?.UserName || user.userName,
      isSuperUser: true,
      roleId: user.RoleId,
      roleName: erpContext?.UserRole || user.RoleName || 'SuperUser',
      coSoftId: sessionOverrides.coSoftId ?? user.CoSoftId,
      divId: sessionOverrides.divId,
      coFinyear: sessionOverrides.coFinyear,
      commonSalesOrder: sessionOverrides.commonSalesOrder,
      clientRegId: sessionOverrides.clientRegId,
      regNo: sessionOverrides.regNo,
      appSoftCode: sessionOverrides.appSoftCode,
      appSoftType: sessionOverrides.appSoftType,
      allowedDivisions: divisions,
      allowedItemGroups: itemGroups,
      allowedPartyTypes: partyTypes,
      allowedModules: Object.keys(MODULE_TABLE_MAP),
    };
  }

  const rolesReq = pool.request();
  rolesReq.input('roleId', user.RoleId);
  const roleRes = await rolesReq.query(
    'SELECT [MenuId], [ViewRights] FROM [dbo].[UserRoles] WHERE [RoleId] = @roleId AND [ViewRights] = 1;'
  );

  const allowedModules: string[] = ['AREA', 'COMPANY'];
  const menuIds = new Set((roleRes.recordset as Array<{ MenuId: number }>).map((r) => r.MenuId));

  let hasSales = false;
  let hasPurchase = false;
  let hasAccounts = false;
  let hasStock = false;
  let hasParty = false;

  for (const mid of menuIds) {
    if (mid >= 1000 && mid < 2000) hasSales = true;
    else if (mid >= 2000 && mid < 3000) hasPurchase = true;
    else if (mid >= 3000 && mid < 4000) hasAccounts = true;
    else if (mid >= 4000 && mid < 5000) hasStock = true;
    else if (mid >= 5000 && mid < 6000) hasParty = true;
  }

  // Production / Store roles (e.g. Role 17) have access to Stock, not Sales
  if (user.RoleId === 17) {
    hasStock = true;
    hasSales = false;
  }

  if (hasSales) allowedModules.push('SALES');
  if (hasPurchase) allowedModules.push('PURCHASE');
  if (hasAccounts) allowedModules.push('ACCOUNTS');
  if (hasStock) allowedModules.push('STOCK');
  if (hasParty) allowedModules.push('PARTY');

  return {
    userId: user.id,
    userCode: user.userCode,
    userName: erpContext?.UserName || user.userName,
    isSuperUser: false,
    roleId: user.RoleId,
    roleName: erpContext?.UserRole || user.RoleName,
    coSoftId: sessionOverrides.coSoftId ?? user.CoSoftId,
    divId: sessionOverrides.divId,
    coFinyear: sessionOverrides.coFinyear,
    commonSalesOrder: sessionOverrides.commonSalesOrder,
    clientRegId: sessionOverrides.clientRegId,
    regNo: sessionOverrides.regNo,
    appSoftCode: sessionOverrides.appSoftCode,
    appSoftType: sessionOverrides.appSoftType,
    allowedDivisions: user.AllDivision ? undefined : divisions,
    allowedItemGroups: itemGroups.length ? itemGroups : undefined,
    allowedPartyTypes: partyTypes.length ? partyTypes : undefined,
    allowedModules,
  };
}

export function filterTablesForUser(tables: TableInfo[], user?: UserContext): TableInfo[] {
  if (!user || user.isSuperUser) {
    return tables.map(maskSensitiveColumns);
  }

  const allowedModules = new Set((user.allowedModules || []).map((m) => m.toUpperCase()));
  const explicitAllowed = user.allowedTables ? new Set(user.allowedTables.map((t) => t.toLowerCase())) : null;
  const restricted = user.restrictedTables ? new Set(user.restrictedTables.map((t) => t.toLowerCase())) : new Set<string>();

  return tables
    .filter((table) => {
      const lowerName = table.name.toLowerCase();
      if (restricted.has(lowerName)) return false;
      if (explicitAllowed && explicitAllowed.has(lowerName)) return true;

      for (const [moduleName, moduleTables] of Object.entries(MODULE_TABLE_MAP)) {
        if (moduleTables.includes(lowerName)) {
          return allowedModules.has(moduleName);
        }
      }

      return true;
    })
    .map(maskSensitiveColumns);
}

function maskSensitiveColumns(table: TableInfo): TableInfo {
  return {
    ...table,
    columns: table.columns.filter((c) => !SENSITIVE_COLUMNS.has(c.name.toLowerCase())),
  };
}

export function buildUserScopePrompt(user?: UserContext): string {
  if (!user) return '';

  const sessionLines: string[] = [];
  if (user.coSoftId && user.coSoftId > 0) {
    sessionLines.push(
      `- Active ERP Session Company: [CoSoftId] = ${user.coSoftId}` +
        (user.commonSalesOrder !== undefined ? ` (CommonSalesOrder = ${user.commonSalesOrder ? 1 : 0})` : '') +
        `. Default to filtering by [CoSoftId] = ${user.coSoftId} on transaction tables (and include -1/0 on master/order tables as appropriate) unless the user asks about all companies or another specific company.`
    );
  }
  if (user.coFinyear && user.coFinyear > 0) {
    sessionLines.push(
      `- Active ERP Session Financial Year: [CoFinyear] = ${user.coFinyear} (FY ${user.coFinyear}-${String(user.coFinyear + 1).slice(-2)}). When filtering by financial year without a different year specified by the user, use [CoFinyear] = ${user.coFinyear}.`
    );
  }
  if (user.divId && user.divId > 0) {
    sessionLines.push(`- Active ERP Session Division: [DivId] = ${user.divId}.`);
  }

  if (user.isSuperUser) {
    if (!sessionLines.length) return '';
    return ['ACTIVE ERP SESSION CONTEXT:', ...sessionLines].join('\n');
  }

  const allModules = Object.keys(MODULE_TABLE_MAP);
  const userModules = new Set((user.allowedModules || []).map((m) => m.toUpperCase()));
  const forbiddenModules = allModules.filter((m) => !userModules.has(m));

  const constraints: string[] = [
    'USER SECURITY & PERMISSION CONSTRAINTS (MANDATORY):',
    '- Current User: "' + (user.userName || user.userCode || 'User') + '" (Role: ' + (user.roleName || 'Restricted') + ')',
    '- Permitted Modules: [' + Array.from(userModules).join(', ') + ']',
    ...sessionLines,
  ];

  if (forbiddenModules.length > 0) {
    constraints.push(
      '- FORBIDDEN Modules: [' + forbiddenModules.join(', ') + '].',
      '  You are STRICTLY FORBIDDEN from writing SQL queries against tables in forbidden modules (e.g. ' +
        forbiddenModules.map((m) => m + ': ' + MODULE_TABLE_MAP[m]?.join(', ')).join('; ') +
        ').',
      '  If the user asks for data from a forbidden module (for example asking for Sales Bills/Invoices when SALES is forbidden),',
      '  you MUST respond with action "answer" stating: "Access Denied: Your account role (' +
        (user.roleName || 'Restricted') +
        ') does not have permission to access ' +
        forbiddenModules.join('/') +
        ' data."'
    );
  }

  if (user.coSoftId) {
    constraints.push(
      '- Company boundary: MUST filter by [CoSoftId] = ' +
        user.coSoftId +
        ' on tables containing CoSoftId (e.g. InvTranTbl, SIHDR, ORDHDR, Stock, Vheader).'
    );
  }

  if (user.allowedDivisions && user.allowedDivisions.length > 0) {
    const divs = user.allowedDivisions.join(', ');
    constraints.push(
      '- Division boundary: Restricted to Division(s) [' + divs + ']. Filter [DivId] IN (' + divs + ') on tables containing DivId.'
    );
  }

  if (user.salesPersonId) {
    constraints.push(
      '- Sales representative boundary: Filter [SalePersonId] = ' +
        user.salesPersonId +
        ' or [SPId] = ' +
        user.salesPersonId +
        ' for sales queries.'
    );
  }

  if (user.allowedPartyTypes && user.allowedPartyTypes.length > 0) {
    const types = user.allowedPartyTypes.map((t) => "'" + t + "'").join(', ');
    constraints.push('- Party type boundary: Filter [PtType] IN (' + types + ') on [Party].');
  }

  return constraints.join('\n');
}
