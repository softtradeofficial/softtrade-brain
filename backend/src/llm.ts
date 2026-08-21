import OpenAI from 'openai';
import { config } from './config';
import type { QueryResult } from './db';
import { BUSINESS_GLOSSARY } from './domain';

const client = new OpenAI({ apiKey: config.openai.apiKey });

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** The SQL that produced an assistant turn, so follow-up questions can reuse its tables. */
  sql?: string;
}

export type Plan =
  | { action: 'query'; sql: string; intent: string }
  | { action: 'answer'; message: string };

/**
 * Tables that are almost always needed for a readable answer, used as a fallback when the
 * selection step returns nothing usable.
 */
const FALLBACK_TABLES = [
  'InvTranTbl',
  'SIHDR',
  'SIDtl',
  'ORDHDR',
  'OrdDtl',
  'company',
  'Party',
  'Account',
  'Vheader',
  'Vntype',
  'Stock',
  'Item',
];

/** Upper bound on how many tables get their full column list sent to the model. */
const MAX_SELECTED_TABLES = 12;

/**
 * Table names referenced by a query, read straight back out of the SQL.
 *
 * A follow-up ("and which of those is highest?", "same for last month") rarely names its
 * tables, so selecting from the question alone drops whatever the previous answer used.
 */
export function tablesFromSql(sql: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(?:FROM|JOIN)\s+(\[?\w+\]?\s*\.\s*)?\[?(\w+)\]?/gi;

  for (const match of sql.matchAll(pattern)) {
    const schema = match[1] ? match[1].replace(/[[\]\s.]/g, '') : 'dbo';
    found.add(`${schema}.${match[2]}`);
  }

  return [...found];
}

/** Words that appear in almost every question and match nothing useful. */
const STOP_WORDS = new Set([
  'show', 'list', 'give', 'tell', 'find', 'display', 'want', 'need', 'please', 'have', 'with',
  'what', 'which', 'when', 'where', 'whom', 'this', 'that', 'these', 'those', 'their', 'there',
  'them', 'they', 'from', 'into', 'about', 'many', 'much', 'most', 'more', 'less', 'total',
  'count', 'sum', 'each', 'every', 'all', 'any', 'some', 'other', 'same', 'particular',
  'perticular', 'recent', 'latest', 'last', 'first', 'today', 'yesterday', 'month', 'year',
  'date', 'data', 'database', 'table', 'tables', 'column', 'row', 'rows', 'record', 'records',
  'value', 'name', 'names', 'number', 'detail', 'details', 'info', 'information', 'and', 'the',
  'for', 'are', 'was', 'were', 'how', 'who', 'why', 'per', 'top', 'get',
]);

/**
 * Tables whose name literally contains a word from the question.
 *
 * The model-driven selection below is biased by the sales glossary and will occasionally miss
 * a whole subject area - it answered "there are no user permission tables" on a database that
 * has UserRoles and RoleMaster. This costs nothing and does not miss an exact name match.
 */
