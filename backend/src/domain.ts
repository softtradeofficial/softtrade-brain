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
    full document no = [EIDocNo] (complete formatted invoice no with book prefix, e.g. "ST/2026-27/996")
    bill sequence no = [InvSeqno] (numeric invoice sequence number within book)
    book id          = [InvBookId] joins to [dbo].[BookMast].[id] (book name [BKName])
    financial year   = [CoFinyear] (4-digit start year, e.g. 2026 for FY 2026-27)
    bill amount      = [EIInvAmt]
    party/customer   = [AccountId] joins to [dbo].[Account].[id]
    document type    = [InvSR]
    company id       = [CoSoftId] joins to [dbo].[company].[CoSoftId]

- FINANCIAL YEAR FILTERING ([CoFinyear]):
  Almost all transactional and master tables ([InvTranTbl], [Stock], [SIHDR], [Vheader], [AcBal], [ORDHDR], etc.) store [CoFinyear].
  [CoFinyear] stores the 4-digit start year (e.g. 2026 represents FY 2026-27, 2025 represents FY 2025-26).
  When filtering by a specific financial year, filter: [CoFinyear] = <year> (e.g. [CoFinyear] = 2026).

- RECORD STATUS / DELETED & CANCELLED FILTERING ([RecStatus]) - MANDATORY FOR ALL MASTER DATA & TRANSACTIONS:
  SoftTrade ERP uses [RecStatus] across transaction and master data tables to soft-delete and cancel records:
    - RecStatus = -1 : Deleted record
    - RecStatus = 2  : Cancelled record
  In ALL SQL queries, you MUST ALWAYS ignore deleted and cancelled records for EVERY table in the query (both transactions AND master tables like [Account], [Item], [MastById], [Party], [PersonMaster], [TransportMaster], [Station], [District], [TDSRate], [TaxType], [ConsMast]) by adding:
      AND ISNULL([<TableAlias>].[RecStatus], 0) NOT IN (-1, 2)
  NEVER omit this filter on master tables or transaction tables.

- BILL DATE & ORDERING - ALWAYS USE [EIDocDate] AND [InvSeqno]:
  The document date for EVERY row in [dbo].[InvTranTbl] is [EIDocDate]. It is populated on all
  24,856 rows. Use it for "today", "this month", and every date range filter.
  CRITICAL ORDER BY RULE: When ordering by latest/recent bills or invoices, ALWAYS order by both date and invoice sequence number:
      ORDER BY [EIDocDate] DESC, [InvSeqno] DESC
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

- DOCUMENT HIERARCHY & LINE ITEMS (InvTranTbl -> Stock -> SIDtl):
  1. Header: [dbo].[InvTranTbl] (key [id])
     Holds header records for Sales ([InvSR] = '${SALES_INVOICE_SERIES}'), Purchase ([InvSR] IN (${PURCHASE_INVOICE_SERIES.map((s) => "'" + s + "'").join(', ')})), Sale Return/Credit Note ([InvSR] IN ('SRC','CNO','CNI')), Purchase Return/Debit Note ([InvSR] IN ('PTD','DNI','DNO')), and Proforma Invoices.
     Date = [EIDocDate], Invoice No = [InvSeqno], Total Amount = [EIInvAmt], Party/Ledger = [AccountId] -> [dbo].[Account].[id], Company = [CoSoftId].
  2. Line Items (Products/Items): [dbo].[Stock]
     Holds item details for each document.
     Foreign Key to header: [dbo].[Stock].[STIRIdNo] = [dbo].[InvTranTbl].[id].
     Line sequence: [dbo].[Stock].[STISeqNo] (unique sequence number for each [STIRIdNo]).
     Item master: [dbo].[Stock].[ItemId] -> [dbo].[Item].[id] ([Name], [ItemCode]).
     DOUBLE UNIT STOCK FIELDS:
       - [STQty] : Valuation quantity (Kgs, Qntls, Litres, etc.). 99% of values/amounts are calculated with [STQty]. ALWAYS use [STQty] for item quantity, weight, or volume queries.
       - [STBag] : Counting units (packaging like Pcs, Bags, Tins, Cartons, Bottles, Jars).
       - NEVER use [RSTQty] (temporary runtime field only) and NEVER use [STActQty] (null for sales).
     Rate = [Rate], Line Amount = [Amount],
     GST Assessable / Taxable Value = [TaxOnAmt] (the base value on which GST is calculated),
     GST Taxes = [CGSTAmt] (CGST), [SGSTAmt] (SGST), [IGSTAmt] (IGST), [GSTCessAmt] (GST Cess), Total Line GST = (ISNULL([CGSTAmt], 0) + ISNULL([SGSTAmt], 0) + ISNULL([IGSTAmt], 0) + ISNULL([GSTCessAmt], 0)),
     Extra/Overhead Amount = [ExtraAmt] (holds total line overhead expenses including GST tax), Total Line Amount = ([Amount] + ISNULL([ExtraAmt], 0)), Free Qty = [STFreeQty].
  3. Overhead Expenses / Charges per Line Item: [dbo].[SIDtl]
     Holds multiple overhead expenses/charges (e.g. freight, labour, discount, taxes) per stock row.
     Foreign Key to header: [dbo].[SIDtl].[SIIRdNo] = [dbo].[Stock].[STIRIdNo] (and [InvTranTbl].[id]).
     Foreign Key to specific item line: [dbo].[SIDtl].[SIISeqNo] = [dbo].[Stock].[STISeqNo].
     Chargeable Flag: [dbo].[SIDtl].[Chrble] = 'B' (Bill Chargeable overheads / GST taxes included in invoice). [Chrble] = 'L' (Local overheads).
     Note: SUM([SIDtl].[Amount]) WHERE [Chrble] = 'B' is equivalent to [Stock].[ExtraAmt].
     Expense/Ledger: [dbo].[SIDtl].[AccountId] -> [dbo].[Account].[id], Expense Amount = [dbo].[SIDtl].[Amount], Rate = [Rate], Expense Seq = [SNo].
  4. Logistics & Extended Transaction Header: [dbo].[SIHDR]
     Maintains transaction-level separated fields for Sales ('SIN'), Purchase ('PIN'), Sale Return ('SRC'), Purchase Return ('PTD'), and Proforma Invoices (not used in series like SIO/PIO/CNO/DNO/CNI/DNI).
     Foreign Key: [dbo].[SIHDR].[InvTranIdNo] = [dbo].[InvTranTbl].[id].
     - Broker #1: [dbo].[SIHDR].[BR1AccountId] -> [dbo].[Account].[id] ([AcName]), Broker 1 Share = [B1Share].
     - Broker #2: [dbo].[SIHDR].[BR2AccountId] -> [dbo].[Account].[id] ([AcName]), Broker 2 Share = [B2Share].
     - Transporter: [dbo].[SIHDR].[TransportId] -> [dbo].[TransportMaster].[id] ([Name]).
     - Sales Person: [dbo].[SIHDR].[SalePersonId] -> [dbo].[PersonMaster].[id] ([Name]).
     - Payment Terms & Logistics: [PymtFlag], [DueDays], [DueDt], [TruckNo], [GrNo], [GrDate], [BiltyAmt], [Destination], [Place].

