import { h, icon, iconButton, clear } from './dom'
import { showMenu } from './menu'
import type { Panel } from './sidebar'
import type { App } from '../app'
import { Vault, isMarkdown, IMAGE_EXT } from '../core/vault'
import { basenameOf, dirOf, joinPath } from '../core/parse'
import { debounce } from '../core/events'
import { GraphRenderer, DEFAULT_GRAPH } from '../views/graph'
import { search, type SearchResult } from '../core/search'

// ---------- File explorer ----------

export class ExplorerPanel implements Panel {
  id = 'explorer'
  title = 'Files'
  icon = 'files'
  el = h('div', { class: 'nav-files-container' })
  private collapsed = new Set<string>()
  private sortDesc = false
  actions: HTMLElement[]

  constructor(private app: App) {
    this.actions = [
      iconButton('file-plus', 'New note', () => app.commands.run('new-note')),
      iconButton('folder-plus', 'New folder', () => this.newFolder('')),
      iconButton('collapse', 'Collapse all', () => {
        for (const f of app.vault.folders()) this.collapsed.add(f)
        this.refresh()
      })
    ]
    this.el.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.nav-item')) return
      e.preventDefault()
      showMenu(e, [
        { title: 'New note', icon: 'file-plus', onClick: () => app.newNote('') },
        { title: 'New folder', icon: 'folder-plus', onClick: () => this.newFolder('') }
      ])
    })
    // Dropping on the empty area moves to the vault root.
    this.el.addEventListener('dragover', (e) => e.preventDefault())
    this.el.addEventListener('drop', (e) => {
      if ((e.target as HTMLElement).closest('.nav-folder-title')) return
      e.preventDefault()
      const from = e.dataTransfer?.getData('application/x-jjnote-path')
      if (from && dirOf(from) !== '') void app.movePath(from, basenameOf(from))
    })
    this.sortDesc = false
  }

  reveal(path: string) {
    let dir = dirOf(path)
    while (dir) {
      this.collapsed.delete(dir)
      dir = dirOf(dir)
    }
    this.refresh()
    const el = this.el.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    el?.scrollIntoView({ block: 'center' })
  }

  refresh() {
    const active = this.app.activePath()
    const tree = new Map<string, string[]>()
    for (const f of this.app.vault.files.values()) {
      const parent = dirOf(f.path)
      if (!tree.has(parent)) tree.set(parent, [])
      tree.get(parent)!.push(f.path)
    }
    const sort = (items: string[]) =>
      items.sort((a, b) => {
        const fa = this.app.vault.isFolder(a) ? 0 : 1
        const fb = this.app.vault.isFolder(b) ? 0 : 1
        const cmp = basenameOf(a).localeCompare(basenameOf(b), undefined, { numeric: true, sensitivity: 'base' })
        return fa - fb || (this.sortDesc ? -cmp : cmp)
      })
    const renderLevel = (dir: string, depth: number): HTMLElement => {
      const box = h('div', { class: 'nav-folder-children' })
      for (const path of sort(tree.get(dir) ?? [])) {
        const isFolder = this.app.vault.isFolder(path)
        const title = isFolder ? basenameOf(path) : Vault.title(path)
        const row = h(
          'div',
          {
            class: `nav-item ${isFolder ? 'nav-folder-title' : 'nav-file-title'}${path === active ? ' is-active' : ''}`,
            style: `padding-left: ${8 + depth * 16}px`,
            draggable: 'true',
            dataset: { path }
          },
          isFolder ? icon(this.collapsed.has(path) ? 'chevron-right' : 'chevron-down', 14) : h('span', { class: 'nav-file-spacer' }),
          h('span', { class: 'nav-item-title' }, title),
          !isFolder && !isMarkdown(path) ? h('span', { class: 'nav-file-tag' }, (/\.([^.]+)$/.exec(path)?.[1] ?? '').toUpperCase()) : null
        )
        row.addEventListener('click', (e) => {
          if (isFolder) {
            if (this.collapsed.has(path)) this.collapsed.delete(path)
            else this.collapsed.add(path)
            this.refresh()
          } else this.app.openFile(path, { newTab: e.metaKey || e.ctrlKey })
        })
        row.addEventListener('auxclick', (e) => {
          if (e.button === 1 && !isFolder) this.app.openFile(path, { newTab: true })
        })
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          e.stopPropagation()
          this.contextMenu(e, path, isFolder)
        })
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer!.setData('application/x-jjnote-path', path)
          e.dataTransfer!.setData('text/plain', `[[${Vault.title(path)}]]`)
          e.dataTransfer!.effectAllowed = 'copyMove'
        })
        if (isFolder) {
          row.addEventListener('dragover', (e) => {
            e.preventDefault()
            row.classList.add('is-drop-target')
          })
          row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'))
          row.addEventListener('drop', (e) => {
            e.preventDefault()
            e.stopPropagation()
            row.classList.remove('is-drop-target')
            const from = e.dataTransfer?.getData('application/x-jjnote-path')
            if (!from || from === path || path.startsWith(from + '/') || dirOf(from) === path) return
            void this.app.movePath(from, joinPath(path, basenameOf(from)))
          })
        }
        box.append(row)
        if (isFolder && !this.collapsed.has(path)) box.append(renderLevel(path, depth + 1))
      }
      return box
    }
    clear(this.el)
    this.el.append(renderLevel('', 0))
  }

  private contextMenu(e: MouseEvent, path: string, isFolder: boolean) {
    const app = this.app
    const items = isFolder
      ? [
          { title: 'New note', icon: 'file-plus', onClick: () => app.newNote(path) },
          { title: 'New folder', icon: 'folder-plus', onClick: () => this.newFolder(path) },
          null
        ]
      : [
          { title: 'Open in new tab', icon: 'plus', onClick: () => app.openFile(path, { newTab: true }) },
          { title: 'Open to the right', icon: 'split', onClick: () => app.openFile(path, { split: true }) },
          null
        ]
    showMenu(e, [
      ...items,
      ...(!isFolder && isMarkdown(path)
        ? [{ title: app.settings.bookmarks.includes(path) ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', onClick: () => app.toggleBookmark(path) }]
        : []),
      { title: 'Make a copy', icon: 'files', onClick: () => app.duplicate(path), ...(isFolder ? { title: '' } : {}) },
      { title: 'Rename…', icon: 'edit', onClick: () => app.renamePrompt(path) },
      { title: 'Move to…', icon: 'folder-open', onClick: () => app.moveTo(path) },
      { title: 'Reveal in system explorer', icon: 'folder-open', onClick: () => window.jj.reveal(path) },
      null,
      { title: 'Delete', icon: 'trash', danger: true, onClick: () => app.deletePath(path) }
    ].filter((i) => !i || i.title))
  }

  private async newFolder(parent: string) {
    const path = await this.app.vault.createFolder(parent)
    this.collapsed.delete(parent)
    this.refresh()
    await this.app.renamePrompt(path)
  }
}

// ---------- Search ----------

export class SearchPanel implements Panel {
  id = 'search'
  title = 'Search'
  icon = 'search'
  el = h('div', { class: 'search-panel' })
  input = h('input', { type: 'search', class: 'search-input', placeholder: 'Search… (tag:#x path:dir file:name "phrase" -exclude)', spellcheck: false })
  private caseBox = h('input', { type: 'checkbox' })
  private summary = h('div', { class: 'search-summary' })
  private results = h('div', { class: 'search-results' })
  private run = debounce(() => this.execute(), 200)

  constructor(private app: App) {
    this.input.addEventListener('input', () => this.run())
    this.caseBox.addEventListener('change', () => this.execute())
    this.el.append(this.input, h('label', { class: 'search-option' }, this.caseBox, 'Match case'), this.summary, this.results)
  }

  setQuery(q: string) {
    this.input.value = q
    this.execute()
    this.input.focus()
  }

  refresh() {
    if (this.input.value) this.execute()
  }

  private execute() {
    const q = this.input.value.trim()
    clear(this.results)
    if (!q) {
      this.summary.textContent = ''
      return
    }
    const results = search(this.app.vault, q, this.caseBox.checked)
    const total = results.reduce((n, r) => n + Math.max(1, r.matches.length), 0)
    this.summary.textContent = `${results.length} files · ${total} results`
    for (const r of results.slice(0, 300)) this.results.append(this.renderResult(r))
  }

  private renderResult(r: SearchResult) {
    const item = h('div', { class: 'search-result' })
    const title = h(
      'div',
      { class: 'search-result-file-title', onclick: (e: MouseEvent) => this.app.openFile(r.path, { newTab: e.metaKey || e.ctrlKey }) },
      h('span', {}, Vault.title(r.path)),
      h('span', { class: 'search-result-count' }, String(r.matches.length || ''))
    )
    item.append(title)
    for (const m of r.matches.slice(0, 8)) {
      const line = h('div', { class: 'search-result-match', onclick: () => this.app.openFile(r.path, { line: m.line }) })
      const text = m.text
      let pos = 0
      for (const [s, e] of m.ranges) {
        line.append(text.slice(pos, s), h('mark', {}, text.slice(s, e)))
        pos = e
      }
      line.append(text.slice(pos))
      item.append(line)
    }
    return item
  }
}

// ---------- Tags ----------

export class TagsPanel implements Panel {
  id = 'tags'
  title = 'Tags'
  icon = 'tags'
  el = h('div', { class: 'tag-pane' })
  constructor(private app: App) {}
  refresh() {
    clear(this.el)
    const tags = [...this.app.vault.tags().entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (!tags.length) this.el.append(h('div', { class: 'pane-empty' }, 'No tags yet. Add #tags to your notes.'))
    for (const [tag, count] of tags) {
      this.el.append(
        h(
          'div',
          { class: 'tag-pane-tag', onclick: () => this.app.searchFor(`tag:#${tag}`) },
          h('span', { class: 'tag-pane-tag-text' }, '#' + tag),
          h('span', { class: 'tag-pane-tag-count' }, String(count))
        )
      )
    }
  }
}

// ---------- Bookmarks ----------

export class BookmarksPanel implements Panel {
  id = 'bookmarks'
  title = 'Bookmarks'
  icon = 'bookmark'
  el = h('div', { class: 'bookmarks-pane' })
  constructor(private app: App) {}
  refresh() {
    clear(this.el)
    const list = this.app.settings.bookmarks.filter((p) => this.app.vault.exists(p))
    if (!list.length) this.el.append(h('div', { class: 'pane-empty' }, 'No bookmarks. Use "Bookmark" from a note\'s menu.'))
    for (const p of list) {
      const row = h('div', { class: 'nav-item nav-file-title', onclick: (e: MouseEvent) => this.app.openFile(p, { newTab: e.metaKey || e.ctrlKey }) }, icon('bookmark', 14), h('span', { class: 'nav-item-title' }, Vault.title(p)))
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        showMenu(e, [{ title: 'Remove bookmark', icon: 'x', onClick: () => this.app.toggleBookmark(p) }])
      })
      this.el.append(row)
    }
  }
}