export function tablesMatchingQuestion(question: string, tableNames: string[], limit = 8): string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
    .map((word) => (word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word));

  if (!words.length) return [];

  const scored = tableNames
    .map((qualified) => {
      const name = qualified.split('.').pop()!.toLowerCase();
      const hits = words.filter((word) => name.includes(word));
      // Prefer tables matching more of the question, then the tightest name for that match.
      return { qualified, score: hits.length, length: name.length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.length - b.length);

  return scored.slice(0, limit).map((entry) => entry.qualified);
}

/** Tables used by the most recent assistant turns, newest first. */
export function recentTables(history: ChatTurn[]): string[] {
  const found = new Set<string>();
  for (const turn of [...history].reverse()) {
    if (turn.role !== 'assistant' || !turn.sql) continue;
    for (const table of tablesFromSql(turn.sql)) found.add(table);
    if (found.size >= MAX_SELECTED_TABLES) break;
  }
  return [...found].slice(0, MAX_SELECTED_TABLES);
}

/**
 * Stage one: pick the handful of tables a question needs.
 *
 * Sending all 246 tables with their 5,000 columns costs ~25,000 tokens per question, which
 * exceeds a 30,000 tokens-per-minute account limit after a single question. Selecting first
 * from the table names alone costs ~2,000 tokens and lets stage two send only what matters.
 */
export async function selectTables(
  question: string,
  history: ChatTurn[],
  tableNames: string,
  previous: string[] = [],
  nameMatches: string[] = []
): Promise<string[]> {
  const response = await client.chat.completions.create({
    model: config.openai.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You choose which database tables are needed to answer a business question.',
          `Reply with JSON only: {"tables":["dbo.TableA","dbo.TableB"]} - at most ${MAX_SELECTED_TABLES} tables.`,
          'Include every table needed for joins, especially the master tables that hold readable',
          'names for any id you will need to resolve.',
          'If the question is a greeting or unrelated to the database, reply {"tables":[]}.',
          previous.length
            ? [
                '',
                `The previous answer in this conversation used: ${previous.join(', ')}.`,
                'Short or vague questions are almost always follow-ups about that same subject, even',
                'when they are worded loosely or contain typos. Keep those tables in your answer',
                'unless the question has clearly moved on to a different subject.',
              ].join('\n')
            : '',
          nameMatches.length
            ? [
                '',
                `These table names contain words from the question: ${nameMatches.join(', ')}.`,
                'The glossary below is about sales and stock; it says nothing about other parts of',
                'the system. When the question is about one of those, trust these names over it.',
              ].join('\n')
            : '',
          '',
          BUSINESS_GLOSSARY,
          '',
          'AVAILABLE TABLES:',
          tableNames,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      ...history.slice(-4).map((turn) => ({ role: turn.role, content: turn.content } as const)),
      { role: 'user', content: question },
    ],
  });

  try {
    const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}');
    const tables = Array.isArray(parsed.tables) ? parsed.tables : [];
    return tables.filter((t: unknown): t is string => typeof t === 'string').slice(0, MAX_SELECTED_TABLES);
  } catch {
    return [];
  }
}

/**
 * Normalises selected names into the lookup set `renderSchemaForPrompt` expects.
 *
 * The previous turn's tables are always included: if the selection step misreads a follow-up,
 * the schema still contains what the conversation was already about.
 */
export function toTableFilter(selected: string[], previous: string[] = []): Set<string> {
  const chosen = selected.length ? selected : previous.length ? previous : FALLBACK_TABLES;
  const names = [...new Set([...chosen, ...previous])];

  const filter = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    filter.add(lower);
    filter.add(lower.replace(/^\[?dbo\]?\./, '').replace(/[[\]]/g, ''));
  }
  return filter;
}

function planningSystemPrompt(schemaText: string, notes: string): string {
  return [
    'You are a senior data analyst for the SoftTrade Brain application.',
    'You translate business questions into a single read-only Microsoft SQL Server (T-SQL) query.',
    '',
    'You must reply with JSON only, in one of these two shapes:',
    '{"action":"query","sql":"<T-SQL SELECT statement>","intent":"<one short sentence describing what the query counts or lists>"}',
    '{"action":"answer","message":"<a reply in plain English>"}',
    '',
    'Use "query" whenever the question can be answered from the database below.',
    'Use "answer" for greetings, for questions unrelated to this database, or when the question is too',
    'ambiguous to guess at - in that case ask one specific clarifying question.',
    '',
    'RULES FOR THE SQL:',
    '- SELECT statements only. Never INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, CREATE, EXEC or SELECT INTO.',
    '- Exactly one statement. No semicolons, no batch separators, no comments.',
    '- Always schema-qualify and bracket names, e.g. [dbo].[InvTranTbl].',
    '- Only use tables and columns that appear in the schema below. Never invent names.',
    '- For "today" use CAST(GETDATE() AS date). For a date range on a datetime column prefer',
    '  col >= CAST(GETDATE() AS date) AND col < DATEADD(day, 1, CAST(GETDATE() AS date))',
    '  rather than CAST(col AS date) = ..., so indexes can still be used.',
    '- "How many X" means SELECT COUNT(*). Give the count column a readable alias.',
    '- Never return a bare id as the answer to a "which/who" question. If the result identifies',
    '  a party, account, item or company, JOIN to the master table and select the readable name',
    '  (for example [dbo].[Account].[AcName]) alongside or instead of the id.',
    '- When listing rows, add TOP (100) and a sensible ORDER BY.',
    '- Alias every computed column with a human-readable name, e.g. AS [Total Bills Today].',
    '- If several tables could plausibly answer the question, pick the most specific one and say which',
    '  one you used in "intent".',
    '',
    BUSINESS_GLOSSARY,
    notes ? '\n' + notes : '',
    '',
    'DATABASE SCHEMA (only the tables relevant to this question are shown):',
    schemaText,
  ].join('\n');
}

