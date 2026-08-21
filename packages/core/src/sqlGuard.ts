export class UnsafeSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeSqlError';
  }
}

/**
 * Statements the model must never be able to run, even by accident.
 * Word boundaries keep column names such as [CreatedOn] or [IsDeleted] from tripping this.
 */
const FORBIDDEN = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bMERGE\b/i,
  /\bTRUNCATE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bDENY\b/i,
  /\bBACKUP\b/i,
  /\bRESTORE\b/i,
  /\bSHUTDOWN\b/i,
  /\bRECONFIGURE\b/i,
  /\bEXEC(UTE)?\b/i,
  /\bINTO\b/i,
  /\bWAITFOR\b/i,
  /\bOPENROWSET\b/i,
  /\bOPENQUERY\b/i,
  /\bOPENDATASOURCE\b/i,
  /\bBULK\b/i,
  /\bDBCC\b/i,
  /\bSET\s/i,
  /\bxp_/i,
  /\bsp_/i,
];

/** Removes comments and string literals so keyword checks cannot be smuggled past. */
function stripCommentsAndStrings(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Strips comments but preserves string literals - this is what actually gets executed. */
function stripComments(query: string): string {
  return query.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Drops markdown fences the model sometimes wraps around its SQL. */
function unfence(query: string): string {
  return query
    .trim()
    .replace(/^```(?:sql)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/** Adds TOP (n) to a bare SELECT so a runaway query cannot stream millions of rows. */
function applyRowLimit(query: string, maxRows = 200): string {
  const analysed = stripCommentsAndStrings(query);

  // Queries that already limit themselves are left alone.
  if (/\bSELECT\s+(TOP|DISTINCT\s+TOP)\b/i.test(analysed)) return query;
  if (/\bOFFSET\b[\s\S]*\bFETCH\b/i.test(analysed)) return query;
  // Aggregate-only queries return one row per group; adding TOP would be misleading.
  if (/\bGROUP\s+BY\b/i.test(analysed)) return query;
  if (/^\s*WITH\b/i.test(analysed)) return query;
  if (/\bCOUNT\s*\(|\bSUM\s*\(|\bAVG\s*\(|\bMIN\s*\(|\bMAX\s*\(/i.test(analysed)) return query;

  return query.replace(/^(\s*SELECT\s+)(DISTINCT\s+)?/i, (_m, select, distinct) =>
    `${select}${distinct ?? ''}TOP (${maxRows}) `
  );
}

/** Best-effort human-readable name for a blocked keyword pattern. */
function keywordName(pattern: RegExp): string {
  const match = pattern.source.match(/[A-Z_]{2,}/);
  return match ? match[0] : "restricted";
}

export interface GuardResult {
  /** The query that is safe to execute (comments stripped, row limit applied). */
  sql: string;
}

/**
 * Validates model-generated SQL before it ever reaches the database.
 * Read-only, single statement, no procedure calls, hard row cap.
 */
export function guardSql(rawQuery: string, maxRows = 200): GuardResult {
  const unfenced = unfence(rawQuery);
  if (!unfenced) {
    throw new UnsafeSqlError('The model did not return a query.');
  }

  let query = stripComments(unfenced).trim().replace(/;\s*$/, '').trim();
  const analysed = stripCommentsAndStrings(query);

  if (!/^\s*(SELECT|WITH)\b/i.test(analysed)) {
    throw new UnsafeSqlError('Only SELECT queries are allowed.');
  }

  if (analysed.includes(';')) {
    throw new UnsafeSqlError('Only a single statement is allowed.');
  }

  for (const pattern of FORBIDDEN) {
    if (pattern.test(analysed)) {
      throw new UnsafeSqlError(
        `The generated query contains a disallowed keyword (${keywordName(pattern)}). This API is read-only.`
      );
    }
  }

  query = applyRowLimit(query, maxRows);
  return { sql: query };
}
