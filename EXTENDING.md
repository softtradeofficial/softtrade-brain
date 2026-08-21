# Extending SoftTrade Brain

How the code fits together, and exactly where to edit when you want it to understand more.

---

## 1. What happens when someone types a question

Every question walks through the same seven steps. Knowing which step is misbehaving tells you
which file to open.

| # | Step | File | What it does |
| --- | --- | --- | --- |
| 1 | Send | `frontend/src/app/components/chat/chat.component.ts` | Posts `{message, history}` to `/api/chat` |
| 2 | Receive | `backend/src/routes/chat.ts` | Orchestrates everything below |
| 3 | Load schema | `backend/src/schema.ts` | Reads your tables from `INFORMATION_SCHEMA` (cached 10 min) |
| 4 | **Pick tables** | `backend/src/llm.ts` → `selectTables()` | Asks GPT-4o *which* tables this question needs |
| 5 | **Write SQL** | `backend/src/llm.ts` → `planQuery()` | Asks GPT-4o for one `SELECT`, given only those tables + the glossary |
| 6 | **Check SQL** | `backend/src/sqlGuard.ts` | Blocks anything that isn't a safe single `SELECT` |
| 7 | Run + explain | `backend/src/db.ts`, `llm.ts` → `explainResult()` | Runs the query, asks GPT-4o to word the answer |

The knowledge that makes steps 4 and 5 correct lives in **`backend/src/domain.ts`**. That is the
file you will edit most.

---

## 2. Teach it a new business term

**File: `backend/src/domain.ts`, inside `BUSINESS_GLOSSARY` (line 45).**

This is a plain-text block sent to GPT-4o with every question. Adding a line here is the single
most effective change you can make — it costs almost nothing in tokens and stops the model
guessing.

### A worked example (already applied)

`InvTranTbl` holds every document type, not just sales bills. The `InvSR` column separates them:

| InvSR | Meaning | Rows |
| --- | --- | --- |
| `SIN` | Sales Invoice | 20,541 |
| `PIN` | Purchase Invoice | 2,635 |
| `PIO` | Purchase Invoice (other) | 964 |
| `SRC` | Sale Credit Note | 493 |
| `CNO`, `PTD`, `SIO`, … | notes, debit notes, other | ~220 |

Two rules are now in `BUSINESS_GLOSSARY` because of this:

1. **Every** `InvTranTbl` query carries `AND [InvSR] = 'SIN'` unless the user explicitly asks
   for purchases, credit notes, debit notes or all documents.
2. The document date is **`EIDocDate`**, never `GSTDate`.

That second rule was the bigger trap. `GSTDate` looks like the obvious bill date, but:

| InvSR | rows | real `GSTDate` | real `EIDocDate` |
| --- | --- | --- | --- |
| SIN (sales) | 20,541 | **0** | 20,541 |
| PIN (purchase) | 2,635 | 2,634 | 2,635 |
| SRC (credit note) | 493 | **0** | 493 |

On sales invoices `GSTDate` is `1975-01-01` on every single row, so filtering on it returns
zero without any error. `EIDocDate` is populated on all 24,856 rows and is the only date
column safe to use.

The series code is configurable rather than hardcoded, in case another SoftTrade database
uses a different one:

```
# backend/.env
SALES_INVOICE_SERIES=SIN
PURCHASE_INVOICE_SERIES=PIN,PIO
```

### The rule for writing good glossary entries

Only write things you have **verified with a query**. A wrong hint is worse than no hint,
because the model trusts the glossary over the schema. The pattern that works:

```
- "<business word>" -> [dbo].[<Table>]
    <what one row means>
    date column   = [<Col>]     <- say which column to filter dates on
    amount column = [<Col>]
    joins to      = [dbo].[<Other>].[<Col>] via [<Col>]
  <any "never do X" warning>
```

That last warning line matters. The reason `ORDHDR` no longer gets used for bill questions is
this line: *"Orders are NOT bills. Never answer a question about bills or invoices using ORDHDR."*