// ---------- Backlinks ----------

export class BacklinksPanel implements Panel {
  id = 'backlinks'
  title = 'Backlinks'
  icon = 'link'
  el = h('div', { class: 'backlink-pane' })
  constructor(private app: App) {}

  refresh() {
    clear(this.el)
    const path = this.app.activePath()
    if (!path || !isMarkdown(path)) {
      this.el.append(h('div', { class: 'pane-empty' }, 'No note is active.'))
      return
    }
    const linked = this.app.vault.backlinks(path)
    const unlinked = this.app.vault.unlinkedMentions(path)
    this.el.append(this.section('Linked mentions', linked, path, false), this.section('Unlinked mentions', unlinked, path, true))
  }

  private section(title: string, items: { source: string; line: number; context: string }[], target: string, unlinked: boolean) {
    const box = h('div', { class: 'backlink-section' }, h('div', { class: 'tree-item-header' }, title, h('span', { class: 'tree-item-count' }, String(items.length))))
    const bySource = new Map<string, typeof items>()
    for (const i of items) {
      if (!bySource.has(i.source)) bySource.set(i.source, [])
      bySource.get(i.source)!.push(i)
    }
    if (!items.length) box.append(h('div', { class: 'pane-empty' }, unlinked ? 'No unlinked mentions found.' : 'No backlinks found.'))
    for (const [source, list] of bySource) {
      box.append(h('div', { class: 'search-result-file-title', onclick: (e: MouseEvent) => this.app.openFile(source, { newTab: e.metaKey || e.ctrlKey }) }, Vault.title(source)))
      for (const it of list) {
        const row = h('div', { class: 'search-result-match', onclick: () => this.app.openFile(source, { line: it.line }) }, it.context.trim())
        if (unlinked) {
          row.append(
            h(
              'button',
              {
                class: 'link-button',
                onclick: (e: MouseEvent) => {
                  e.stopPropagation()
                  void this.app.linkMention(source, it.line, target)
                }
              },
              'Link'
            )
          )
        }
        box.append(row)
      }
    }
    return box
  }
}

