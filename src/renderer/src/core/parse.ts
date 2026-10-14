// Pure markdown metadata extraction. No DOM or Electron dependencies so it
// can be unit tested directly with `node --test`.

export interface LinkRef {
  target: string // note path or name without heading/block, e.g. "Folder/Note"
  subpath: string // "#Heading" or "#^block" or ""
  alias: string | null
  embed: boolean
  line: number
  from: number // offset in the document
  to: number
  kind: 'wiki' | 'markdown'
}

export interface HeadingRef {
  level: number
  text: string
  line: number
}

export interface TaskRef {
  line: number
  done: boolean
  text: string
}

export interface NoteMeta {
  links: LinkRef[]
  tags: string[] // without '#', as written (case preserved)
  headings: HeadingRef[]
  tasks: TaskRef[]
  frontmatter: Record<string, unknown> | null
  frontmatterEnd: number // line index after the closing ---, 0 when absent
  aliases: string[]
  words: number
}

const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
// Tags: #tag, #nested/tag, supports unicode letters. Must not be a heading or url anchor.
const TAG_RE = /(^|[\s(\[,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s?(.*)$/
const FENCE_RE = /^\s*(```|~~~)/

export function splitWikiTarget(raw: string): { target: string; subpath: string; alias: string | null } {
  let alias: string | null = null
  let body = raw
  const pipe = body.indexOf('|')
  if (pipe >= 0) {
    alias = body.slice(pipe + 1).trim() || null
    body = body.slice(0, pipe)
  }
  let subpath = ''
  const hash = body.indexOf('#')
  if (hash >= 0) {
    subpath = body.slice(hash).trim()
    body = body.slice(0, hash)
  }
  return { target: body.trim(), subpath, alias }
}

// Minimal YAML subset: scalars, inline [a, b] lists and "- item" lists.
export function parseFrontmatter(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let currentKey: string | null = null
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item && currentKey) {
      const arr = Array.isArray(out[currentKey]) ? (out[currentKey] as unknown[]) : []
      arr.push(scalar(item[1]))
      out[currentKey] = arr
      continue
    }
    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    currentKey = kv[1].trim()
    const value = kv[2].trim()
    if (value === '') out[currentKey] = []
    else if (value.startsWith('[') && value.endsWith(']'))
      out[currentKey] = value
        .slice(1, -1)
        .split(',')
        .map((s) => scalar(s.trim()))
        .filter((s) => s !== '')
    else out[currentKey] = scalar(value)
  }
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v) && v.length === 0) out[k] = null
  return out
}

function scalar(v: string): unknown {
  const s = v.replace(/^(['"])(.*)\1$/, '$2')
  if (s !== v) return s
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

export function frontmatterRange(text: string): { body: string; end: number; endOffset: number } | null {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) {
      const endOffset = lines.slice(0, i + 1).join('\n').length + 1
      return { body: lines.slice(1, i).join('\n'), end: i + 1, endOffset: Math.min(endOffset, text.length) }
    }
  }
  return null
}

export function parseNote(text: string): NoteMeta {
  const meta: NoteMeta = {
    links: [],
    tags: [],
    headings: [],
    tasks: [],
    frontmatter: null,
    frontmatterEnd: 0,
    aliases: [],
    words: 0
  }
  const lines = text.split('\n')
  const fm = frontmatterRange(text)
  let start = 0
  let offset = 0
  if (fm) {
    meta.frontmatter = parseFrontmatter(fm.body)
    meta.frontmatterEnd = fm.end
    start = fm.end
    for (let i = 0; i < fm.end; i++) offset += lines[i].length + 1
    const fmTags = meta.frontmatter.tags ?? meta.frontmatter.tag
    for (const t of toList(fmTags)) meta.tags.push(String(t).replace(/^#/, ''))
    const aliases = meta.frontmatter.aliases ?? meta.frontmatter.alias
    meta.aliases = toList(aliases).map(String)
  }

  let inFence = false
  let fenceMarker = ''
  let inMath = false
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    const lineStart = offset
    offset += line.length + 1

    const fence = FENCE_RE.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
      } else if (fence[1] === fenceMarker) inFence = false
      continue
    }
    if (inFence) continue
    if (line.trim() === '$$') {
      inMath = !inMath
      continue
    }
    if (inMath) continue

    const h = HEADING_RE.exec(line)
    if (h) meta.headings.push({ level: h[1].length, text: h[2], line: i })

    const task = TASK_RE.exec(line)
    if (task) meta.tasks.push({ line: i, done: task[1] !== ' ', text: task[2] })

    // Strip inline code before scanning links/tags.
    const scan = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))

    WIKI_RE.lastIndex = 0
    for (let m; (m = WIKI_RE.exec(scan)); ) {
      const { target, subpath, alias } = splitWikiTarget(m[2])
      meta.links.push({
        target,
        subpath,
        alias,
        embed: m[1] === '!',
        line: i,
        from: lineStart + m.index,
        to: lineStart + m.index + m[0].length,
        kind: 'wiki'
      })
    }
    MD_LINK_RE.lastIndex = 0
    for (let m; (m = MD_LINK_RE.exec(scan)); ) {
      const url = m[3]
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) continue
      let decoded = url
      try {
        decoded = decodeURIComponent(url)
      } catch {}
      const hash = decoded.indexOf('#')
      meta.links.push({
        target: hash >= 0 ? decoded.slice(0, hash) : decoded,
        subpath: hash >= 0 ? decoded.slice(hash) : '',
        alias: m[2] || null,
        embed: m[1] === '!',
        line: i,
        from: lineStart + m.index,
        to: lineStart + m.index + m[0].length,
        kind: 'markdown'
      })
    }

    // Wikilink/markdown link text may contain '#heading'; blank links out first.
    const tagScan = scan.replace(WIKI_RE, (m) => ' '.repeat(m.length)).replace(MD_LINK_RE, (m) => ' '.repeat(m.length))
    TAG_RE.lastIndex = 0
    for (let m; (m = TAG_RE.exec(tagScan)); ) meta.tags.push(m[2])
    meta.words += countWords(line)
  }
  return meta
}

function toList(v: unknown): unknown[] {
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean)
  return [v]
}

export function countWords(s: string): number {
  // CJK characters count individually; everything else by whitespace groups.
  const cjk = s.match(/[぀-ヿ㐀-鿿가-힯]+/g)
  const latin = s.replace(/[぀-ヿ㐀-鿿]+/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)
  let cjkCount = 0
  if (cjk) for (const run of cjk) cjkCount += /[가-힯]/.test(run) ? 0 : run.length
  return cjkCount + (latin ? latin.length : 0)
}

// ---------- link resolution ----------

export function stripExt(p: string): string {
  return p.replace(/\.md$/i, '')
}

export function basenameOf(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1)
  return name
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export function joinPath(...parts: string[]): string {
  const out: string[] = []
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * Resolves a link target to a file path.
 * Order: relative to the source folder, exact vault path, then by file name
 * (preferring the candidate closest to the source, then the shortest path).
 */
export function resolveLink(target: string, sourcePath: string, files: readonly string[]): string | null {
  if (!target) return sourcePath
  const t = target.replace(/^\/+/, '')
  const lower = new Map<string, string>()
  for (const f of files) lower.set(f.toLowerCase(), f)
  const tryPath = (p: string) => lower.get(p.toLowerCase()) ?? lower.get((p + '.md').toLowerCase()) ?? null

  const rel = tryPath(joinPath(dirOf(sourcePath), t))
  if (rel) return rel
  const exact = tryPath(t)
  if (exact) return exact

  const wantName = basenameOf(t).toLowerCase()
  const wantSuffix = t.toLowerCase()
  const candidates = files.filter((f) => {
    const fl = f.toLowerCase()
    const name = basenameOf(fl)
    if (!(name === wantName || stripExt(name) === wantName)) return false
    return fl.endsWith(wantSuffix) || fl.endsWith(wantSuffix + '.md')
  })
  if (candidates.length === 0) return null
  const srcDir = dirOf(sourcePath)
  candidates.sort((a, b) => {
    const da = dirOf(a) === srcDir ? 0 : 1
    const db = dirOf(b) === srcDir ? 0 : 1
    return da - db || a.split('/').length - b.split('/').length || a.length - b.length
  })
  return candidates[0]
}

/** Shortest link text that still resolves uniquely to `path` from anywhere. */
export function linkTextFor(path: string, files: readonly string[]): string {
  const name = stripExt(basenameOf(path))
  const isMd = /\.md$/i.test(path)
  const display = isMd ? name : basenameOf(path)
  const same = files.filter((f) => basenameOf(f).toLowerCase() === basenameOf(path).toLowerCase())
  if (same.length <= 1) return display
  return isMd ? stripExt(path) : path
}

/** Rewrites wikilinks in `text` that resolve to `oldPath`, pointing them at `newPath`. */
export function rewriteLinks(
  text: string,
  sourcePath: string,
  oldPath: string,
  newPath: string,
  filesBefore: readonly string[],
  filesAfter: readonly string[]
): string {
  const newText = linkTextFor(newPath, filesAfter)
  return text.replace(WIKI_RE, (whole, bang: string, inner: string) => {
    const { target, subpath, alias } = splitWikiTarget(inner)
    if (!target) return whole
    if (resolveLink(target, sourcePath, filesBefore) !== oldPath) return whole
    return `${bang}[[${newText}${subpath}${alias ? '|' + alias : ''}]]`
  })
}

// ---------- fuzzy matching ----------

export interface FuzzyResult {
  score: number
  matches: number[]
}

/** Subsequence fuzzy match with bonuses for word starts and consecutive runs. */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { score: 0, matches: [] }
  const t = text.toLowerCase()
  const matches: number[] = []
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const idx = t.indexOf(ch, ti)
    if (idx < 0) return null
    matches.push(idx)
    let s = 1
    if (idx === prev + 1) s += 5
    if (idx === 0 || /[\s/_\-.]/.test(t[idx - 1])) s += 8
    s -= Math.min(idx - ti, 10) * 0.1
    score += s
    prev = idx
    ti = idx + 1
  }
  // Prefer shorter texts and matches in the file name part.
  const slash = t.lastIndexOf('/')
  if (matches[0] > slash) score += 10
  score -= t.length * 0.01
  if (t.includes(query.toLowerCase())) score += 15
  return { score, matches }
}