- "order" -> [dbo].[ORDHDR] (header, date [OrdDate]) and [dbo].[OrdDtl] (lines).
  Orders are NOT bills. Never answer a question about bills or invoices using ORDHDR.

- "company" / MULTI-COMPANY FILTERING & SELECTION (MANDATORY):
  SoftTrade ERP stores data for multiple companies in the same database. Every table containing [CoSoftId] belongs to a specific company in [dbo].[company].
  The active companies in [dbo].[company] are:
    1. "SHREE TADKESHWAR AGRO FOOD PRODUCT" (CoSoftId = 982903242, COCode = 116)
    2. "SHREE TADKESHWAR INDUSTRIES PVT LTD-15-11-2026" (CoSoftId = 17593440, COCode = 114)
    3. "KEDAWAT REFOILS-15-11-2026" (CoSoftId = 38604957, COCode = 108)
    4. "AMIT GUPTA-15-11-2026" (CoSoftId = 705853702, COCode = 98)
  
  MANDATORY COMPANY WORKFLOW:
  - If the user asks for transactional or operational data (bills, sales, purchases, stock, party ledger balances, expenses, etc.) AND no specific company has been mentioned in the question or recent chat turns or user scope:
    DO NOT guess or run across all companies. You MUST reply with action "answer" asking:
    "Which company do you want to generate the data for?
    1. SHREE TADKESHWAR AGRO FOOD PRODUCT
    2. SHREE TADKESHWAR INDUSTRIES PVT LTD-15-11-2026
    3. KEDAWAT REFOILS-15-11-2026
    4. AMIT GUPTA-15-11-2026
    (Or let me know if you would like a combined total across all companies.)"
  - Once a company is chosen or specified:
    - For transaction documents (Sales Invoices [InvTranTbl], [Stock], [SIDtl], [SIHDR], Vouchers [Vheader]):
        filter: AND [dbo].[InvTranTbl].[CoSoftId] = <exact_cosoftid>
    - For Sales Orders ([ORDHDR], [OrdDtl]) and Master tables ([Item], [Account], [Party], [MastById], [BookMast]):
        - If the company has CommonSalesOrder = 1 (Tadkeshwar Agro [982903242] / Tadkeshwar Industries [17593440]):
            filter: AND [dbo].[ORDHDR].[CoSoftId] IN (<exact_cosoftid>, -1)
            (because common sales orders and master data are stored with CoSoftId = -1).
        - If the company has separate master data (Kedawat Refoils [38604957] / Amit Gupta [705853702]):
            filter: AND [dbo].[ORDHDR].[CoSoftId] = <exact_cosoftid>
  - Exception: Questions that explicitly compare companies or query companies themselves (e.g. "List all companies", "Which company has the most sales?") do NOT ask first; they query across [dbo].[company].

- "party" / "customer" / "supplier" / "account details":
    - Party Name & Station -> [dbo].[Account] ([AcName], [AcStation], [AcDeActivate], [AcOS], key [id]):
        - [AcDeActivate] : Inactive / Deactivated flag (1 = Inactive / Deactivated account, 0 or null = Active account).
        - [AcOS] : Bill-wise Outstanding tracking flag (1 = Enabled, 0 = Disabled).
    - Commercial Party Master (Customer / Supplier / Channel Partner) -> [dbo].[Party] ([PtAccountId], [PtType], [CustomerNo], [FSSAILicNo], [RTALicNo], [TransportId], [SalesPersonId]):
        - Joined to Account via: [dbo].[Party].[PtAccountId] = [dbo].[Account].[id].
        - Party Commercial Classification via [Party].[PtType]:
            - 'C' = Customer (Sales Party)
            - 'S' = Supplier (Purchase Vendor)
            - 'B' = Both (Customer & Supplier)
            - 'P' = Channel Partner (Distributor / Dealer / Super Stockist)
        - When asking for "Suppliers" / "Vendors": query [Party].[PtType] IN ('S', 'B').
        - When asking for "Customers" / "Buyers": query [Party].[PtType] IN ('C', 'B').
        - When asking for "Channel Partners": query [Party].[PtType] = 'P'.
    - Account Group / Schedule -> [dbo].[Schedule] ([ScName], [ScCode], [ScType], key [id]):
        - Joined via [dbo].[Account].[ScheduleId] = [dbo].[Schedule].[id] (Group name is [Schedule].[ScName], e.g. 'Sundry Debtors', 'Sundry Creditors', 'Direct Expenses').
        - Parent Group Hierarchy: [dbo].[Schedule].[ScMisno] holds the parent group Schedule ID (joins to [ParentSchedule].[id] ([ScName])).
        - Financial Statement Mapping via [Schedule].[ScCode]:
            - 'T' = Trading Account (Direct Incomes, Direct Expenses, Sales, Purchases, Stock).
            - 'P' = Profit & Loss Account (Indirect Expenses, Indirect Incomes, Administrative).
            - 'B' = Balance Sheet (Assets, Liabilities, Capital, Debtors, Creditors, Duties & Taxes).
    - Party Address, Pincode, State -> [dbo].[AcInfo] ([Address], [PinCode], [StateId] -> [dbo].[StateMaster].[id] ([StateName]), linked via [AcInfo].[AccountId] = [Account].[id]).
    - Party GST No & Registration Type -> [dbo].[AcGstRegDetail] ([AcGstNo], [AcGSTRegType], [AcEffDate]).
      CRITICAL GST HISTORICAL LOOKUP RULE: [AcGstRegDetail] contains multiple records per [AccountId] based on [AcEffDate].
      NEVER use a plain JOIN to [AcGstRegDetail] (which causes duplicate rows). ALWAYS join using OUTER APPLY with [AcEffDate] <= [InvTranTbl].[EIDocDate]:
          OUTER APPLY (
              SELECT TOP (1) [AcGstNo], [AcGSTRegType]
              FROM [dbo].[AcGstRegDetail]
              WHERE [AcEffDate] <= [InvTranTbl].[EIDocDate]
                AND [Account].[id] = [AcGstRegDetail].[AccountId]
              ORDER BY [AcEffDate] DESC
          ) [AcGstRegDetail]
    - Invoice Amounts on [dbo].[InvTranTbl]:
        - [TaxOnAmt] = Taxable / Net Invoice Amount (before tax).
        - [EITaxAmt] = Total GST Tax Amount.
        - [EIInvAmt] = Total Invoice Amount (Grand Total).

- "voucher type" / voucher master -> [dbo].[Vntype] ([VtName], [VtShortName], [VtType], [InvSr]):
    - For manual accounting vouchers: [dbo].[Vheader].[VhVnTypeId] -> [dbo].[Vntype].[id].
    - For commercial documents ([InvTranTbl]): [dbo].[InvTranTbl].[InvSR] = [dbo].[Vntype].[InvSr] (e.g. 'SIN' -> 'Sales Invoice', 'PIN' -> 'Purchase Invoice').