// ---------- Outgoing links ----------

export class OutgoingPanel implements Panel {
  id = 'outgoing'
  title = 'Outgoing links'
  icon = 'link-off'
  el = h('div', { class: 'outgoing-pane' })
  constructor(private app: App) {}
  refresh() {
    clear(this.el)
    const path = this.app.activePath()
    if (!path || !isMarkdown(path)) {
      this.el.append(h('div', { class: 'pane-empty' }, 'No note is active.'))
      return
    }
    const links = this.app.vault.outgoing(path)
    const seen = new Set<string>()
    const resolved = links.filter((l) => l.resolved && !seen.has(l.resolved) && seen.add(l.resolved))
    const unresolved = links.filter((l) => !l.resolved && !seen.has('?' + l.target) && seen.add('?' + l.target))
    this.el.append(h('div', { class: 'tree-item-header' }, 'Links', h('span', { class: 'tree-item-count' }, String(resolved.length))))
    for (const l of resolved)
      this.el.append(h('div', { class: 'nav-item nav-file-title', onclick: (e: MouseEvent) => this.app.openFile(l.resolved!, { newTab: e.metaKey || e.ctrlKey }) }, icon(IMAGE_EXT.test(l.resolved!) ? 'image' : 'file', 14), h('span', { class: 'nav-item-title' }, Vault.title(l.resolved!))))
    this.el.append(h('div', { class: 'tree-item-header' }, 'Unresolved', h('span', { class: 'tree-item-count' }, String(unresolved.length))))
    for (const l of unresolved)
      this.el.append(h('div', { class: 'nav-item nav-file-title is-unresolved', onclick: () => this.app.openLink(l.target, path, '', false) }, icon('file-plus', 14), h('span', { class: 'nav-item-title' }, l.target)))
  }
}

