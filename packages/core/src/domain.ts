import type { BrainConfig } from './types';

const DEFAULT_EXCLUDED_PATTERNS: RegExp[] = [
  /bak$/i,
  /backup/i,
  /_old$/i,
  /^tmp/i,
  /^temp/i,
  /[_]?\d{6,8}$/,
];

const DEFAULT_EXCLUDED_NAMES = new Set(
  ['abc', 'AcBal123', 'Stock2', 'CsConst20', 'Taxtypenew', 'ItemGroupStateRealtion', 'SoftwareErrors'].map((n) =>
    n.toLowerCase()
  )
);

export function createTableFilter(config: BrainConfig): (tableName: string) => boolean {
  const extraExclusions = new Set((config.excludeTables || []).map((n) => n.trim().toLowerCase()));

  return (name: string): boolean => {
    const lower = name.toLowerCase();
    if (DEFAULT_EXCLUDED_NAMES.has(lower) || extraExclusions.has(lower)) return true;
    return DEFAULT_EXCLUDED_PATTERNS.some((pattern) => pattern.test(name));
  };
}

export function buildBusinessGlossary(config: BrainConfig): string {
  const salesSeries = config.salesInvoiceSeries || 'SIN';
  const purchaseSeries = (config.purchaseInvoiceSeries || ['PIN', 'PIO']).map((s) => "'" + s + "'").join(', ');

  return [
    'BUSINESS GLOSSARY (SoftTrade ERP)',
    '',
    'These mappings are verified. Prefer them over guessing from table names.',
    '',
    '- "bill" / "invoice" -> [dbo].[InvTranTbl], one row per bill. This is the main bill table.',
    '    bill number    = [InvSeqno], series prefix = [InvSR]',
    '    bill amount    = [EIInvAmt]',
    '    party/customer = [AccountId] joins to [dbo].[Account].[id]',
    '    document type  = [InvSR]',
    '',
    '- BILL DATE - ALWAYS USE [EIDocDate]. THIS IS CRITICAL:',
    '  The document date for EVERY row in [dbo].[InvTranTbl] is [EIDocDate]. It is populated across all rows.',
    '  Use it for "today", "this month", and every date range or ORDER BY.',
    '  NEVER use [GSTDate]: it holds a 1975 placeholder on all sales invoices, credit notes and debit notes.',
    '  [createDate] is an audit timestamp - not the bill date.',
    '',
    '- DOCUMENT TYPE FILTER - THIS IS MANDATORY:',
    '  [dbo].[InvTranTbl] holds sales invoices, purchase invoices, credit notes and debit notes together.',
    '  "bill" and "invoice" ALWAYS mean SALES invoices unless the user explicitly says otherwise, so EVERY query',
    '  against [dbo].[InvTranTbl] MUST include:',
    "      AND [InvSR] = '" + salesSeries + "'",
    '    - purchase bills          -> [InvSR] IN (' + purchaseSeries + ')',
    '    - credit notes            -> [InvSR] IN (\'SRC\',\'CNO\',\'CNI\')',
    '    - debit notes             -> [InvSR] IN (\'PTD\',\'DNI\',\'DNO\')',
    '    - all documents           -> no [InvSR] filter',
    '',
    '- Sale invoices also have a header row in [dbo].[SIHDR], joined',
    '  [dbo].[SIHDR].[InvTranIdNo] = [dbo].[InvTranTbl].[id]. Their line items are [dbo].[SIDtl].',
    "  Product-level quantities and rates for sales bills are recorded in [dbo].[Stock] (where [STSr] = '" + salesSeries + "' AND [STIRIdNo] = [InvTranTbl].[id]).",
    '',
    '- "order" -> [dbo].[ORDHDR] (header, date [OrdDate]) and [dbo].[OrdDtl] (lines).',
    '  Orders are NOT bills. Never answer a question about bills or invoices using ORDHDR.',
    '',
    '- "company" -> [dbo].[company]; name [COname], code [COCode].',
    '',
    '- "party" / "customer" / "supplier" -> [dbo].[Party], linked to ledgers via [PtAccountId].',
    '  The readable name always comes from [dbo].[Account].[AcName].',
    '',
    '- "account" / "ledger" -> [dbo].[Account] ([AcName], [AcCode], key [id]).',
    '',
    '- "voucher" / accounting entry -> [dbo].[Vheader] ([VhDate], [Vhno], [VhAmount], [VhAccountId]);',
    '  voucher type via [VhVnTypeId] -> [dbo].[Vntype] ([VtName], [VtShortName], [VtType]).',
    '',
    '- "stock" / inventory -> [dbo].[Stock]; item master -> [dbo].[Item].',
    '',
    '- "area" / "location" / "district" -> [dbo].[AREA] ([AreaName], [DistrictId]), [dbo].[District] ([DistrictName]), [dbo].[StateMaster] ([StateName]).',
    '',
    'IMPORTANT: This database has NO foreign key constraints. Only join tables using the relationships listed above; do not invent joins from column names that merely look similar.',
    '',
    config.customGlossary || '',
  ].join('\n').trim();
}

export function buildFreshnessQuery(config: BrainConfig): string {
  const salesSeries = config.salesInvoiceSeries || 'SIN';
  return "SELECT MAX([EIDocDate]) AS [lastBill], COUNT(*) AS [bills] FROM [dbo].[InvTranTbl] WHERE [InvSR] = '" + salesSeries + "'";
}

export function freshnessNote(lastBill: unknown, bills: unknown): string {
  if (!lastBill) return '';
  const date = new Date(String(lastBill)).toISOString().slice(0, 10);
  return [
    'DATA CURRENCY:',
    'The most recent sales bill in this database is dated ' + date + ' (' + bills + ' sales bills in total).',
    'If a question about "today" or any recent period returns no rows OR a count of 0, you MUST',
    'say so and then add that the most recent bill in the data is dated ' + date + '.',
    'Do not imply the business had no activity.',
  ].join('\n');
}
