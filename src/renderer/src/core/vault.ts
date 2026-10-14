import type { FileEntry, FsChange } from '../../../shared/api'
import { Emitter } from './events'
import {
  parseNote,
  resolveLink,
  rewriteLinks,
  basenameOf,
  dirOf,
  joinPath,
  stripExt,
  type NoteMeta
} from './parse'

export interface Backlink {
  source: string
  line: number
  context: string
}

type VaultEvents = {
  // File tree changed (create, delete, rename).
  structure: void
  // A note's content changed (from us or from disk).
  modify: { path: string; external: boolean }
  rename: { from: string; to: string }
  delete: string
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
export const isMarkdown = (p: string) => /\.md$/i.test(p)

export class Vault extends Emitter<VaultEvents> {
  files = new Map<string, FileEntry>()
  private texts = new Map<string, string>()
  private metas = new Map<string, NoteMeta>()
  private pathList: string[] | null = null
  // Content we wrote ourselves, used to ignore the watcher echo.
  private ownWrites = new Map<string, string>()

  constructor(public name: string, public root: string) {
    super()
  }

  async load() {
    const entries = await window.jj.list()
    this.files = new Map(entries.map((e) => [e.path, e]))
    this.pathList = null
    const md = entries.filter((e) => e.type === 'file' && isMarkdown(e.path))
    for (let i = 0; i < md.length; i += 48) {
      await Promise.all(
        md.slice(i, i + 48).map(async (e) => {
          try {
            this.setText(e.path, await window.jj.read(e.path))
          } catch (err) {
            console.warn('read failed', e.path, err)
          }
        })
      )
    }
    this.emit('structure', undefined)
  }

  // ---------- queries ----------
  paths(): string[] {
    if (!this.pathList) this.pathList = [...this.files.values()].filter((f) => f.type === 'file').map((f) => f.path)
    return this.pathList
  }

  notes(): string[] {
    return this.paths().filter(isMarkdown)
  }

  folders(): string[] {
    return [...this.files.values()].filter((f) => f.type === 'folder').map((f) => f.path)
  }

  exists(path: string) {
    return this.files.has(path)
  }

  isFolder(path: string) {
    return this.files.get(path)?.type === 'folder'
  }

  text(path: string): string | undefined {
    return this.texts.get(path)
  }

  meta(path: string): NoteMeta | undefined {
    return this.metas.get(path)
  }

  async read(path: string): Promise<string> {
    const cached = this.texts.get(path)
    if (cached !== undefined) return cached
    const text = await window.jj.read(path)
    if (isMarkdown(path)) this.setText(path, text)
    return text
  }

  resolve(target: string, source: string): string | null {
    return resolveLink(target, source, this.paths())
  }

  /** Display name used in tabs/links: file name without .md */
  static title(path: string) {
    return isMarkdown(path) ? stripExt(basenameOf(path)) : basenameOf(path)
  }

  backlinks(path: string): Backlink[] {
    const out: Backlink[] = []
    for (const [source, meta] of this.metas) {
      if (source === path) continue
      const lines = this.texts.get(source)?.split('\n') ?? []
      for (const link of meta.links) {
        if (this.resolve(link.target, source) === path) out.push({ source, line: link.line, context: lines[link.line] ?? '' })
      }
    }
    return out
  }

  /** Lines in other notes that mention the title without linking it. */
  unlinkedMentions(path: string): Backlink[] {
    const title = Vault.title(path)
    if (title.length < 2) return []
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')
    const out: Backlink[] = []
    for (const [source, text] of this.texts) {
      if (source === path) continue
      text.split('\n').forEach((line, i) => {
        const stripped = line.replace(/!?\[\[[^\]]*\]\]/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '')
        if (re.test(stripped)) out.push({ source, line: i, context: line })
      })
    }
    return out
  }

  outgoing(path: string): { target: string; resolved: string | null; line: number }[] {
    const meta = this.metas.get(path)
    if (!meta) return []
    return meta.links.map((l) => ({ target: l.target || Vault.title(path), resolved: this.resolve(l.target, path), line: l.line }))
  }

  tags(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const meta of this.metas.values()) {
      for (const t of new Set(meta.tags.map((t) => t.toLowerCase()))) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return counts
  }

  /** All note links as resolved edges plus unresolved targets, for the graph. */
  graph(): { nodes: { id: string; resolved: boolean; tags: string[] }[]; links: { source: string; target: string }[] } {
    const nodes = new Map<string, { id: string; resolved: boolean; tags: string[] }>()
    const links: { source: string; target: string }[] = []
    for (const p of this.notes()) nodes.set(p, { id: p, resolved: true, tags: this.metas.get(p)?.tags ?? [] })
    for (const [source, meta] of this.metas) {
      for (const l of meta.links) {
        if (!l.target) continue
        const resolved = this.resolve(l.target, source)
        const id = resolved ?? `unresolved:${l.target}`
        if (!nodes.has(id)) nodes.set(id, { id, resolved: !!resolved, tags: [] })
        if (id !== source) links.push({ source, target: id })
      }
    }
    return { nodes: [...nodes.values()], links }
  }

  // ---------- mutations ----------
  private setText(path: string, text: string) {
    this.texts.set(path, text)
    this.metas.set(path, parseNote(text))
  }

  private addEntry(path: string, type: 'file' | 'folder') {
    // Ensure parent folders exist in the index.
    let dir = dirOf(path)
    while (dir && !this.files.has(dir)) {
      this.files.set(dir, { path: dir, type: 'folder', mtime: Date.now(), size: 0 })
      dir = dirOf(dir)
    }
    this.files.set(path, { path, type, mtime: Date.now(), size: 0 })
    this.pathList = null
  }

  async write(path: string, text: string) {
    const isNew = !this.files.has(path)
    this.ownWrites.set(path, text)
    if (isMarkdown(path)) this.setText(path, text)
    await window.jj.write(path, text)
    if (isNew) {
      this.addEntry(path, 'file')
      this.emit('structure', undefined)
    }
    this.emit('modify', { path, external: false })
  }

  async writeBinary(path: string, data: ArrayBuffer) {
    await window.jj.writeBinary(path, data)
    this.addEntry(path, 'file')
    this.emit('structure', undefined)
  }

  /** Returns a path that does not exist yet: "Untitled.md", "Untitled 1.md", ... */
  availablePath(folder: string, base: string, ext = '.md'): string {
    let candidate = joinPath(folder, base + ext)
    for (let i = 1; this.files.has(candidate); i++) candidate = joinPath(folder, `${base} ${i}${ext}`)
    return candidate
  }

  async createNote(folder: string, base = 'Untitled', content = ''): Promise<string> {
    const path = this.availablePath(folder, base)
    await this.write(path, content)
    return path
  }

  async createFolder(parent: string, base = 'Untitled'): Promise<string> {
    const path = this.availablePath(parent, base, '')
    await window.jj.mkdir(path)
    this.addEntry(path, 'folder')
    this.emit('structure', undefined)
    return path
  }

  /** Renames/moves a file or folder and updates every wikilink pointing into it. */
  async rename(from: string, to: string) {
    if (from === to) return
    const before = this.paths().slice()
    const moved: [string, string][] = []
    if (this.isFolder(from)) {
      for (const p of [...this.files.keys()]) if (p === from || p.startsWith(from + '/')) moved.push([p, to + p.slice(from.length)])
    } else moved.push([from, to])

    await window.jj.rename(from, to)

    for (const [a, b] of moved) {
      const entry = this.files.get(a)!
      this.files.delete(a)
      this.files.set(b, { ...entry, path: b })
      const text = this.texts.get(a)
      if (text !== undefined) {
        this.texts.delete(a)
        this.metas.delete(a)
        this.setText(b, text)
      }
    }
    this.addEntry(to, this.files.get(to)!.type)
    const after = this.paths().slice()

    // Rewrite links in every note that pointed at a moved file.
    const movedFiles = moved.filter(([a]) => before.includes(a))
    for (const note of this.notes()) {
      const original = this.texts.get(note)!
      // The note itself may have moved; resolve its links from its old location.
      const oldSource = moved.find(([, b]) => b === note)?.[0] ?? note
      let text = original
      for (const [a, b] of movedFiles) {
        if (!this.metas.get(note)?.links.length) break
        text = rewriteLinks(text, oldSource, a, b, before, after)
      }
      if (text !== original) await this.write(note, text)
    }

    for (const [a, b] of moved) this.emit('rename', { from: a, to: b })
    this.emit('structure', undefined)
  }

  async trash(path: string) {
    await window.jj.trash(path)
    for (const p of [...this.files.keys()]) {
      if (p === path || p.startsWith(path + '/')) {
        this.files.delete(p)
        this.texts.delete(p)
        this.metas.delete(p)
        this.emit('delete', p)
      }
    }
    this.pathList = null
    this.emit('structure', undefined)
  }

  // ---------- external changes ----------
  async handleFsChanges(changes: FsChange[]) {
    const entries = await window.jj.list()
    const next = new Map(entries.map((e) => [e.path, e]))
    let structural = false

    for (const p of this.files.keys()) {
      if (!next.has(p)) {
        structural = true
        this.texts.delete(p)
        this.metas.delete(p)
        this.emit('delete', p)
      }
    }
    const touched = new Set(changes.map((c) => c.path))
    for (const [p, e] of next) {
      const prev = this.files.get(p)
      if (!prev) structural = true
      if (e.type !== 'file' || !isMarkdown(p)) continue
      if (!prev || prev.mtime !== e.mtime || touched.has(p)) {
        try {
          const text = await window.jj.read(p)
          const own = this.ownWrites.get(p)
          if (own === text) {
            this.ownWrites.delete(p)
            continue
          }
          if (this.texts.get(p) === text) continue
          this.setText(p, text)
          if (prev) this.emit('modify', { path: p, external: true })
        } catch {
          /* file vanished between list and read */
        }
      }
    }
    this.files = next
    this.pathList = null
    if (structural) this.emit('structure', undefined)
  }
}
