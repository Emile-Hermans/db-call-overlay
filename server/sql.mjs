// SQL shredding: turn a raw command into statements, shapes, tables and row keys.
// Everything the analyzer reasons about is derived here.

const LITERAL = /'(?:[^']|'')*'/g
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /--[^\n\r]*/g
const PARAM_TOKEN = /@{1,2}[A-Za-z_][A-Za-z0-9_]*/g

// Statements EF emits around a real batch - they are plumbing, not database work.
const SCAFFOLDING = [
  /^SET\s+(NOCOUNT|IMPLICIT_TRANSACTIONS|XACT_ABORT|ANSI_|QUOTED_|ARITH|CONCAT|NUMERIC_)/i,
  /^SELECT\s+@@ROWCOUNT\s*$/i,
  /^DECLARE\s+@/i,
  /^IF\s+@@ROWCOUNT/i,
  /^(BEGIN|END|COMMIT|ROLLBACK)\b\s*(TRANSACTION|TRAN)?\s*$/i,
  /^EXEC\s+sp_(reset_connection|executesql\s*$)/i,
]

/** Separator for composite keys; never appears in SQL or a parameter value. */
const SEP = String.fromCharCode(1)

const OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXEC', 'EXECUTE', 'CREATE', 'DROP', 'TRUNCATE']

/** Replaces string literals with a placeholder so ';' splitting is safe. */
function maskLiterals(sql) {
  return sql.replace(LITERAL, "'?'")
}

export function stripComments(sql) {
  return sql.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, ' ')
}