- "general ledger" / GL postings -> [dbo].[GrLedger] ([GlTranID], [GlIsno], [GlAccountId], [GlAmount], [GlPart], [GlDate], [GlVhno], [GlRefNo], [GlVtSSR]):
    - Holds accounting voucher postings (debit/credit lines) for sales, purchases, returns, receipts, payments, etc.
    - Debit / Credit Sign Convention:
        - [GlAmount] < 0 (-ve value) = DEBIT amount (Debit = ABS([GlAmount])).
        - [GlAmount] > 0 (+ve value) = CREDIT amount (Credit = [GlAmount]).
    - Cross-reference & Document Numbering Columns:
        - [GlRefNo] = [InvTranTbl].[EIDocNo] (full document no with prefix e.g. 'ST/2026-27/996').
        - [GlVhno] = [InvTranTbl].[InvSeqno] (voucher / invoice sequence number).
        - [GlVtSSR] = [InvTranTbl].[InvBookId] (book master ID).
        - [GlTranIdsr] = Series prefix (e.g. 'MANDI-SIN').
        - [GlTranIdno] = Document key ([InvTranTbl].[id]).
    - Joining commercial invoices/bills ([InvTranTbl]) to [GrLedger]:
        [GrLedger].[GlTranID] = ('MANDI-' + [InvTranTbl].[InvSR] + '-' + RIGHT('0000000000' + CAST([InvTranTbl].[id] AS varchar), 10))
    - CRITICAL RULE FOR "ACCOUNT STATEMENT" / "LEDGER STATEMENT" / "PARTY TRANSACTIONS":
        When asked for an account statement, ledger statement, or transaction ledger for a party/account, ALWAYS generate a T-SQL query on [dbo].[GrLedger] joining [dbo].[Account] and [dbo].[Vntype]:
            SELECT
                [GrLedger].[GlDate] AS [Date],
                [Vntype].[VtName] AS [Voucher Type],
                [GrLedger].[GlVhno] AS [Voucher No],
                [GrLedger].[GlRefNo] AS [Ref / Bill No],
                [GrLedger].[GlPart] AS [Particulars],
                CASE WHEN [GrLedger].[GlAmount] < 0 THEN ABS([GrLedger].[GlAmount]) ELSE 0 END AS [Debit Amount],
                CASE WHEN [GrLedger].[GlAmount] > 0 THEN [GrLedger].[GlAmount] ELSE 0 END AS [Credit Amount]
            FROM [dbo].[GrLedger]
            JOIN [dbo].[Account] ON [GrLedger].[GlAccountId] = [Account].[id]
            LEFT JOIN [dbo].[Vntype] ON [GrLedger].[GlVnTypeId] = [Vntype].[id]
            WHERE [Account].[AcName] LIKE '%<PartyName>%'
              AND [GrLedger].[CoFinyear] = <year>
              AND [GrLedger].[CoSoftId] = <exact_cosoftid>
              AND ISNULL([GrLedger].[RecStatus], 0) NOT IN (-1, 2)
            ORDER BY [GrLedger].[GlDate] ASC, [GrLedger].[id] ASC
    - Sequence / Line No: [GrLedger].[GlIsno] is the unique line number for each [GlTranID].
    - Ledger Account: [GrLedger].[GlAccountId] -> [dbo].[Account].[id] ([AcName]).

