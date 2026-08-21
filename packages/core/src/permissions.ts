import type * as sql from 'mssql';
import type { TableInfo, UserContext } from './types';

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

export async function resolveUserContextFromDb(pool: sql.ConnectionPool, userId: number): Promise<UserContext> {
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
      userName: user.userName,
      isSuperUser: true,
      roleId: user.RoleId,
      roleName: user.RoleName || 'SuperUser',
      coSoftId: user.CoSoftId,
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
    userName: user.userName,
    isSuperUser: false,
    roleId: user.RoleId,
    roleName: user.RoleName,
    coSoftId: user.CoSoftId,
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
  if (!user || user.isSuperUser) return '';

  const allModules = Object.keys(MODULE_TABLE_MAP);
  const userModules = new Set((user.allowedModules || []).map((m) => m.toUpperCase()));
  const forbiddenModules = allModules.filter((m) => !userModules.has(m));

  const constraints: string[] = [
    'USER SECURITY & PERMISSION CONSTRAINTS (MANDATORY):',
    '- Current User: "' + (user.userName || user.userCode || 'User') + '" (Role: ' + (user.roleName || 'Restricted') + ')',
    '- Permitted Modules: [' + Array.from(userModules).join(', ') + ']',
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
