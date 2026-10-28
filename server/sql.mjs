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
export const SEP = String.fromCharCode(1)

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
  const select = body.search(/\bSELECT\b/i)
  // The first FROM outside parentheses; a subquery in the select list has its own.
  let depth = 0
  let end = body.length
  for (let i = select + 6; i < body.length; i++) {
    if (body[i] === '(') depth++
    else if (body[i] === ')') depth--
    else if (depth === 0 && /^FROM\b/i.test(body.slice(i, i + 5)) && /\W/.test(body[i - 1])) {
      end = i
      break
    }
  }
  return splitTopLevel(body.slice(select + 6, end)).length || 1
}

// Words that can follow a table name but are never its alias.
const NOT_ALIAS = new Set([
  'WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'ORDER', 'GROUP',
  'HAVING', 'WITH', 'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'SET', 'OUTPUT', 'VALUES', 'SELECT',
  'FOR', 'OFFSET', 'FETCH', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'USING', 'APPLY',
])

const SOURCE_RE = new RegExp(
  '\\b(FROM|(?:(?:LEFT|RIGHT|FULL)(?:\\s+OUTER)?\\s+|INNER\\s+|CROSS\\s+)?JOIN|(?:CROSS|OUTER)\\s+APPLY)' +
    '(?:\\s+' + TABLE_TOKEN + '|\\s*(\\())',
  'gi',
)
const ALIAS_RE = new RegExp('^\\s+(?:AS\\s+)?(' + IDENT + ')')
const COLUMN_RE = new RegExp('^(' + IDENT + ')\\.(' + IDENT + '|\\*)(?:\\s+(?:AS\\s+)?' + IDENT + ')?$', 'i')
const QUALIFIER_RE = new RegExp('(' + IDENT + ')\\.(?=' + IDENT + ')', 'g')
const NAMED_RE = new RegExp('\\s+AS\\s+(' + IDENT + ')$', 'i')