---

## 3. Add a suggested question to the UI

**File: `frontend/src/app/components/chat/chat.component.ts`, line 24.**

```ts
readonly suggestions = [
  'How many companies are there?',
  'How many bills were created today?',
  'What is the total billed amount today?',
  'Show the 10 most recent bills',
  'Which company has the most bills this month?',
  'How many purchase bills this month?',   // <- add your own here
];
```

These are the buttons on the empty chat screen. `npm start` hot-reloads them.

---

## 4. Hide a table from the AI

Two ways, both in **`backend/src/domain.ts`**:

```ts
// line 11 - pattern based, catches families of tables
const EXCLUDED_PATTERNS: RegExp[] = [
  /bak$/i,
  /backup/i,
  /_old$/i,
  /^tmp/i,
  /^temp/i,
  /[_]?\d{6,8}$/,
  /^Log/i,            // <- e.g. hide LogBookMaster, LoginLogBook
];

// line 21 - one-off names
const EXCLUDED_NAMES = new Set(
  ['abc', 'AcBal123', 'Stock2', 'CsConst20', 'SoftwareErrors'].map(n => n.toLowerCase())
);
```

Or without touching code, in `backend/.env`:

```
EXCLUDE_TABLES=SoftwareErrors,LoginLogBook,TaskScheduler
```

Fewer tables means cheaper, faster and more accurate answers. Currently 24 of your 246 tables
are hidden this way.

---

## 5. Change a SQL rule

**File: `backend/src/llm.ts`, `planningSystemPrompt()` — the `RULES FOR THE SQL:` list at line 110.**

Each entry is one string in an array. Add a line to change how every query is written:

```ts
'RULES FOR THE SQL:',
'- SELECT statements only. Never INSERT, UPDATE, ...',
// ... existing rules ...
'- Ignore cancelled documents: add WHERE [RecStatus] <> 0 when the table has a RecStatus column.',
'- When the user names a month without a year, assume the most recent one present in the data.',
```

**Do not** loosen the read-only rules here — `sqlGuard.ts` will reject the query anyway, and the
user just gets an error.

---

## 6. Change how answers are worded

**File: `backend/src/llm.ts`, `explainResult()` at line 179** — the system prompt controls tone.

```ts
'You explain SQL query results to business users.',
'Answer the question directly in one or two short sentences, ...',
'This is an Indian business: all amounts are Indian Rupees...',
'Reply in Hindi if the user wrote in Hindi.',    // <- for example
```

Behaviour rules must go in the **system** message, not the user message. That was a real bug
here: the data-currency note sat in the user turn and the model ignored it every time.

---

## 7. Change the limits

| What | Where | Default |
| --- | --- | --- |
| Rows returned to the browser | `backend/.env` → `MAX_ROWS` | 200 |
| Rows shown to the model when wording the answer | `.env` → `MAX_ROWS_FOR_SUMMARY` | 50 |
| Query timeout | `.env` → `QUERY_TIMEOUT_MS` | 30000 |
| How long the schema is cached | `.env` → `SCHEMA_TTL_MS` | 600000 (10 min) |
| Which schemas are visible | `.env` → `ALLOWED_SCHEMAS` | `dbo` |
| Max tables sent per question | `backend/src/llm.ts` line 37 → `MAX_SELECTED_TABLES` | 12 |
| Model | `.env` → `OPENAI_MODEL` | `gpt-4o` |

Raising `MAX_SELECTED_TABLES` helps questions that need many joins, but costs tokens. Your
account's limit is 30,000 tokens per minute, and a typical question currently uses ~2,000.

---

## 8. Exporting results

Every result table has **CSV** and **Excel** buttons
(`frontend/src/app/components/result-table/result-table.component.ts`).

The Excel path writes a real `.xlsx` via `write-excel-file`, and unlike CSV it preserves
types, so `SUM`, sorting and pivot tables work without re-typing columns by hand:

