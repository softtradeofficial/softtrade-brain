# SoftTrade Brain — Chat with your SQL Server database

An Angular 15 chat UI backed by a Node/Express API that turns plain-English questions
("How many companies are there?", "How many bills today?") into read-only T-SQL,
runs them against your SQL Server database, and explains the results using OpenAI **GPT-4o**.

```
You → Angular chat →  /api/chat  →  GPT-4o (question + live schema → SQL)
                                  →  SQL guard (read-only, single statement, row cap)
                                  →  SQL Server
                                  →  GPT-4o (rows → plain-English answer)
                     ← answer + generated SQL + result table
```

## What's in the box

```
backend/          Node 20+/Express + TypeScript API
  src/config.ts     environment configuration
  src/db.ts         mssql connection pool, result normalisation
  src/schema.ts     INFORMATION_SCHEMA introspection (auto-discovers your tables)
  src/llm.ts        GPT-4o prompts: question → SQL, rows → answer, error → repaired SQL
  src/sqlGuard.ts   safety layer that validates every generated query
  src/routes/chat.ts POST /api/chat, GET /api/schema
frontend/         Angular 15 chat UI
  src/app/components/chat          message list, composer, schema sidebar
  src/app/components/result-table  result grid with CSV and Excel (.xlsx) export
  src/app/services/chat.service.ts HTTP client
```

## Setup

### 1. Backend

In the first terminal (Windows PowerShell — one command per line; PowerShell 5.1 has no `&&`):

```powershell
cd "E:\SoftTrade Brain\backend"
Copy-Item .env.example .env
notepad .env                  # fill in OPENAI_API_KEY and the DB_* settings, then save
npm run dev                   # http://localhost:3000
```

Fill in `.env`:

| Variable | Notes |
| --- | --- |
| `OPENAI_API_KEY` | Your OpenAI key. |
| `OPENAI_MODEL` | Defaults to `gpt-4o`. |
| `DB_SERVER`, `DB_DATABASE` | Required. |
| `DB_USER`, `DB_PASSWORD` | SQL authentication. **Use a `db_datareader`-only login.** |
| `DB_INSTANCE` | For named instances (e.g. `SQLEXPRESS`) instead of `DB_PORT`. |
| `ALLOWED_SCHEMAS` | Optional whitelist, e.g. `dbo,reporting`. Empty means all schemas. |
| `MAX_ROWS` | Hard cap on rows returned (default 200). |

Leaving `DB_USER` empty switches to Windows integrated authentication, which additionally
requires `npm install msnodesqlv8`.

### 2. Frontend

In a **second** terminal (leave the backend running in the first):

```powershell
cd "E:\SoftTrade Brain\frontend"
npm start                     # http://localhost:4200
```

Dependencies for both projects are already installed.

`npm start` proxies `/api` to `http://localhost:3000`, and `src/environments/environment.ts`
also points directly at the API, so either route works in development.

## How a question is answered

1. On startup the API reads `INFORMATION_SCHEMA.TABLES/COLUMNS` plus `sys.foreign_key_columns`
   and caches the result for 10 minutes. Backup and scratch tables (`*_bak`, `*_backup`,
   `*_old`, date-stamped copies) are filtered out by `domain.ts`.
2. **Table selection.** The question plus the bare list of table names (~900 tokens) goes to
   GPT-4o, which returns the handful of tables the question needs. This matters: sending all
   246 tables with their 5,000 columns costs ~25,000 tokens, and this account's gpt-4o limit
   is 30,000 tokens *per minute* - one question would exhaust it. Selecting first cuts a
   typical question to ~2,000 tokens.
