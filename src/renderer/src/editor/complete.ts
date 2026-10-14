import type { CompletionContext, CompletionResult, Completion, CompletionSource } from '@codemirror/autocomplete'
import { fuzzyMatch, linkTextFor } from '../core/parse'
import { Vault, isMarkdown } from '../core/vault'

/** `[[` file/heading/alias completion and `#` tag completion. */
export function vaultCompletions(vault: () => Vault, sourcePath: () => string): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const v = vault()
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2)
    const closing = after === ']]' ? '' : ']]'

    const heading = /\[\[([^\[\]|#]+)#([^\[\]|#]*)$/.exec(before)
    if (heading) {
      const resolved = v.resolve(heading[1], sourcePath())
      const headings = resolved ? (v.meta(resolved)?.headings ?? []) : []
      return {
        from: ctx.pos - heading[2].length,
        options: headings.map((h) => ({ label: h.text, type: 'text', detail: 'H' + h.level, apply: h.text + closing })),
        validFor: /^[^\[\]|#]*$/
      }
    }

    const link = /\[\[([^\[\]|#]*)$/.exec(before)
    if (link) {
      const query = link[1]
      const files = v.paths()
      const options: (Completion & { score: number })[] = []
      for (const path of files) {
        const label = isMarkdown(path) ? path.replace(/\.md$/i, '') : path
        const m = fuzzyMatch(query, label)
        if (!m) continue
        const text = linkTextFor(path, files)
        options.push({ label: Vault.title(path), detail: path.includes('/') ? path : undefined, apply: text + closing, type: isMarkdown(path) ? 'file' : 'image', score: m.score })
        for (const alias of v.meta(path)?.aliases ?? []) {
          const am = fuzzyMatch(query, alias)
          if (am) options.push({ label: alias, detail: `→ ${Vault.title(path)}`, apply: `${text}|${alias}${closing}`, type: 'alias', score: am.score - 1 })
        }
      }
      if (query && !options.some((o) => o.label.toLowerCase() === query.toLowerCase()))
        options.push({ label: query, detail: 'Create link to new note', apply: query + closing, type: 'new', score: -1000 })
      options.sort((a, b) => b.score - a.score)
      return { from: ctx.pos - query.length, options: options.slice(0, 80), filter: false }
    }

    const tag = /(^|[\s(\[,;])#([\p{L}\p{N}_\-/]*)$/u.exec(before)
    if (tag && (tag[2].length > 0 || ctx.explicit)) {
      if (/^#{1,6}$/.test(before.trim())) return null
      const options = [...v.tags().entries()].map(([t, n]) => ({ label: '#' + t, detail: String(n), type: 'keyword' }))
      return { from: ctx.pos - tag[2].length - 1, options, validFor: /^#[\p{L}\p{N}_\-/]*$/u }
    }
    return null
  }
}