const bare = (raw) => raw.replace(/[[\]"`]/g, '').trim().toLowerCase()

function aliasAfter(text) {
  const m = text.match(ALIAS_RE)
  if (!m || NOT_ALIAS.has(bare(m[1]).toUpperCase())) return null
  return bare(m[1])
}

function howOf(keyword) {
  const k = keyword.replace(/\s+/g, ' ').toUpperCase()
  if (k === 'FROM') return 'from'
  if (k.endsWith('APPLY')) return k.toLowerCase()
  if (k === 'JOIN' || k === 'INNER JOIN') return 'inner join'
  return k.replace(' OUTER', '').toLowerCase()
}

/** Splits a list on the commas that are not inside parentheses. */
function splitTopLevel(list) {
  const items = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      items.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) items.push(current.trim())
  return items
}

/**
 * Every table one statement reads, how it is brought in, and how many of its
 * columns the outer projection returns.
 *
 * One SELECT with joins is one round-trip, however many tables it touches. The
 * group row is labelled with the primary table only, so without this a single
 * joined read looks exactly like a narrow single-table read.
 *
 * A parenthesised source right after FROM / JOIN / APPLY is a derived table: its
 * tables are part of the row source. Any other parenthesised SELECT (EXISTS, IN,
 * a scalar subquery) is a lookup, reported as `subquery` with no column count.
 */
export function tableSources(stmt, op) {
  const s = maskLiterals(stmt)

  // Kind of every parenthesis: 'source' (derived table) or 'sub' (anything else).
  const parens = []
  const stack = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') {
      const kind = /\b(FROM|JOIN|APPLY)\s*$/i.test(s.slice(Math.max(0, i - 12), i)) ? 'source' : 'sub'
      const p = { open: i, close: s.length, kind, parent: stack[stack.length - 1] ?? null }
      parens.push(p)
      stack.push(p)
    } else if (s[i] === ')') {
      const p = stack.pop()
      if (p) p.close = i
    }
  }
  const innermost = (i) => {
    let best = null
    for (const p of parens) if (p.open < i && i < p.close && (!best || p.open > best.open)) best = p
    return best
  }
  const chain = (p) => {
    const out = []
    for (let q = p; q; q = q.parent) out.push(q)
    return out
  }

  const sources = []
  const derived = new Map() // paren -> { alias, how }
  SOURCE_RE.lastIndex = 0
  let m
  while ((m = SOURCE_RE.exec(s))) {
    const at = innermost(m.index)
    const ancestors = chain(at)
    const how = howOf(m[1])

    if (m[3]) {
      // Derived table: remember its alias; its own FROM inherits this join type.
      const p = parens.find((q) => q.open === m.index + m[0].length - 1)
      if (p) derived.set(p, { alias: aliasAfter(s.slice(p.close + 1)), how })
      continue
    }

    const table = ident(m[2])
    if (!table || /^@/.test(table)) continue

    const isSub = ancestors.some((q) => q.kind === 'sub')
    // The FROM of a derived table stands for the derived table itself.
    const owner = !isSub && at?.kind === 'source' && how === 'from' ? derived.get(at) : null
    sources.push({
      table,
      alias: aliasAfter(s.slice(m.index + m[0].length)),
      outerAlias: owner?.alias ?? null,
      how: isSub ? 'subquery' : (owner?.how ?? how),
      paren: at,
    })
  }

  // Columns come from the outermost projection. A column read through a derived
  // table ([t].[Name]) is followed into that table's own projection, so it is
  // charged to the real table it comes from rather than to the derived table's FROM.
  const aliasesIn = (scope) => {
    const map = new Map()
    for (const src of sources) if (src.paren === scope && src.alias && src.how !== 'subquery') map.set(src.alias, { src })
    for (const [p, d] of derived) if (d.alias && innermost(p.open) === scope) map.set(d.alias, { paren: p })
    return map
  }
  const projections = new Map()
  const projectionOf = (scope) => {
    if (projections.has(scope)) return projections.get(scope)
    const lo = scope ? scope.open + 1 : 0
    const hi = scope ? scope.close : s.length
    const inScope = (re) => {
      re.lastIndex = lo
      let hit
      while ((hit = re.exec(s)) && hit.index < hi) if (innermost(hit.index) === scope) return hit.index
      return -1
    }
    const select = inScope(/\bSELECT\b/gi)
    const from = select < 0 ? -1 : inScope(/\bFROM\b/gi)
    let items = []
    if (select >= 0 && from > select) {
      const list = s
        .slice(select + 6, from)
        .replace(/^\s*DISTINCT\s+/i, ' ')
        .replace(/^\s*TOP\s*(\(\s*[^)]*\)|\S+)(\s+PERCENT)?(\s+WITH\s+TIES)?\s+/i, ' ')
      items = splitTopLevel(list).map((item) => {
        const col = item.match(COLUMN_RE)
        const named = item.match(NAMED_RE)
        return {
          text: item,
          star: item === '*' || (col && col[2] === '*'),
          qualifiers: col ? [bare(col[1])] : [...item.matchAll(QUALIFIER_RE)].map((q) => bare(q[1])),
          column: col && col[2] !== '*' ? bare(col[2]) : null,
          name: named ? bare(named[1]) : col ? bare(col[2]) : null,
        }
      })
    }
    projections.set(scope, items)
    return items
  }
  const fromOf = (scope) => sources.find((x) => x.paren === scope && x.outerAlias != null) ?? null

  // Which real table one projected item comes from, or null when that is unclear.
  const ownerOf = (scope, item, depth = 0) => {
    const aliases = aliasesIn(scope)
    // An expression over several tables (CASE WHEN [a].[Id] IS NOT NULL THEN [b].[X])
    // returns its last table's value.
    const hits = item.qualifiers.map((q) => aliases.get(q)).filter(Boolean)
    const hit = hits[hits.length - 1]
    if (!hit) return null
    if (hit.src) return hit.src
    if (depth > 8) return fromOf(hit.paren)
    const inner = projectionOf(hit.paren).find((x) => x.name && x.name === item.column)
    return (inner && ownerOf(hit.paren, inner, depth + 1)) ?? fromOf(hit.paren)
  }

  const columns = new Map() // source -> names of the columns it supplies
  const star = new Set()
  if (op === 'SELECT') {
    for (const item of projectionOf(null)) {
      if (item.text === '*') {
        for (const src of sources) if (src.how !== 'subquery') star.add(src)
        continue
      }
      const owner = ownerOf(null, item)
      if (!owner) continue
      if (item.star) star.add(owner)
      else {
        if (!columns.has(owner)) columns.set(owner, [])
        columns.get(owner).push(item.column ?? item.name ?? item.text)
      }
    }
  }

  return sources.map((src) => ({
    table: src.table,
    how: src.how,
    columns: src.how === 'subquery' || op !== 'SELECT' ? null : (columns.get(src)?.length ?? 0),
    star: star.has(src),
  }))
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
 * Identity of one execution: what makes this run of the statement different from
 * the next one in the same group.
 *
 * Captured values when there are any. When there are none, the statement text
 * itself - a query whose keys were folded into the SQL as literals normalises to
 * the same shape as its siblings, so an empty signature would make N reads of N
 * different rows look like one row read N times.
 *
 * Returns null for "cannot tell": the statement names parameters but none of
 * their values reached us, so comparing it with another execution proves nothing.
 */
function paramSigOf(stmt, resolved, referencesParams) {
  if (resolved.length) return resolved.map((p) => p.v).join(SEP)
  return referencesParams ? null : stmt
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
    const referencesParams = /@[A-Za-z_]/.test(stmt)
    out.push({
      op,
      text: stmt,
      shape: normalize(stmt),
      table: primaryTable(stmt, op),
      tables: allTables(stmt),
      sources: tableSources(stmt, op),
      width: projectionWidth(stmt, op),
      params: resolved,
      paramSig: paramSigOf(stmt, resolved, referencesParams),
      rowKey: rowKeyOf(stmt, op, resolved, referencesParams),
      setColumns: setColumnsOf(stmt, op),
      hasWhere: /\bWHERE\b/i.test(stmt),
      hasTop: /\b(TOP|OFFSET|FETCH\s+NEXT)\b/i.test(stmt),
    })
  }

  return { statements: out, scaffolding }
}