- "account balances" / "opening balance" / "closing balance" / "trial balance" -> [dbo].[AcBal] ([AccountId], [CoSoftId], [CoFinyear], [AcOpBal], [AcCurDr], [AcCurCr], [AcCurBal]):
    - Holds opening and closing balances for each account per company and financial year.
    - [AcOpBal] < 0 = Debit Opening Balance (ABS([AcOpBal])), [AcOpBal] > 0 = Credit Opening Balance.
    - [AcCurBal] < 0 = Debit Closing Balance (ABS([AcCurBal])), [AcCurBal] > 0 = Credit Closing Balance.
    - [AcCurDr] = Transactions Debit (stored negative, use ABS([AcCurDr])), [AcCurCr] = Transactions Credit.
    - CRITICAL RULE FOR "TRIAL BALANCE" (GROUP-WISE & ACCOUNT-WISE SUMMARY):
        - Query [dbo].[AcBal] joined to [dbo].[Account] and [dbo].[Schedule]:
            - Opening Dr = CASE WHEN [AcBal].[AcOpBal] < 0 THEN ABS([AcBal].[AcOpBal]) ELSE 0 END
            - Opening Cr = CASE WHEN [AcBal].[AcOpBal] > 0 THEN [AcBal].[AcOpBal] ELSE 0 END
            - Current Dr = ABS(ISNULL([AcBal].[AcCurDr], 0))
            - Current Cr = ISNULL([AcBal].[AcCurCr], 0)
            - Closing Dr = CASE WHEN [AcBal].[AcCurBal] < 0 THEN ABS([AcBal].[AcCurBal]) ELSE 0 END
            - Closing Cr = CASE WHEN [AcBal].[AcCurBal] > 0 THEN [AcBal].[AcCurBal] ELSE 0 END
        - For Hierarchical / Tree-Sorted Trial Balance (Main Group -> Sub Groups -> Accounts):
            Use a Recursive CTE on [dbo].[Schedule] ([ScMisno] -> Parent Schedule Id):
                WITH ScheduleCTE AS (
                    SELECT [id], [ScName], [ScMisno], [ScCode], 0 AS [Level],
                           CAST([ScName] AS varchar(1000)) AS [HierarchyPath],
                           CAST(RIGHT('00000' + CAST([id] AS varchar(5)), 5) AS varchar(1000)) AS [SortPath]
                    FROM [dbo].[Schedule] WHERE ISNULL([ScMisno], 0) = 0
                    UNION ALL
                    SELECT child.[id], child.[ScName], child.[ScMisno], child.[ScCode], parent.[Level] + 1,
                           CAST(parent.[HierarchyPath] + ' > ' + child.[ScName] AS varchar(1000)),
                           CAST(parent.[SortPath] + '/' + RIGHT('00000' + CAST(child.[id] AS varchar(5)), 5) AS varchar(1000))
                    FROM [dbo].[Schedule] child INNER JOIN ScheduleCTE parent ON child.[ScMisno] = parent.[id] WHERE child.[id] <> parent.[id]
                )
                SELECT s.[HierarchyPath], s.[Level], s.[ScName], [Account].[AcName], ...
                FROM ScheduleCTE s JOIN [dbo].[Account] ON [Account].[ScheduleId] = s.[id] JOIN [dbo].[AcBal] ON [AcBal].[AccountId] = [Account].[id]
                WHERE [AcBal].[CoSoftId] = <cosoftid> AND [AcBal].[CoFinyear] = <finyear> AND ISNULL([Account].[RecStatus], 0) NOT IN (-1, 2) AND ([AcBal].[AcOpBal] <> 0 OR [AcBal].[AcCurDr] <> 0 OR [AcBal].[AcCurCr] <> 0 OR [AcBal].[AcCurBal] <> 0)
                ORDER BY s.[SortPath] ASC, [Account].[AcName] ASC
        - For Flat Group Summary: GROUP BY [Schedule].[id], [Schedule].[ScName], [Schedule].[ScCode].
    - CRITICAL RULE FOR "TRADING ACCOUNT" / "TRADING ACCOUNT STATEMENT":
        - MANDATORY ASK-FIRST RULE:
            When the user asks generally for a Trading Account or Trading Account Statement without explicitly specifying the format, ALWAYS ask first (action: "answer"):
            "Would you like to view:
            1. **Detailed Statement of Accounts** (line-by-line ledger accounts under Opening Stock, Purchases, Direct Expenses, Stock Transfers, Sales, Closing Stock)
            OR
            2. **Side-by-Side Summary & Gross Profit detail** (group summary table with Debit vs Credit totals and Gross Profit/Loss)?"
        - DEBIT SIDE (Cost of Goods / Direct Outlays):
            - To Opening Stock: [Account].[AcName] = 'Stock-in-hand', Amount = ABS([AcBal].[AcOpBal])
            - To Purchases (Net): Schedule 'Purchase Accounts', Amount = ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)
            - To Direct Expenses: Schedule 'Direct Expenses', Amount = ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)
            - To Stock Transfer In: Schedule 'Stock Transfer In', Amount = ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)
        - CREDIT SIDE (Revenue & Outward Transfers & Closing Stock):
            - By Sales (Net): Schedule 'Sales Accounts', Amount = ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))
            - By Stock Transfer Out: Schedule 'Stock Transfer Out', Amount = ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))
            - By Closing Stock: [Account].[AcName] = 'Stock-in-hand', Amount = ISNULL([AcBal].[AcCurBal], 0)
        - GROSS PROFIT = Total Credits - Total Debits
        - SUMMARY RULE: In the natural language explanation, ALWAYS state the Total Debit Side Cost, Total Credit Side Revenue, and the resulting Gross Profit (or Gross Loss) alongside the Side-by-Side Summary.
        - SQL Query Template for DETAILED STATEMENT OF ACCOUNTS:
            WITH TradingBase AS (
                SELECT
                    s.[ScName] AS [GroupName],
                    [Account].[AcName] AS [AccountName],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ABS(ISNULL([AcBal].[AcOpBal], 0)) ELSE 0 END AS [OpeningStock],
                    CASE WHEN s.[ScName] IN ('Purchase Accounts', 'Direct Expenses', 'Stock Transfer In') THEN (ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)) ELSE 0 END AS [DebitAmount],
                    CASE WHEN s.[ScName] IN ('Sales Accounts', 'Stock Transfer Out') THEN (ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))) ELSE 0 END AS [CreditAmount],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ISNULL([AcBal].[AcCurBal], 0) ELSE 0 END AS [ClosingStock]
                FROM [dbo].[Schedule] s
                JOIN [dbo].[Account] ON [Account].[ScheduleId] = s.[id]
                JOIN [dbo].[AcBal] ON [AcBal].[AccountId] = [Account].[id]
                WHERE [AcBal].[CoSoftId] = <cosoftid> AND [AcBal].[CoFinyear] = <finyear> AND s.[ScCode] = 'T' AND ISNULL([Account].[RecStatus], 0) NOT IN (-1, 2)
            ),
            Lines AS (
                SELECT 1 AS [SortOrder], 'Debit' AS [Side], 'To Opening Stock' AS [Particulars], 'Stock-in-hand' AS [Account], [OpeningStock] AS [Amount] FROM TradingBase WHERE [OpeningStock] <> 0
                UNION ALL
                SELECT 2 AS [SortOrder], 'Debit' AS [Side], 'To Purchases' AS [Particulars], [AccountName] AS [Account], [DebitAmount] AS [Amount] FROM TradingBase WHERE [GroupName] = 'Purchase Accounts' AND [DebitAmount] <> 0
                UNION ALL
                SELECT 3 AS [SortOrder], 'Debit' AS [Side], 'To Direct Expenses' AS [Particulars], [AccountName] AS [Account], [DebitAmount] AS [Amount] FROM TradingBase WHERE [GroupName] = 'Direct Expenses' AND [DebitAmount] <> 0
                UNION ALL
                SELECT 4 AS [SortOrder], 'Debit' AS [Side], 'To Stock Transfer In' AS [Particulars], [AccountName] AS [Account], [DebitAmount] AS [Amount] FROM TradingBase WHERE [GroupName] = 'Stock Transfer In' AND [DebitAmount] <> 0
                UNION ALL
                SELECT 5 AS [SortOrder], 'Credit' AS [Side], 'By Sales' AS [Particulars], [AccountName] AS [Account], [CreditAmount] AS [Amount] FROM TradingBase WHERE [GroupName] = 'Sales Accounts' AND [CreditAmount] <> 0
                UNION ALL
                SELECT 6 AS [SortOrder], 'Credit' AS [Side], 'By Stock Transfer Out' AS [Particulars], [AccountName] AS [Account], [CreditAmount] AS [Amount] FROM TradingBase WHERE [GroupName] = 'Stock Transfer Out' AND [CreditAmount] <> 0
                UNION ALL
                SELECT 7 AS [SortOrder], 'Credit' AS [Side], 'By Closing Stock' AS [Particulars], 'Stock-in-hand' AS [Account], [ClosingStock] AS [Amount] FROM TradingBase WHERE [ClosingStock] <> 0
            )
            SELECT [Side], [Particulars], [Account], [Amount] FROM Lines ORDER BY [SortOrder] ASC, [Account] ASC
        - SQL Query Template for SIDE-BY-SIDE GROUP SUMMARY & GROSS PROFIT:
            WITH TradingBase AS (
                SELECT
                    s.[ScName] AS [GroupName],
                    [Account].[AcName] AS [AccountName],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ABS(ISNULL([AcBal].[AcOpBal], 0)) ELSE 0 END AS [OpeningStock],
                    CASE WHEN s.[ScName] IN ('Purchase Accounts', 'Direct Expenses', 'Stock Transfer In') THEN (ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)) ELSE 0 END AS [DebitAmount],
                    CASE WHEN s.[ScName] IN ('Sales Accounts', 'Stock Transfer Out') THEN (ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))) ELSE 0 END AS [CreditAmount],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ISNULL([AcBal].[AcCurBal], 0) ELSE 0 END AS [ClosingStock]
                FROM [dbo].[Schedule] s
                JOIN [dbo].[Account] ON [Account].[ScheduleId] = s.[id]
                JOIN [dbo].[AcBal] ON [AcBal].[AccountId] = [Account].[id]
                WHERE [AcBal].[CoSoftId] = <cosoftid> AND [AcBal].[CoFinyear] = <finyear> AND s.[ScCode] = 'T' AND ISNULL([Account].[RecStatus], 0) NOT IN (-1, 2)
            ),
            GroupSummary AS (
                SELECT 1 AS [SortOrder], 'Debit' AS [Side], 'To Opening Stock' AS [Account Group], SUM([OpeningStock]) AS [Amount] FROM TradingBase HAVING SUM([OpeningStock]) <> 0
                UNION ALL
                SELECT 2 AS [SortOrder], 'Debit' AS [Side], 'To Net Purchases' AS [Account Group], SUM([DebitAmount]) AS [Amount] FROM TradingBase WHERE [GroupName] = 'Purchase Accounts' HAVING SUM([DebitAmount]) <> 0
                UNION ALL
                SELECT 3 AS [SortOrder], 'Debit' AS [Side], 'To Net Direct Expenses' AS [Account Group], SUM([DebitAmount]) AS [Amount] FROM TradingBase WHERE [GroupName] = 'Direct Expenses' HAVING SUM([DebitAmount]) <> 0
                UNION ALL
                SELECT 4 AS [SortOrder], 'Debit' AS [Side], 'To Stock Transfer In' AS [Account Group], SUM([DebitAmount]) AS [Amount] FROM TradingBase WHERE [GroupName] = 'Stock Transfer In' HAVING SUM([DebitAmount]) <> 0
                UNION ALL
                SELECT 5 AS [SortOrder], 'Credit' AS [Side], 'By Net Sales' AS [Account Group], SUM([CreditAmount]) AS [Amount] FROM TradingBase WHERE [GroupName] = 'Sales Accounts' HAVING SUM([CreditAmount]) <> 0
                UNION ALL
                SELECT 6 AS [SortOrder], 'Credit' AS [Side], 'By Stock Transfer Out' AS [Account Group], SUM([CreditAmount]) AS [Amount] FROM TradingBase WHERE [GroupName] = 'Stock Transfer Out' HAVING SUM([CreditAmount]) <> 0
                UNION ALL
                SELECT 7 AS [SortOrder], 'Credit' AS [Side], 'By Closing Stock' AS [Account Group], SUM([ClosingStock]) AS [Amount] FROM TradingBase HAVING SUM([ClosingStock]) <> 0
            )
            SELECT [Side], [Account Group], [Amount] FROM GroupSummary ORDER BY [SortOrder] ASC
    - CRITICAL RULE FOR "PROFIT & LOSS ACCOUNT" / "P&L STATEMENT":
        - MANDATORY ASK-FIRST RULE:
            When the user asks generally for a Profit & Loss Account or P&L Statement without explicitly specifying the format, ALWAYS ask first (action: "answer"):
            "Would you like to view:
            1. **Detailed Statement of Accounts** (line-by-line ledger accounts under Indirect Expenses, Indirect Incomes, and Gross Profit b/d)
            OR
            2. **Side-by-Side Summary & Net Profit / Loss detail** (group summary table with Total Revenue vs Total Expenses and Net Profit/Loss)?"
        - CREDIT SIDE (Revenue & Gross Profit):
            - By Gross Profit b/d: Calculated from Trading Account (Credits - Debits where ScCode = 'T')
            - By Indirect Incomes: Schedule 'Indirect Incomes' (where ScCode = 'P'), Amount = ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))
        - DEBIT SIDE (Indirect Expenses):
            - To Indirect Expenses: Schedule under [ScCode] = 'P' and [ScName] <> 'Indirect Incomes', Amount = ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)
        - NET PROFIT / NET LOSS = Total Credits (Gross Profit b/d + Indirect Incomes) - Total Debits (Indirect Expenses)
        - SUMMARY RULE: In the natural language explanation, ALWAYS state the Gross Profit b/d, Total Indirect Incomes, Total Indirect Expenses, and the exact Net Profit (or Net Loss).
        - SQL Query Template for P&L DETAILED STATEMENT OF ACCOUNTS:
            WITH TradingBase AS (
                SELECT s.[ScName] AS [GroupName], [Account].[AcName] AS [AccountName],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ABS(ISNULL([AcBal].[AcOpBal], 0)) ELSE 0 END AS [OpeningStock],
                    CASE WHEN s.[ScName] IN ('Purchase Accounts', 'Direct Expenses', 'Stock Transfer In') THEN (ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)) ELSE 0 END AS [DebitAmount],
                    CASE WHEN s.[ScName] IN ('Sales Accounts', 'Stock Transfer Out') THEN (ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))) ELSE 0 END AS [CreditAmount],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ISNULL([AcBal].[AcCurBal], 0) ELSE 0 END AS [ClosingStock]
                FROM [dbo].[Schedule] s JOIN [dbo].[Account] ON [Account].[ScheduleId] = s.[id] JOIN [dbo].[AcBal] ON [AcBal].[AccountId] = [Account].[id]
                WHERE [AcBal].[CoSoftId] = <cosoftid> AND [AcBal].[CoFinyear] = <finyear> AND s.[ScCode] = 'T' AND ISNULL([Account].[RecStatus], 0) NOT IN (-1, 2)
            ),
            GrossProfitCalc AS (
                SELECT (SUM([CreditAmount]) + SUM([ClosingStock])) - (SUM([OpeningStock]) + SUM([DebitAmount])) AS [GrossProfit] FROM TradingBase
            ),
            PLBase AS (
                SELECT s.[ScName] AS [GroupName], [Account].[AcName] AS [AccountName],
                    CASE WHEN s.[ScName] = 'Indirect Incomes' THEN (ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))) ELSE 0 END AS [CreditAmount],
                    CASE WHEN s.[ScName] <> 'Indirect Incomes' THEN (ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)) ELSE 0 END AS [DebitAmount]
                FROM [dbo].[Schedule] s JOIN [dbo].[Account] ON [Account].[ScheduleId] = s.[id] JOIN [dbo].[AcBal] ON [AcBal].[AccountId] = [Account].[id]
                WHERE [AcBal].[CoSoftId] = <cosoftid> AND [AcBal].[CoFinyear] = <finyear> AND s.[ScCode] = 'P' AND ISNULL([Account].[RecStatus], 0) NOT IN (-1, 2)
            ),
            Lines AS (
                SELECT 1 AS [SortOrder], 'Credit' AS [Side], 'By Gross Profit b/d' AS [Particulars], 'Trading Account' AS [Account], [GrossProfit] AS [Amount] FROM GrossProfitCalc
                UNION ALL
                SELECT 2 AS [SortOrder], 'Credit' AS [Side], 'By Indirect Incomes' AS [Particulars], [AccountName] AS [Account], [CreditAmount] AS [Amount] FROM PLBase WHERE [CreditAmount] <> 0
                UNION ALL
                SELECT 3 AS [SortOrder], 'Debit' AS [Side], 'To ' + [GroupName] AS [Particulars], [AccountName] AS [Account], [DebitAmount] AS [Amount] FROM PLBase WHERE [DebitAmount] <> 0
            )
            SELECT [Side], [Particulars], [Account], [Amount] FROM Lines ORDER BY [SortOrder] ASC, [Account] ASC
        - SQL Query Template for P&L SIDE-BY-SIDE GROUP SUMMARY & NET PROFIT:
            WITH TradingBase AS (
                SELECT s.[ScName] AS [GroupName], [Account].[AcName] AS [AccountName],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ABS(ISNULL([AcBal].[AcOpBal], 0)) ELSE 0 END AS [OpeningStock],
                    CASE WHEN s.[ScName] IN ('Purchase Accounts', 'Direct Expenses', 'Stock Transfer In') THEN (ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)) ELSE 0 END AS [DebitAmount],
                    CASE WHEN s.[ScName] IN ('Sales Accounts', 'Stock Transfer Out') THEN (ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))) ELSE 0 END AS [CreditAmount],
                    CASE WHEN [Account].[AcName] = 'Stock-in-hand' THEN ISNULL([AcBal].[AcCurBal], 0) ELSE 0 END AS [ClosingStock]
                FROM [dbo].[Schedule] s JOIN [dbo].[Account] ON [Account].[ScheduleId] = s.[id] JOIN [dbo].[AcBal] ON [AcBal].[AccountId] = [Account].[id]
                WHERE [AcBal].[CoSoftId] = <cosoftid> AND [AcBal].[CoFinyear] = <finyear> AND s.[ScCode] = 'T' AND ISNULL([Account].[RecStatus], 0) NOT IN (-1, 2)
            ),
            GrossProfitCalc AS (
                SELECT (SUM([CreditAmount]) + SUM([ClosingStock])) - (SUM([OpeningStock]) + SUM([DebitAmount])) AS [GrossProfit] FROM TradingBase
            ),
            PLBase AS (
                SELECT s.[ScName] AS [GroupName],
                    CASE WHEN s.[ScName] = 'Indirect Incomes' THEN (ISNULL([AcBal].[AcCurCr], 0) - ABS(ISNULL([AcBal].[AcCurDr], 0))) ELSE 0 END AS [CreditAmount],
                    CASE WHEN s.[ScName] <> 'Indirect Incomes' THEN (ABS(ISNULL([AcBal].[AcCurDr], 0)) - ISNULL([AcBal].[AcCurCr], 0)) ELSE 0 END AS [DebitAmount]
                FROM [dbo].[Schedule] s JOIN [dbo].[Account] ON [Account].[ScheduleId] = s.[id] JOIN [dbo].[AcBal] ON [AcBal].[AccountId] = [Account].[id]
                WHERE [AcBal].[CoSoftId] = <cosoftid> AND [AcBal].[CoFinyear] = <finyear> AND s.[ScCode] = 'P' AND ISNULL([Account].[RecStatus], 0) NOT IN (-1, 2)
            ),
            SummaryLines AS (
                SELECT 1 AS [SortOrder], 'Credit' AS [Side], 'By Gross Profit b/d' AS [Particulars], [GrossProfit] AS [Amount] FROM GrossProfitCalc
                UNION ALL
                SELECT 2 AS [SortOrder], 'Credit' AS [Side], 'By Indirect Incomes' AS [Particulars], SUM([CreditAmount]) AS [Amount] FROM PLBase WHERE [CreditAmount] <> 0
                UNION ALL
                SELECT 3 AS [SortOrder], 'Debit' AS [Side], 'To ' + [GroupName] AS [Particulars], SUM([DebitAmount]) AS [Amount] FROM PLBase WHERE [DebitAmount] <> 0 GROUP BY [GroupName]
            )
            SELECT [Side], [Particulars], [Amount] FROM SummaryLines ORDER BY [SortOrder] ASC, [Particulars] ASC
    - Holds bill-wise outstanding balances and settlement / adjustment records for ledger vouchers.
    - CRITICAL RULE FOR DUE BILLS / CURRENT OUTSTANDING:
        When asked for "due bills", "top due bills", "pending bills", or "current outstanding bills", ALWAYS query [dbo].[GLOS] filtering:
            WHERE [GLOS].[GlOsType] = '0' AND [GLOS].[GlOsAmt] <> 0 AND [Account].[AcOS] = 1
        - MANDATORY AcOS FILTER: ONLY show outstandings for parties where bill-wise OS is currently enabled ([Account].[AcOS] = 1, bit). If AcOS is 0/false, DO NOT show their outstandings because bill-wise OS has been disabled.
        - Due Amount = ABS([GLOS].[GlOsAmt]).
        - Bill Reference / Invoice No = [GLOS].[GlOsId].
        - Party Name = [dbo].[Account].[AcName] (via [GLOS].[GlAccountId] = [Account].[id]).
        - Due Date = [GLOS].[GlDueDate], Bill Date = [GLOS].[GlDate], Credit Days = [GLOS].[GlDueDays].
    - Joining [dbo].[GLOS] to [dbo].[GrLedger]:
        [GrLedger].[GlTranIdno] = [GLOS].[GlTranIdno] AND [GrLedger].[GlVhino] = [GLOS].[GlVhino] AND [GrLedger].[GlIsno] = [GLOS].[GlIsno]
    - Record Types via [GLOS].[GlOsType]:
        - '0' = Calculated Current Outstanding Balance (USE THIS FOR DUE BILLS)
        - '1' = New Outstanding Bill Reference Entry (initial invoice / bill creation)
        - '2' = Adjusted against Outstanding (receipts, payments, credit adjustments)
    - Bill Reference: [GLOS].[GlOsId] (e.g. invoice / bill number).
    - 'On  Account' Outstanding Architecture & MANDATORY ASK-FIRST RULE:
        - When a voucher is posted for a party with bill-wise OS enabled without referencing a specific bill, it is grouped into 'On  Account' ([GlOsId] = 'On  Account').
        - Records are maintained per [GlAccountId] + [GlFinYear].
        - The record where [GlFinYear] = 9999 contains the latest consolidated/calculated running balance of 'On  Account' outstanding for that party.
        - CRITICAL ASK-FIRST RULE: In bill-wise outstanding queries, ALWAYS ask the user first if they would like to include 'On Account' due balance records or show only specific bill references.
        - If 'On Account' is included: filter ([GLOS].[GlOsId] <> 'On  Account' OR [GLOS].[GlFinYear] = 9999).
        - If 'On Account' is excluded: filter [GLOS].[GlOsId] <> 'On  Account'.
    - Party Account: [GLOS].[GlAccountId] -> [dbo].[Account].[id] ([AcName]).

