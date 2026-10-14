import type { Vault } from './vault'
import { basenameOf } from './parse'

export interface SearchMatch {
  line: number
  text: string
  ranges: [number, number][]
}

export interface SearchResult {
  path: string
  matches: SearchMatch[]
}

interface Term {
  kind: 'text' | 'tag' | 'path' | 'file' | 'regex' | 'task' | 'task-todo' | 'task-done'
  value: string
  negate: boolean
  re?: RegExp
}

/** Parses: words, "phrases", tag:#x, path:x, file:x, /regex/, task:, task-todo:, task-done:, -negation. */
export function parseQuery(q: string, matchCase: boolean): Term[] {
  const terms: Term[] = []
  const re = /(-?)(?:(tag|path|file|task|task-todo|task-done):)?(?:"([^"]*)"|\/((?:\\\/|[^/])+)\/|(\S+))/g
  for (let m; (m = re.exec(q)); ) {
    const negate = m[1] === '-'
    const op = m[2] as Term['kind'] | undefined
    const value = m[3] ?? m[4] ?? m[5] ?? ''
    if (m[4] !== undefined && !op) {
      try {
        terms.push({ kind: 'regex', value, negate, re: new RegExp(value, matchCase ? 'g' : 'gi') })
      } catch {
        /* invalid regex: ignore term */
      }
      continue
    }
    if (op && !value && !op.startsWith('task')) continue
    terms.push({ kind: op ?? 'text', value: op === 'tag' ? value.replace(/^#/, '') : value, negate })
  }
  return terms
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function search(vault: Vault, query: string, matchCase = false): SearchResult[] {
  const terms = parseQuery(query, matchCase)
  if (!terms.length) return []
  const norm = (s: string) => (matchCase ? s : s.toLowerCase())
  const results: SearchResult[] = []

  for (const path of vault.notes()) {
    const text = vault.text(path) ?? ''
    const meta = vault.meta(path)
    const lines = text.split('\n')
    const ranges = new Map<number, [number, number][]>()
    let ok = true

    for (const t of terms) {
      let hit = false
      const addLine = (line: number, r: [number, number][]) => {
        if (t.negate) return
        const list = ranges.get(line) ?? []
        list.push(...r)
        ranges.set(line, list)
      }
      switch (t.kind) {
        case 'tag': {
          const want = t.value.toLowerCase()
          hit = !!meta?.tags.some((x) => x.toLowerCase() === want || x.toLowerCase().startsWith(want + '/'))
          if (hit) {
            const re = new RegExp(`#${escapeRe(t.value)}(?![\\p{L}\\p{N}_\\-])`, 'giu')
            lines.forEach((l, i) => {
              const r: [number, number][] = []
              for (const m of l.matchAll(re)) r.push([m.index!, m.index! + m[0].length])
              if (r.length) addLine(i, r)
            })
          }
          break
        }
        case 'path':
          hit = norm(path).includes(norm(t.value))
          break
        case 'file':
          hit = norm(basenameOf(path)).includes(norm(t.value))
          break
        case 'task':
        case 'task-todo':
        case 'task-done': {
          const tasks = (meta?.tasks ?? []).filter((x) => (t.kind === 'task' ? true : t.kind === 'task-done' ? x.done : !x.done))
          for (const task of tasks) {
            if (t.value && !norm(task.text).includes(norm(t.value))) continue
            hit = true
            addLine(task.line, [])
          }
          break
        }
        case 'regex': {
          lines.forEach((l, i) => {
            t.re!.lastIndex = 0
            const r: [number, number][] = []
            for (const m of l.matchAll(t.re!)) if (m[0]) r.push([m.index!, m.index! + m[0].length])
            if (r.length) {
              hit = true
              addLine(i, r)
            }
          })
          break
        }
        default: {
          const needle = norm(t.value)
          if (norm(basenameOf(path)).includes(needle)) hit = true
          lines.forEach((l, i) => {
            const hay = norm(l)
            const r: [number, number][] = []
            for (let idx = hay.indexOf(needle); idx >= 0 && needle; idx = hay.indexOf(needle, idx + needle.length)) r.push([idx, idx + needle.length])
            if (r.length) {
              hit = true
              addLine(i, r)
            }
          })
        }
      }
      if (hit === t.negate) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const matches = [...ranges.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([line, r]) => {
        const full = lines[line]
        // Trim long lines around the first match.
        const sorted: [number, number][] = []
        for (const cur of r.sort((a, b) => a[0] - b[0])) {
          const last = sorted[sorted.length - 1]
          if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1])
          else sorted.push([cur[0], cur[1]])
        }
        const start = Math.max(0, (sorted[0]?.[0] ?? 0) - 60)
        const text = (start > 0 ? '…' : '') + full.slice(start, start + 220)
        const shift = start > 0 ? 1 - start : 0
        return {
          line,
          text,
          ranges: sorted.map(([a, b]) => [a + shift, b + shift] as [number, number]).filter(([a, b]) => a >= 0 && b <= text.length)
        }
      })
    results.push({ path, matches })
  }
  results.sort((a, b) => b.matches.length - a.matches.length || a.path.localeCompare(b.path))
  return results
}
