import OpenAI from 'openai';
import type { BrainConfig, ChatTurn, Plan, QueryResult, UserContext } from './types';
import { buildBusinessGlossary } from './domain';
import { buildUserScopePrompt } from './permissions';

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
  'AREA',
];

export class LLMClient {
  private client: OpenAI;

  constructor(private readonly config: BrainConfig) {
    this.client = new OpenAI({ apiKey: config.openai.apiKey });
  }

  public async selectTables(
    question: string,
    history: ChatTurn[],
    tableNames: string,
    user?: UserContext,
    maxTables = 12
  ): Promise<string[]> {
    const glossary = buildBusinessGlossary(this.config);
    const userScope = buildUserScopePrompt(user);

    const response = await this.client.chat.completions.create({
      model: this.config.openai.model || 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You choose which database tables are needed to answer a business question for SoftTrade ERP.',
            'Reply with JSON only: {"tables":["dbo.TableA","dbo.TableB"]} - at most ' + maxTables + ' tables.',
            'Include every table needed for joins, especially master tables holding readable names.',
            'If the question is a greeting or unrelated to the database, reply {"tables":[]}.',
            '',
            glossary,
            userScope ? '\n' + userScope : '',
            '',
            'AVAILABLE TABLES (Permission-filtered for this user):',
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
      return tables.filter((t: unknown): t is string => typeof t === 'string').slice(0, maxTables);
    } catch {
      return [];
    }
  }

  public toTableFilter(selected: string[]): Set<string> {
    const names = selected.length ? selected : FALLBACK_TABLES;
    const filter = new Set<string>();
    for (const name of names) {
      const lower = name.toLowerCase();
      filter.add(lower);
      filter.add(lower.replace(/^[?dbo]?\./, '').replace(/[\[\]]/g, ''));
    }
    return filter;
  }

  public async planQuery(
    question: string,
    history: ChatTurn[],
    schemaText: string,
    notes = '',
    user?: UserContext
  ): Promise<Plan> {
    const glossary = buildBusinessGlossary(this.config);
    const userScope = buildUserScopePrompt(user);

    const systemPrompt = [
      'You are a senior data analyst for the SoftTrade Brain ERP application.',
      'You translate business questions into a single read-only Microsoft SQL Server (T-SQL) query.',
      '',
      'You must reply with JSON only, in one of these two shapes:',
      '{"action":"query","sql":"<T-SQL SELECT statement>","intent":"<one short sentence describing what the query counts or lists>"}',
      '{"action":"answer","message":"<a reply in plain English>"}',
      '',
      'Use "query" whenever the question can be answered from the database below.',
      'Use "answer" for greetings, for questions unrelated to this database, or if the user asks for data outside their permission scope.',
      '',
      'RULES FOR THE SQL:',
      '- SELECT statements only. Never INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, CREATE, EXEC or SELECT INTO.',
      '- Exactly one statement. No semicolons, no batch separators, no comments.',
      '- Always schema-qualify and bracket names, e.g. [dbo].[InvTranTbl].',
      '- Only use tables and columns that appear in the schema below. Never invent names.',
      '- For "today" use CAST(GETDATE() AS date).',
      '- "How many X" means SELECT COUNT(*). Give the count column a readable alias.',
      '- Never return a bare id as the answer to a "which/who" question. If the result identifies a party or account, JOIN [dbo].[Account] and select [AcName].',
      '- When listing rows, add TOP (100) and a sensible ORDER BY.',
      '- When ordering recent or latest bills/invoices, ALWAYS use ORDER BY [EIDocDate] DESC, [InvSeqno] DESC.',
      '- MANDATORY RecStatus FILTER (MASTER DATA & TRANSACTIONS): For every table containing [RecStatus] (including master tables like Account, Item, MastById, Party, PersonMaster, TransportMaster, Station, District, ConsMast, TDSRate, TaxType and transaction tables like InvTranTbl, Stock, SIDtl, Grledger, ORDHDR, OrdDtl, Vheader), ALWAYS filter: ISNULL([<TableAlias>].[RecStatus], 0) NOT IN (-1, 2).',
      '- Alias every computed column with a human-readable name, e.g. AS [Total Bills Today].',
      '',
      glossary,
      notes ? '\n' + notes : '',
      userScope ? '\n' + userScope : '',
      '',
      'DATABASE SCHEMA (only the tables relevant to this question are shown):',
      schemaText,
    ].join('\n');

    const response = await this.client.chat.completions.create({
      model: this.config.openai.model || 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-6).map((turn) => ({ role: turn.role, content: turn.content } as const)),
        { role: 'user', content: question },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('The model returned a response that was not valid JSON: ' + raw.slice(0, 200));
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

  public async explainResult(
    question: string,
    sql: string,
    result: QueryResult,
    notes = ''
  ): Promise<string> {
    const maxSummaryRows = this.config.maxRowsForSummary ?? 50;
    const sample = result.rows.slice(0, maxSummaryRows);

    const response = await this.client.chat.completions.create({
      model: this.config.openai.model || 'gpt-4o',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: [
            'You explain SQL query results to business users for SoftTrade ERP.',
            'Answer the question directly, leading with the key numbers and facts.',
            'Use the exact values from the result - never estimate or invent figures.',
            'Never state a date that does not appear in this prompt.',
            'Do not describe the SQL or mention tables unless the user asked about them.',
            'This is an Indian business: all amounts are Indian Rupees. Write them with a Rs prefix or ₹ symbol',
            'and Indian digit grouping where natural (e.g. Rs 3,25,28,199.14 or ₹3,25,28,199.14). Never use a dollar sign.',
            'Format large counts readably (e.g. 1,240).',
            'CRITICAL RULE FOR TRADING ACCOUNT / TRADING STATEMENTS:',
            'When the question is about Trading Account or Trading Statement:',
            '  - ALWAYS provide a clean Side-by-Side Summary breakdown of Debit Side (Opening Stock, Net Purchases, Direct Expenses, Stock Transfer In) vs Credit Side (Net Sales, Stock Transfer Out, Closing Stock).',
            '  - ALWAYS compute and state Total Debit Cost, Total Credit Revenue, and the exact Gross Profit (Total Credits - Total Debits) or Gross Loss.',
            'CRITICAL RULE FOR PROFIT & LOSS ACCOUNT / P&L STATEMENTS:',
            'When the question is about Profit & Loss Account or P&L Statement:',
            '  - ALWAYS provide a clean Side-by-Side Summary breakdown of Credit Side (Gross Profit b/d, Indirect Incomes) vs Debit Side (Indirect Expenses).',
            '  - ALWAYS compute and state Total Credit Revenue, Total Debit Expenses, and the resulting Net Profit or Net Loss (Total Credits - Total Debits).',
            notes,
          ]
            .filter(Boolean)
            .join('\n'),
        },
        {
          role: 'user',
          content: [
            'Question: ' + question,
            'SQL that was run:\n' + sql,
            'Rows returned: ' + result.rowCount + (result.truncated ? ' (showing the first ' + result.rows.length + ')' : ''),
            'Columns: ' + (result.columns.join(', ') || '(none)'),
            'Result data (JSON):\n' + JSON.stringify(sample),
          ].join('\n\n'),
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? 'The query ran, but I could not summarise the result.';
  }

  public async repairQuery(
    question: string,
    badSql: string,
    errorMessage: string,
    schemaText: string,
    notes = '',
    user?: UserContext
  ): Promise<Plan> {
    return this.planQuery(
      [
        'The previous attempt to answer this question failed.',
        'Question: ' + question,
        'Query that failed:\n' + badSql,
        'Database error: ' + errorMessage,
        'Write a corrected query using only tables and columns that exist in the schema.',
      ].join('\n\n'),
      [],
      schemaText,
      notes,
      user
    );
  }
}