- `columnType()` scans each column and classifies it `number`, `date` or `text` -
  a column is only numeric if *every* non-empty value is a number.
- `excelCell()` emits `{value, type: Number}`, `{value, type: Date, format: 'dd/mm/yyyy'}`
  or a string; empty values become `null` so Excel leaves the cell blank.
- The library loads via `await import(...)`, so its 69 kB is a lazy chunk fetched on first
  use rather than part of the 220 kB initial bundle.

**Watch out for dates.** The writer converts a JS `Date` to a UTC-based Excel serial, so a
`Date` built at local midnight lands on the previous day anywhere ahead of UTC. In IST a
30/07 bill exported as 29/07. That is why `excelCell()` uses `Date.UTC(...)` - keep it that
way if you touch the date handling.

To change the date display format, edit the `format` string (Excel number-format syntax,
e.g. `'dd-mmm-yyyy'`). To add currency formatting to a numeric column, add
`format: '#,##0.00'` to the number branch.

---

## 9. Add a new API endpoint

**File: `backend/src/routes/chat.ts`.** Endpoints are plain Express handlers:

```ts
chatRouter.get('/top-customers', async (_req, res) => {
  try {
    const result = await runQuery(`
      SELECT TOP (10) a.[AcName] AS [Customer], COUNT(*) AS [Bills]
      FROM [dbo].[InvTranTbl] i
      JOIN [dbo].[Account] a ON a.[id] = i.[AccountId]
      WHERE i.[InvSR] = 'SIN'
      GROUP BY a.[AcName]
      ORDER BY COUNT(*) DESC`);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
```

It is served at `/api/top-customers` because `index.ts` mounts the router under `/api`.
Call it from Angular by adding a method to `frontend/src/app/services/chat.service.ts`.

---

## 10. Editing workflow

```powershell
# backend - restarts itself when you save a .ts file
cd "E:\SoftTrade Brain\backend"
npm run dev

# frontend - hot reloads in the browser
cd "E:\SoftTrade Brain\frontend"
npm start
```

**`.env` changes are the exception — they need a full `Ctrl+C` and restart.** `tsx watch` only
watches `src/`, which is why a `.env` edit appears to do nothing.

### Testing a glossary change without clicking through the UI

Put this in `backend/try.ts`, run `npx tsx try.ts`, delete it when done:

```ts
import { getSchema, renderSchemaForPrompt, renderTableNamesForPrompt } from './src/schema';
import { planQuery, selectTables, toTableFilter, explainResult } from './src/llm';
import { guardSql } from './src/sqlGuard';
import { runQuery } from './src/db';

(async () => {
  const schema = await getSchema();
  const names = renderTableNamesForPrompt(schema);

  for (const question of ['How many bills in July 2026?', 'How many purchase bills in July 2026?']) {
    const selected = await selectTables(question, [], names);
    const plan = await planQuery(question, [], renderSchemaForPrompt(schema, toTableFilter(selected)), schema.notes);
    if (plan.action !== 'query') { console.log(plan.message); continue; }
    const result = await runQuery(guardSql(plan.sql).sql);
    console.log('\nQ:', question);
    console.log('SQL:', plan.sql.replace(/\s+/g, ' '));
    console.log('A:', await explainResult(question, plan.sql, result, schema.notes));
  }
  process.exit(0);
})();
```

This runs the exact pipeline the API uses, so what you see here is what the chat will say.

---

## 11. Things to leave alone

- **`backend/src/sqlGuard.ts`** — the read-only enforcement. It has 15 test cases behind it
  (7 valid queries allowed, 8 injection and write attempts blocked). If you widen the allowed
  keywords you remove the protection that stops a generated query modifying your data.
- **`backend/src/db.ts`** — the connection pool and date/Buffer normalisation.
- **`.env` should never be committed** — it holds your OpenAI key and SQL password.
  `backend/.gitignore` already excludes it.