// ---------- Outline ----------

export class OutlinePanel implements Panel {
  id = 'outline'
  title = 'Outline'
  icon = 'outline'
  el = h('div', { class: 'outline-pane' })
  constructor(private app: App) {}
  refresh() {
    clear(this.el)
    const path = this.app.activePath()
    const meta = path ? this.app.vault.meta(path) : undefined
    if (!meta || !meta.headings.length) {
      this.el.append(h('div', { class: 'pane-empty' }, 'No headings in this note.'))
      return
    }
    const min = Math.min(...meta.headings.map((x) => x.level))
    for (const hd of meta.headings) {
      this.el.append(
        h(
          'div',
          { class: `outline-item outline-h${hd.level}`, style: `padding-left: ${8 + (hd.level - min) * 14}px`, onclick: () => this.app.openFile(path!, { line: hd.line }) },
          hd.text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
        )
      )
    }
  }
}

// ---------- Local graph ----------

export class LocalGraphPanel implements Panel {
  id = 'local-graph'
  title = 'Local graph'
  icon = 'graph'
  el = h('div', { class: 'local-graph-pane' })
  private renderer: GraphRenderer
  constructor(private app: App) {
    this.renderer = new GraphRenderer(app, { ...DEFAULT_GRAPH, depth: 1 }, () => this.app.activePath() ?? null)
    this.el.append(this.renderer.canvas)
  }
  refresh() {
    requestAnimationFrame(() => this.renderer.rebuild())
  }
}
