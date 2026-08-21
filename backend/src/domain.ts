/**
 * Domain knowledge that cannot be discovered from INFORMATION_SCHEMA.
 *
 * The SoftTrade schema uses abbreviated table names (SIHDR, InvTranTbl, ORDHDR) and carries
 * no foreign key constraints, so the model has nothing to infer relationships from. Everything
 * below was verified against the live database - keep it that way, because a wrong hint here
 * is worse than no hint at all.
 */

/** Backup, scratch and superseded copies. Including them wastes tokens and invites wrong answers. */
const EXCLUDED_PATTERNS: RegExp[] = [
  /bak$/i, // AcBalbak, itembal_bak, GodownLotStk_bak
  /backup/i, // Orddtl_Backup, stock_backup, gsttrandtl_backup2026
  /_old$/i, // Party_old, ItemTaxRate_old
  /^tmp/i, // tmpAcBal
  /^temp/i, // TempAccountMast, tempItemRate
  /[_]?\d{6,8}$/, // ItemBal_25092024, mastbyid_28052024
];

/** One-off names that no pattern catches cleanly. */
const EXCLUDED_NAMES = new Set(
  ['abc', 'AcBal123', 'Stock2', 'CsConst20', 'Taxtypenew', 'ItemGroupStateRealtion'].map((n) =>
    n.toLowerCase()
  )
);

/** Extra exclusions from EXCLUDE_TABLES in .env, comma separated. */
const envExclusions = new Set(
  (process.env.EXCLUDE_TABLES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export function isExcludedTable(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXCLUDED_NAMES.has(lower) || envExclusions.has(lower)) return true;
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Document series code for a SALES invoice in [dbo].[InvTranTbl].[InvSR].
 *
 * Verified against this database: [dbo].[Vntype] defines VtName 'Sales Invoice' / VtType 'SALE'
 * with InvSr = 'SIN', and 20,541 of the 24,856 rows carry 'SIN'. There are no 'INV' rows.
 * Override with SALES_INVOICE_SERIES in .env if another SoftTrade database uses a different code.
 */
export const SALES_INVOICE_SERIES = process.env.SALES_INVOICE_SERIES ?? 'SIN';

/** Purchase invoice series codes, for "how many purchase bills" style questions. */
export const PURCHASE_INVOICE_SERIES = (process.env.PURCHASE_INVOICE_SERIES ?? 'PIN,PIO')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Business vocabulary. Every mapping below has been checked against real rows -
 * for example the party join was confirmed by listing the top customers by bill count.
 */
export const BUSINESS_GLOSSARY = `
BUSINESS GLOSSARY (SoftTrade ERP)

These mappings are verified. Prefer them over guessing from table names.

- "bill" / "invoice" -> [dbo].[InvTranTbl], one row per bill. This is the main bill table.
    bill number    = [InvSeqno], series prefix = [InvSR]
    bill amount    = [EIInvAmt]
    party/customer = [AccountId] joins to [dbo].[Account].[id]
    document type  = [InvSR]

- BILL DATE - ALWAYS USE [EIDocDate]. THIS IS CRITICAL:
  The document date for EVERY row in [dbo].[InvTranTbl] is [EIDocDate]. It is populated on all
  24,856 rows. Use it for "today", "this month", and every date range or ORDER BY.
  NEVER use [GSTDate]: it holds a 1975 placeholder on all sales invoices, credit notes and
  debit notes, so filtering on it silently returns zero rows.
  [createDate] is an audit timestamp - close to [EIDocDate] but different on back-dated
  entries, so it is not the bill date either.

- DOCUMENT TYPE FILTER - THIS IS MANDATORY:
  [dbo].[InvTranTbl] holds sales invoices, purchase invoices, credit notes and debit notes
  together. "bill" and "invoice" ALWAYS mean SALES invoices unless the user explicitly says
  otherwise, so EVERY query against [dbo].[InvTranTbl] MUST include:
      AND [InvSR] = '${SALES_INVOICE_SERIES}'
  Only drop or change that filter when the user explicitly asks for something else:
    - "purchase bills"        -> [InvSR] IN (${PURCHASE_INVOICE_SERIES.map((s) => "'" + s + "'").join(', ')})
    - "credit notes"          -> [InvSR] IN ('SRC','CNO','CNI')
    - "debit notes"           -> [InvSR] IN ('PTD','DNI','DNO')
    - "all documents"         -> no [InvSR] filter
  Series codes are defined in [dbo].[Vntype] ([InvSr], [VtName], [VtType]).

- Sale invoices also have a header row in [dbo].[SIHDR], joined
  [dbo].[SIHDR].[InvTranIdNo] = [dbo].[InvTranTbl].[id]. Their line items are [dbo].[SIDtl].

- "order" -> [dbo].[ORDHDR] (header, date [OrdDate]) and [dbo].[OrdDtl] (lines).
  Orders are NOT bills. Never answer a question about bills or invoices using ORDHDR.

- "company" -> [dbo].[company]; name [COname], code [COCode].

- "party" / "customer" / "supplier" -> [dbo].[Party], linked to ledgers via [PtAccountId].
  The readable name always comes from [dbo].[Account].[AcName].

- "account" / "ledger" -> [dbo].[Account] ([AcName], [AcCode], key [id]).

- "voucher" / accounting entry -> [dbo].[Vheader] ([VhDate], [Vhno], [VhAmount], [VhAccountId]);
  voucher type via [VhVnTypeId] -> [dbo].[Vntype] ([VtName] e.g. 'Sales Invoice',
  [VtShortName] e.g. 'SalesInv', [VtType] e.g. 'SALE').

- "stock" / inventory -> [dbo].[Stock]; item master -> [dbo].[Item].

IMPORTANT: this database has NO foreign key constraints. Only join tables using the
relationships listed above; do not invent joins from column names that merely look similar.
`.trim();

/** Latest bill date in the database, so the model can explain an empty "today" result. */
export const FRESHNESS_QUERY =
  'SELECT MAX([EIDocDate]) AS [lastBill], COUNT(*) AS [bills] FROM [dbo].[InvTranTbl]' +
  ` WHERE [InvSR] = '${SALES_INVOICE_SERIES}'`;

export function freshnessNote(lastBill: unknown, bills: unknown): string { 
  if (!lastBill) return '';
  const date = new Date(String(lastBill)).toISOString().slice(0, 10);
  return [
    'DATA CURRENCY:',
    `The most recent sales bill in this database is dated ${date} (${bills} sales bills in total).`,
    'If a question about "today" or any recent period returns no rows OR a count of 0, you MUST',
    'say so and then add that the most recent bill in the data is dated ' + date + '.',
    'Do not imply the business had no activity.',
  ].join('\n');
}