/** Turns the user's question into either a SQL plan or a direct reply. */
export async function planQuery(
  question: string,
  history: ChatTurn[],
  schemaText: string,
  notes = ''
): Promise<Plan> {
  const response = await client.chat.completions.create({
    model: config.openai.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: planningSystemPrompt(schemaText, notes) },
      ...history.slice(-6).map((turn) => ({ role: turn.role, content: turn.content } as const)),
      { role: 'user', content: question },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The model returned a response that was not valid JSON: ${raw.slice(0, 200)}`);
  }

  if (parsed['action'] === 'query' && typeof parsed['sql'] === 'string') {
    return {
      action: 'query',
      sql: parsed['sql'],
      intent: typeof parsed['intent'] === 'string' ? parsed['intent'] : '',
    };
  }

  return {
    action: 'answer',
    message:
      typeof parsed['message'] === 'string'
        ? parsed['message']
        : 'I could not work out how to answer that from this database. Could you rephrase it?',
  };
}

/** Turns the result set back into a sentence a business user can read. */
export async function explainResult(
  question: string,
  sql: string,
  result: QueryResult,
  notes = ''
): Promise<string> {
  const sample = result.rows.slice(0, config.maxRowsForSummary);

  const response = await client.chat.completions.create({
    model: config.openai.model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: [
          'You explain SQL query results to business users.',
          'Answer the question directly in one or two short sentences, leading with the number or the key fact.',
          'Use the exact values from the result - never estimate or invent figures.',
          'Never state a date that does not appear in this prompt.',
          'Do not describe the SQL or mention tables unless the user asked about them.',
          'The full table of rows is already displayed to the user, so do not repeat more than a few examples.',
          'This is an Indian business: all amounts are Indian Rupees. Write them with a Rs prefix',
          'and Indian digit grouping where natural (e.g. Rs 3,25,28,199.14). Never use a dollar sign.',
          'Format large counts readably (e.g. 1,240).',
          notes,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      {
        role: 'user',
        content: [
          `Question: ${question}`,
          `SQL that was run:\n${sql}`,
          `Rows returned: ${result.rowCount}${result.truncated ? ` (showing the first ${result.rows.length})` : ''}`,
          `Columns: ${result.columns.join(', ') || '(none)'}`,
          `Result data (JSON):\n${JSON.stringify(sample)}`,
        ].join('\n\n'),
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? 'The query ran, but I could not summarise the result.';
}

/** Asks the model for a corrected query after SQL Server rejected the first attempt. */
export async function repairQuery(
  question: string,
  badSql: string,
  errorMessage: string,
  schemaText: string,
  notes = ''
): Promise<Plan> {
  return planQuery(
    [
      `The previous attempt to answer this question failed.`,
      `Question: ${question}`,
      `Query that failed:\n${badSql}`,
      `Database error: ${errorMessage}`,
      `Write a corrected query using only tables and columns that exist in the schema.`,
    ].join('\n\n'),
    [],
    schemaText,
    notes
  );
}