/** Canonical form: same shape => same normalized text, regardless of values. */
export function normalize(sql) {
  let s = maskLiterals(stripComments(sql))
  s = s.replace(/(?<![\w@#$[])\d+(?:\.\d+)?/g, '?')
  s = s.replace(PARAM_TOKEN, (m) => (m.startsWith('@@') ? m : '@p'))
  s = s.replace(/\bIN\s*\(\s*(?:@p|\?|'\?')(?:\s*,\s*(?:@p|\?|'\?'))*\s*\)/gi, 'IN (@p...)')
  s = s.replace(/\bVALUES\s*(\(\s*(?:@p|\?|'\?'|NULL)(?:\s*,\s*(?:@p|\?|'\?'|NULL))*\s*\))(\s*,\s*\1)+/gi, 'VALUES $1 ...')
  return s.replace(/\s+/g, ' ').trim()
}

function isScaffolding(stmt) {
  return SCAFFOLDING.some((re) => re.test(stmt))
}

function detectOp(stmt) {
  const first = stmt.replace(/^\(+/, '').trimStart().split(/[\s(]+/, 1)[0]?.toUpperCase() ?? ''
  if (first === 'WITH') {
    // CTE - the real operation follows the closing paren of the last CTE
    const m = stmt.match(/\)\s*(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i)
    return m ? m[1].toUpperCase() : 'SELECT'
  }
  return OPS.includes(first) ? (first === 'EXECUTE' ? 'EXEC' : first) : 'OTHER'
}

function ident(raw) {
  if (!raw) return null
  const parts = raw.split('.').map((p) => p.replace(/[[\]"`]/g, '').trim())
  return parts[parts.length - 1] || null
}

// [Bracketed], "quoted" or bare identifiers, optionally schema-qualified.
const IDENT = '(?:\\[[^\\]]+\\]|"[^"]+"|`[^`]+`|[A-Za-z_#][\\w$#]*)'
const TABLE_TOKEN = `(${IDENT}(?:\\.${IDENT})*)`

/** The table the statement is fundamentally about. */
export function primaryTable(stmt, op) {
  const patterns = {
    INSERT: [new RegExp('INSERT\\s+INTO\\s+' + TABLE_TOKEN, 'i')],
    DELETE: [new RegExp('DELETE\\s+(?:FROM\\s+)?' + TABLE_TOKEN, 'i')],
    MERGE: [new RegExp('MERGE\\s+(?:INTO\\s+)?' + TABLE_TOKEN, 'i')],
    UPDATE: [
      // ExecuteUpdate style: UPDATE [alias] SET ... FROM [Real] AS [alias]
      new RegExp('UPDATE\\s+[^\\s]+\\s+SET[\\s\\S]*?\\bFROM\\s+' + TABLE_TOKEN, 'i'),
      new RegExp('UPDATE\\s+' + TABLE_TOKEN, 'i'),
    ],
    SELECT: [new RegExp('\\bFROM\\s+' + TABLE_TOKEN, 'i')],
    EXEC: [new RegExp('EXEC(?:UTE)?\\s+' + TABLE_TOKEN, 'i')],
  }

  for (const re of patterns[op] ?? []) {
    const m = stmt.match(re)
    if (m) {
      const name = ident(m[1])
      if (name && !/^@/.test(name)) return name
    }
  }

  // Derived tables (FROM (SELECT ... FROM [X]) AS [t]), CTEs and other shapes the
  // patterns above skip: fall back to the first real table named anywhere. Better a
  // slightly broad answer than a group labelled with nothing at all.
  const anywhere = allTables(stmt)
  return anywhere[0] ?? null
}

export function allTables(stmt) {
  const found = new Set()
  const re = new RegExp('\\b(?:FROM|JOIN|INTO|UPDATE)\\s+' + TABLE_TOKEN, 'gi')
  let m
  while ((m = re.exec(stmt))) {
    const name = ident(m[1])
    if (name && !/^@/.test(name)) found.add(name)
  }
  return [...found]
}

/** Number of columns in a SELECT projection - a proxy for over-fetching. */
export function projectionWidth(stmt, op) {
  if (op !== 'SELECT') return 0
  const body = maskLiterals(stmt)
  const from = body.search(/\bFROM\b/i)
  const list = body.slice(body.search(/\bSELECT\b/i) + 6, from > 0 ? from : undefined)
  let depth = 0
  let count = 1
  for (const ch of list) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) count++
  }
  return count
}

/**
 * The parameters a single statement actually references, resolved against the
 * command's parameter list. This is what lets us tell "50 rows saved twice"
 * apart from "100 different rows saved once".
 */
function resolveParams(stmt, commandParams) {
  if (!commandParams?.length) return []
  const byName = new Map()
  for (const p of commandParams) {
    byName.set(String(p.n).replace(/^@+/, '').toLowerCase(), p.v)
  }

  const used = []
  const seen = new Set()
  let m
  PARAM_TOKEN.lastIndex = 0
  while ((m = PARAM_TOKEN.exec(stmt))) {
    const token = m[0]
    if (token.startsWith('@@')) continue
    const key = token.replace(/^@+/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (byName.has(key)) used.push({ n: token, v: byName.get(key) })
  }
  return used
}

/**
 * Identity of the row(s) a write targets: the parameter values in its WHERE.
 *
 * Returns null for "cannot tell", and that distinction matters. Parameter
 * capture is bounded, so in a large batch the later statements arrive with no
 * values at all. If those collapsed to one empty key they would look like
 * repeated writes to a single row, and every one would be reported as redundant.
 */
function rowKeyOf(stmt, op, resolved, referencesParams) {
  if (op !== 'UPDATE' && op !== 'DELETE') {
    if (referencesParams && resolved.length === 0) return null
    return resolved.map((p) => p.v).join(SEP)
  }

  const where = stmt.search(/\bWHERE\b/i)
  if (where < 0) return '(all rows)'

  const tail = stmt.slice(where)
  const names = new Set()
  let m
  PARAM_TOKEN.lastIndex = 0
  while ((m = PARAM_TOKEN.exec(tail))) {
    if (!m[0].startsWith('@@')) names.add(m[0].replace(/^@+/, '').toLowerCase())
  }

  const used = resolved.filter((p) => names.has(String(p.n).replace(/^@+/, '').toLowerCase()))

  // The WHERE names parameters, but none of their values reached us.
  if (names.size > 0 && used.length === 0) return null

  return used.map((p) => p.v).join(SEP)
}

/**
 * The columns an UPDATE assigns. Two writes to the same row are only redundant
 * when they set the same columns; different columns means each is persisting
 * something newly computed, which is an un-batched save, not a wasted write.
 */
function setColumnsOf(stmt, op) {
  if (op !== 'UPDATE') return []

  const setAt = stmt.search(/\bSET\b/i)
  if (setAt < 0) return []

  const stopAt = stmt.slice(setAt).search(/\b(WHERE|OUTPUT)\b/i)
  const body = stopAt > 0 ? stmt.slice(setAt + 3, setAt + stopAt) : stmt.slice(setAt + 3)

  const columns = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--

    if (ch === ',' && depth === 0) {
      columns.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  columns.push(current)

  return columns
    .map((c) => c.split('=')[0].trim().replace(/[[\]"`]/g, ''))
    .filter(Boolean)
    .sort()
}

/**
 * `EXEC sp_executesql N'SELECT ...'` hides the real query inside a string literal,
 * which otherwise gets masked away and leaves a statement with no table at all.
 */
function unwrapDynamicSql(sql) {
  const match = sql.match(/^\s*EXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(?:sys\.)?sp_(?:executesql|prepexec)\s+N?'((?:[^']|'')*)'/i)
  return match ? match[1].replace(/''/g, "'") : null
}

/** One raw DbCommand -> the real statements inside it. */
export function shred(rawSql, commandParams) {
  const dynamic = unwrapDynamicSql(rawSql ?? '')
  if (dynamic) {
    return shred(dynamic, commandParams)
  }

  const cleaned = stripComments(rawSql ?? '')
  const masked = maskLiterals(cleaned)

  // Split on the masked text, then slice the same offsets out of the real text.
  const statements = []
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ';') {
      statements.push(cleaned.slice(start, i))
      start = i + 1
    }
  }
  statements.push(cleaned.slice(start))

  const out = []
  let scaffolding = 0

  for (const raw of statements) {
    const stmt = raw.replace(/\s+/g, ' ').trim()
    if (!stmt) continue
    if (isScaffolding(stmt)) {
      scaffolding++
      continue
    }

    const op = detectOp(stmt)
    if (op === 'OTHER' && stmt.length < 12) {
      scaffolding++
      continue
    }

    const resolved = resolveParams(stmt, commandParams)
    out.push({
      op,
      text: stmt,
      shape: normalize(stmt),
      table: primaryTable(stmt, op),
      tables: allTables(stmt),
      width: projectionWidth(stmt, op),
      params: resolved,
      paramSig: resolved.map((p) => `${p.v}`).join(SEP),
      rowKey: rowKeyOf(stmt, op, resolved, /@[A-Za-z_]/.test(stmt)),
      setColumns: setColumnsOf(stmt, op),
      hasWhere: /\bWHERE\b/i.test(stmt),
      hasTop: /\b(TOP|OFFSET|FETCH\s+NEXT)\b/i.test(stmt),
    })
  }

  return { statements: out, scaffolding }
}
