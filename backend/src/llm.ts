import OpenAI from 'openai';
import { config } from './config';
import type { QueryResult } from './db';
import { BUSINESS_GLOSSARY } from './domain';

const client = new OpenAI({ apiKey: config.openai.apiKey });

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
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
 * Stage one: pick the handful of tables a question needs.
 *
 * Sending all 246 tables with their 5,000 columns costs ~25,000 tokens per question, which
 * exceeds a 30,000 tokens-per-minute account limit after a single question. Selecting first
 * from the table names alone costs ~2,000 tokens and lets stage two send only what matters.
 */
export async function selectTables(
  question: string,
  history: ChatTurn[],
  tableNames: string
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
          '',
          BUSINESS_GLOSSARY,
          '',
          'AVAILABLE TABLES:',
          tableNames,
        ].join('\n'),
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

/** Normalises selected names into the lookup set `renderSchemaForPrompt` expects. */
export function toTableFilter(selected: string[]): Set<string> {
  const names = selected.length ? selected : FALLBACK_TABLES;
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