3. Only the selected tables' columns, plus the business glossary from `domain.ts`, go to
   GPT-4o, which replies with JSON: either a `SELECT` statement or a direct answer (for
   greetings or questions the database can't answer).
4. `sqlGuard.ts` validates the statement before it touches the database.
5. If SQL Server rejects the query, the error is fed back to GPT-4o for **one** repair attempt.
6. The rows are sent back to GPT-4o, which writes the sentence you see; the table and the
   generated SQL are shown alongside it so you can verify the answer.

## The business glossary

`backend/src/domain.ts` is the file to edit as you learn more about the data. The SoftTrade
schema uses abbreviated names and carries **no foreign key constraints**, so without hints the
model guesses - it originally answered "how many bills today" from `ORDHDR` (sales *orders*)
instead of `InvTranTbl` (actual bills).

Verified mappings currently in place:

| Business term | Table | Notes |
| --- | --- | --- |
| bill / invoice | `dbo.InvTranTbl` | date **`EIDocDate`**, number `InvSeqno`, amount `EIInvAmt`, always filtered to `InvSR='SIN'` |
| sale invoice header | `dbo.SIHDR` | joins `SIHDR.InvTranIdNo = InvTranTbl.id`, lines in `SIDtl` |
| order | `dbo.ORDHDR` / `dbo.OrdDtl` | explicitly *not* bills |
| company | `dbo.company` | name `COname` |
| party / customer | `dbo.Party` | readable name via `dbo.Account.AcName` |
| voucher | `dbo.Vheader` | type via `Vntype.VtName` |

Two traps this encodes, both found by querying the data: `GSTDate` looks like the bill date but
is a **1975 placeholder on every sales invoice** (only `EIDocDate` is populated across all
24,856 rows), and `InvTranTbl` mixes sales invoices, purchases, credit notes and debit notes,
so every bill query is filtered to `InvSR = 'SIN'` unless the user asks otherwise.

`domain.ts` also probes the latest bill date at startup, so a question about "today" that
returns zero says *"0 bills today; the most recent bill in the data is dated 2026-07-20"*
rather than a bare zero.

## Safety model

The API is read-only by construction, at three layers:

- **The prompt** tells the model it may only write `SELECT`.
- **The guard** (`sqlGuard.ts`) strips comments, rejects anything that isn't a single
  `SELECT`/`WITH` statement, blocks `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `ALTER`,
  `CREATE`, `EXEC`, `SELECT ... INTO`, `sp_`/`xp_` procedures, `OPENROWSET`, `DBCC` and
  friends, and injects `TOP (n)` into unbounded `SELECT`s.
- **The database login** should be `db_datareader` only. That is your real guarantee —
  treat the first two layers as defence in depth, not as a substitute.

Generated SQL is always shown in the UI ("View SQL"). An LLM can still write a query that
runs cleanly but answers a subtly different question, so review the SQL before acting on
anything that matters.

## API

`POST /api/chat`

```json
{ "message": "how many bills today?", "history": [] }
```

```json
{
  "answer": "There were 47 bills created today.",
  "sql": "SELECT COUNT(*) AS [Bills Today] FROM [dbo].[Invoice] WHERE ...",
  "intent": "Counts rows in dbo.Invoice created today",
  "columns": ["Bills Today"],
  "rows": [{ "Bills Today": 47 }],
  "rowCount": 1,
  "elapsedMs": 38
}
```

`GET /api/schema` — the discovered tables and columns (add `?refresh=true` to re-introspect).
`GET /api/health` — connection and model info.

## Notes

- Angular 15 officially supports Node 14/16/18; this project was built and verified on
  Node 24, which required `NG_DISABLE_VERSION_CHECK=1` for `ng new`. Development and
  production builds both succeed. If you hit an odd CLI error later, run the frontend on
  Node 18.
- Costs: every question makes three GPT-4o calls (select tables, write SQL, explain result),
  totalling roughly 2,000-4,000 tokens. `ALLOWED_SCHEMAS=dbo` and the exclusion list in
  `domain.ts` keep this down.
- Model: `gpt-4o-mini` was tried and rejected - asked how many bills were created today, it
  invented "the latest available data is from October 2023" when the prompt plainly said
  2026-07-20. gpt-4o answers correctly. Keep `OPENAI_MODEL=gpt-4o`.