- "stock" / inventory -> [dbo].[Stock]; transaction type master -> [dbo].[TranMaster]; item master -> [dbo].[Item] ([Name], [ItemCode], [CUnitId], [VUnitId], [Active]):
    - CRITICAL RULE FOR "CURRENT STOCK" / INVENTORY BALANCE (OPTION 1 - REAL-TIME TRANSACTIONAL LEDGER):
        Join [dbo].[Stock] to [dbo].[TranMaster] on [Stock].[STSr] = [TranMaster].[TranSr]:
            - [TranMaster].[DeductStock] determines inward vs outward movement:
                - [DeductStock] = 1 (true) : Deduct Stock (Outward: -[Stock].[STQty], -[Stock].[STBag]), e.g. SIN (Sale Invoice), PTD (Debit Note), MIP (Consumption), DTO (Division Stock Out).
                - [DeductStock] = 0 (false) : Add Stock (Inward: +[Stock].[STQty], +[Stock].[STBag]), e.g. PIN (Purchase Invoice), SRC (Credit Note), PDP (Production), DTI (Division Stock In).
            - Stock Valuation Quantity = SUM(CASE WHEN [TranMaster].[DeductStock] = 1 THEN -[Stock].[STQty] ELSE [Stock].[STQty] END)
            - Stock Counting Bags/Pcs = SUM(CASE WHEN [TranMaster].[DeductStock] = 1 THEN -[Stock].[STBag] ELSE [Stock].[STBag] END)
    - CRITICAL RULE FOR "ITEM STOCK LEDGER" / "ITEM LEDGER" / "STOCK MOVEMENT STATEMENT":
        - VOUCHER NUMBER MANDATORY RULE:
            - For PDP (Production) and MIP (Consumption) entries, [Stock].[STIRIdNo] references [dbo].[irhdr].[id]. You MUST join [dbo].[irhdr] and display [irhdr].[IRSeqNo] as the Voucher No.
            - For Sales / Purchase Invoices, [Stock].[STIRIdNo] references [dbo].[InvTranTbl].[id]. You MUST join [dbo].[InvTranTbl] and display [InvTranTbl].[EIDocNo] as the Voucher No.
            - Therefore, in the second SELECT of StockMovement, ALWAYS include BOTH joins:
                LEFT JOIN [dbo].[irhdr] ON [Stock].[STIRIdNo] = [irhdr].[id] AND [Stock].[STSr] IN ('PDP', 'MIP')
                LEFT JOIN [dbo].[InvTranTbl] ON [Stock].[STIRIdNo] = [InvTranTbl].[id] AND [Stock].[STSr] NOT IN ('PDP', 'MIP')
            - And ALWAYS define [Voucher No] as:
                CAST(COALESCE(CAST([irhdr].[IRSeqNo] AS varchar(50)), [InvTranTbl].[EIDocNo], [Stock].[STIRId], CAST([Stock].[STIRIdNo] AS varchar(50))) AS varchar(50)) AS [Voucher No]
        - COUNTING UNIT RULE (Item.CUnitId = -1):
            - If [dbo].[Item].[CUnitId] = -1 (no counting unit is maintained for this item, e.g. labels, chemicals, single-unit items): DO NOT include counting units columns ([Inward Bags], [Outward Bags], [Running Balance Bags]). ONLY include valuation quantity columns ([Inward Qty], [Outward Qty], [Running Balance Qty]).
            - If [dbo].[Item].[CUnitId] <> -1: include both counting unit columns and valuation quantity columns.
        - Complete Stock Ledger Query Template with Running Balance:
            WITH StockMovement AS (
                SELECT
                    CAST('2026-04-01' AS date) AS [Date],
                    0 AS [SortOrder],
                    CAST(0 AS bigint) AS [StockId],
                    CAST(NULL AS varchar(50)) AS [Voucher No],
                    CAST('Opening Balance' AS varchar(50)) AS [Transaction Type],
                    CAST(NULL AS varchar(100)) AS [Party Name],
                    SUM([ItemDivisionBal].[ItOpQty]) AS [Inward Qty],
                    CAST(NULL AS decimal(18,2)) AS [Outward Qty],
                    CAST(NULL AS decimal(18,2)) AS [Rate],
                    SUM([ItemDivisionBal].[ItOpAmount]) AS [Amount],
                    SUM([ItemDivisionBal].[ItOpQty]) AS [NetQtyChange]
                FROM [dbo].[ItemDivisionBal]
                JOIN [dbo].[Item] ON [ItemDivisionBal].[ItemId] = [Item].[id]
                WHERE [Item].[Name] LIKE '%<ItemName>%' AND [ItemDivisionBal].[CoSoftId] = <cosoftid> AND [ItemDivisionBal].[CoFinyear] = <finyear> AND ISNULL([Item].[RecStatus], 0) NOT IN (-1, 2)
                HAVING SUM([ItemDivisionBal].[ItOpQty]) <> 0

                UNION ALL

                SELECT
                    CAST([Stock].[StDate] AS date) AS [Date],
                    1 AS [SortOrder],
                    CAST([Stock].[id] AS bigint) AS [StockId],
                    CAST(COALESCE(CAST([irhdr].[IRSeqNo] AS varchar(50)), [InvTranTbl].[EIDocNo], [Stock].[STIRId], CAST([Stock].[STIRIdNo] AS varchar(50))) AS varchar(50)) AS [Voucher No],
                    CAST([TranMaster].[TranName] AS varchar(50)) AS [Transaction Type],
                    CAST(ISNULL([Account].[AcName], 'Internal / Production') AS varchar(100)) AS [Party Name],
                    CASE WHEN [TranMaster].[DeductStock] = 0 THEN [Stock].[STQty] ELSE NULL END AS [Inward Qty],
                    CASE WHEN [TranMaster].[DeductStock] = 1 THEN [Stock].[STQty] ELSE NULL END AS [Outward Qty],
                    [Stock].[Rate] AS [Rate],
                    [Stock].[Amount] AS [Amount],
                    CASE WHEN [TranMaster].[DeductStock] = 0 THEN [Stock].[STQty] ELSE -[Stock].[STQty] END AS [NetQtyChange]
                FROM [dbo].[Stock]
                JOIN [dbo].[Item] ON [Stock].[ItemId] = [Item].[id]
                LEFT JOIN [dbo].[TranMaster] ON [Stock].[STSr] = [TranMaster].[TranSr]
                LEFT JOIN [dbo].[Account] ON [Stock].[STAccountId] = [Account].[id]
                LEFT JOIN [dbo].[irhdr] ON [Stock].[STIRIdNo] = [irhdr].[id] AND [Stock].[STSr] IN ('PDP', 'MIP')
                LEFT JOIN [dbo].[InvTranTbl] ON [Stock].[STIRIdNo] = [InvTranTbl].[id] AND [Stock].[STSr] NOT IN ('PDP', 'MIP')
                WHERE [Item].[Name] LIKE '%<ItemName>%' AND [Stock].[CoSoftId] = <cosoftid> AND [Stock].[CoFinyear] = <finyear> AND ISNULL([Stock].[RecStatus], 0) NOT IN (-1, 2) AND ISNULL([Item].[RecStatus], 0) NOT IN (-1, 2)
            )
            SELECT
                CONVERT(varchar(10), [Date], 120) AS [Date],
                [Voucher No],
                [Transaction Type],
                [Party Name],
                [Inward Qty],
                [Outward Qty],
                [Rate],
                [Amount],
                SUM([NetQtyChange]) OVER (ORDER BY [Date] ASC, [SortOrder] ASC, [StockId] ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS [Running Balance Qty]
            FROM StockMovement
            ORDER BY [Date] ASC, [SortOrder] ASC, [StockId] ASC
    - CURRENT STOCK (OPTION 2 - PRE-AGGREGATED DIVISION BALANCE SNAPSHOT):
        Query [dbo].[ItemDivisionBal] ([ItemId], [DivId], [CoSoftId], [CoFinyear], [ItOpQty], [ItRcQty], [ItIsQty]):
            - When complete stock for a company is asked, ALWAYS SUM across all divisions of that company using GROUP BY [Item].[id], [Item].[Name]:
                - Total Stock Qty = SUM([ItemDivisionBal].[ItOpQty] + [ItemDivisionBal].[ItRcQty] - [ItemDivisionBal].[ItIsQty])
                - Total Stock Bags = SUM([ItemDivisionBal].[ItOpBag] + [ItemDivisionBal].[ItRcBag] - [ItemDivisionBal].[ItIsBag])
    - MULTI-DIVISION STOCK HANDLING:
        When a company has multiple divisions (like Shree Tadkeshwar Agro Food Product with General [45], Gorakhpur Depot [52], Lucknow Depot [53]):
            - When complete / company stock is asked, ALWAYS SUM up all divisions of that company (SUM(...) GROUP BY [Item].[id], [Item].[Name]).
            - If a specific division/branch is requested, filter [ItemDivisionBal].[DivId] = <division_id> (or [Stock].[DivId] = <division_id>).
            - MANDATORY ZERO-STOCK FILTER: In stock reports, ALWAYS filter out zero-stock items by adding: HAVING SUM([ItOpQty] + [ItRcQty] - [ItIsQty]) <> 0 (or WHERE ([ItOpQty] + [ItRcQty] - [ItIsQty]) <> 0).
    - Double Unit Stock Calculation:
        - [STBag] = counting units (bags, cases, tins, pcs). Unit name from [dbo].[Item].[CUnitId] -> [dbo].[MastById].[Name] (where [SR] = 'ITEMUNIT').
        - [STQty] = stock valuation units (kgs, quintals, litres). Unit name from [dbo].[Item].[VUnitId] -> [dbo].[MastById].[Name] (where [SR] = 'ITEMUNIT').
    - [Active] : Active/Inactive flag (1 = Active item, 0 = Inactive / Discontinued item).

- "division" / "branch" -> [dbo].[Dcompany] ([Name], [prefix], [Address1], [Phone], [Email], key [id]):
    - Division / Branch Master is stored in [dbo].[Dcompany] ([Name] = Division Name, [prefix] = Division Code/Prefix).
    - Relationship between Company and Division is maintained in [dbo].[CompanyDivisionRelation] ([CoSoftId], [DivId] -> [Dcompany].[id]).
      - If a company does not have multiple branches/divisions, there is only a single record in [CompanyDivisionRelation] for that company's [CoSoftId].
      - For "SHREE TADKESHWAR AGRO FOOD PRODUCT" (982903242), divisions are "General" ([DivId] = 45), "GORAKHPUR DEPOT " ([DivId] = 52), and "LUCKNOW DEPOT " ([DivId] = 53).
    - ALL Transaction and Master tables ([InvTranTbl], [Stock], [Grledger], [GLOS], [Vheader], [ORDHDR], [OrdDtl], [SIDtl], [SIHDR], [Account], [Item]) have [DivId]:
      - Join: [<TableAlias>].[DivId] = [dbo].[Dcompany].[id] to display division name or filter by a specific division/branch.

- "user security" / "user permissions" / "user company & division relation" -> [dbo].[usermast], [dbo].[UserCompanyRelation], [dbo].[UserDivision]:
    - User Master is stored in [dbo].[usermast] ([id], [userName], [userCode], [LoginUserId], [Superuser], [deactivate], [mobileNo], [Email]):
        - [deactivate] = 1 (inactive/deactivated user), 0 or null = active user.
    - Superadmin Architecture:
        - Superadmin has NO records in [dbo].[usermast], [UserCompanyRelation], or [UserDivision].
        - Superadmin is represented by UserId = -1 and has unrestricted global access across ALL companies and ALL divisions.
    - User-Company Permission Relation -> [dbo].[UserCompanyRelation] ([UserId] -> [usermast].[id], [CoSoftId] -> [company].[CoSoftId], [AllDivision]):
        - If a user has permission for a company, a record exists in [UserCompanyRelation].
        - [AllDivision] = 1 (bit/true): User has permission for ALL divisions/branches of that company.
        - [AllDivision] = 0 (bit/false): User has permission ONLY for selected divisions specified in [dbo].[UserDivision].
    - User-Division Permission Relation -> [dbo].[UserDivision] ([UserId] -> [usermast].[id], [CoSoftId] -> [company].[CoSoftId], [DivId] -> [Dcompany].[id]):
        - Holds the specific division/branch permissions for users whose [UserCompanyRelation].[AllDivision] = 0.

- "company configuration" / parameters -> [dbo].[SysparmAC]:
    - Holds company-wise configuration settings.
    - Each record relates to a company via [SysparmAC].[CoSoftId] = [dbo].[company].[CoSoftId].
    - [CommonSalesOrder] = 1 indicates that the company maintains common master data and sales orders with other common companies.
      - "SHREE TADKESHWAR AGRO FOOD PRODUCT" (982903242) and "SHREE TADKESHWAR INDUSTRIES PVT LTD" (17593440) have [CommonSalesOrder] = 1.
      - "KEDAWAT REFOILS" (38604957) and "AMIT GUPTA" (705853702) have separate master data ([CommonSalesOrder] = null/0).

- MASTER DATA & SALES ORDERS PARTITIONING (MastById, Item, Account, Party, BookMast, ORDHDR):
    Master tables and Sales Orders use [CoSoftId] values as follows:
      - [CoSoftId] = 0 : Reserved master data created by software developer — accessible/used across ALL companies.
      - [CoSoftId] = -1 : Common master data and common sales orders shared by companies that have [CommonSalesOrder] = 1 (Tadkeshwar Agro & Tadkeshwar Industries).
      - [CoSoftId] = <company_id> : Company-specific master data or sales orders.
    Query Filtering Rules:
      - For companies with CommonSalesOrder = 1 (Tadkeshwar Agro / Tadkeshwar Industries):
        - Master tables (Item, Account, Party, MastById, BookMast): WHERE ([CoSoftId] = <company_id> OR [CoSoftId] = -1 OR [CoSoftId] = 0)
        - Sales Orders (ORDHDR, OrdDtl): WHERE ([ORDHDR].[CoSoftId] = <company_id> OR [ORDHDR].[CoSoftId] = -1)
      - For companies with separate master data (Kedawat Refoils / Amit Gupta):
        - Master tables: WHERE ([CoSoftId] = <company_id> OR [CoSoftId] = 0)
        - Sales Orders: WHERE [ORDHDR].[CoSoftId] = <company_id>

IMPORTANT: this database has NO foreign key constraints. Only join tables using the
relationships listed above; do not invent joins from column names that merely look similar.
`.trim();

/** Latest bill date in the database, so the model can explain an empty "today" result. */
export const FRESHNESS_QUERY =
  'SELECT MAX([EIDocDate]) AS [lastBill], COUNT(*) AS [bills] FROM [dbo].[InvTranTbl]' +
  ` WHERE [InvSR] = '${SALES_INVOICE_SERIES}' AND ISNULL([RecStatus], 0) NOT IN (-1, 2)`;

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
