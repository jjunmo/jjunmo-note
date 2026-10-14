import { Vault, isMarkdown } from './core/vault'
import { CommandRegistry } from './core/commands'
import { debounce } from './core/events'
import { loadSettings, saveSettings, loadJson, formatDate, WORKSPACE_PATH, type Settings } from './core/settings'
import { basenameOf, dirOf, joinPath, linkTextFor } from './core/parse'
import { Workspace, type Leaf } from './ui/workspace'
import { Sidebar } from './ui/sidebar'
import { h, iconButton, isMac } from './ui/dom'
import { ListSuggest, SuggestModal, prompt, confirm, notice, type SuggestItem } from './ui/modal'
import { SettingsModal } from './ui/settingsModal'
import {
  ExplorerPanel,
  SearchPanel,
  TagsPanel,
  BookmarksPanel,
  BacklinksPanel,
  OutgoingPanel,
  OutlinePanel,
  LocalGraphPanel
} from './ui/panels'
import { MarkdownView } from './views/markdownView'
import { EmptyView, FileView, GraphView } from './views/otherViews'
import type { Command } from './core/commands'

export class App {
  commands = new CommandRegistry()
  workspace: Workspace
  left = new Sidebar('left')
  right = new Sidebar('right')
  explorer: ExplorerPanel
  searchPanel: SearchPanel
  private statusEl = h('div', { class: 'status-bar' })
  private saveWorkspace = debounce(() => this.persistWorkspace(), 800)

  constructor(
    public vault: Vault,
    public settings: Settings
  ) {
    this.workspace = new Workspace(this)
    this.workspace.register('markdown', (app, leaf) => new MarkdownView(app, leaf))
    this.workspace.register('graph', (app, leaf) => new GraphView(app, leaf))
    this.workspace.register('file', (app, leaf) => new FileView(app, leaf))
    this.workspace.register('empty', (app, leaf) => new EmptyView(app, leaf))

    this.explorer = new ExplorerPanel(this)
    this.searchPanel = new SearchPanel(this)
    this.left.add(this.explorer)
    this.left.add(this.searchPanel)
    this.left.add(new BookmarksPanel(this))
    this.left.add(new TagsPanel(this))
    this.left.show('explorer')
    this.right.add(new BacklinksPanel(this))
    this.right.add(new OutgoingPanel(this))
    this.right.add(new OutlinePanel(this))
    this.right.add(new LocalGraphPanel(this))
    this.right.show('backlinks')

    this.registerCommands()
  }

  static async boot(root: HTMLElement, vaultPath: string) {
    const info = await window.jj.openVault(vaultPath)
    localStorage.setItem('lastVault', info.path)
    const vault = new Vault(info.name, info.path)
    await vault.load()
    const settings = await loadSettings()
    const app = new App(vault, settings)
    app.mount(root)
    await app.workspace.restore(await loadJson(WORKSPACE_PATH, null as any))
    app.applySettings()
    return app
  }

  private mount(root: HTMLElement) {
    const ribbon = h(
      'div',
      { class: 'ribbon' },
      iconButton('panel-left', 'Toggle left sidebar', () => this.commands.run('toggle-left')),
      iconButton('file-plus', 'New note', () => this.commands.run('new-note')),
      iconButton('search', 'Search', () => this.commands.run('search')),
      iconButton('graph', 'Open graph view', () => this.commands.run('graph')),
      iconButton('calendar', "Open today's daily note", () => this.commands.run('daily-note')),
      iconButton('template', 'Insert template', () => this.commands.run('insert-template')),
      iconButton('random', 'Open random note', () => this.commands.run('random-note')),
      iconButton('command', 'Command palette', () => this.commands.run('command-palette')),
      h('div', { class: 'ribbon-spacer' }),
      iconButton('folder-open', 'Open another vault', () => this.commands.run('switch-vault')),
      iconButton('settings', 'Settings', () => this.commands.run('settings'))
    )
    const center = h('div', { class: 'workspace-root' }, this.workspace.el)
    const rightToggle = iconButton('panel-right', 'Toggle right sidebar', () => this.commands.run('toggle-right'), 'right-sidebar-toggle')
    root.replaceChildren(h('div', { class: 'app-container' }, ribbon, this.left.el, center, this.right.el, rightToggle), this.statusEl)

    window.addEventListener('keydown', (e) => this.commands.handleKey(e, isMac()), true)

    const refreshPanels = debounce(() => {
      this.left.refresh()
      this.right.refresh()
      this.updateStatus()
    }, 250)
    this.workspace.on('active-change', () => {
      this.left.refresh('explorer')
      this.right.refresh()
      this.updateStatus()
      this.updateTitle()
    })
    this.workspace.on('layout-change', () => {
      this.saveWorkspace()
      this.updateStatus()
    })
    this.vault.on('structure', () => {
      this.workspace.refreshTabs()
      refreshPanels()
    })
    this.vault.on('modify', refreshPanels)
    this.vault.on('rename', () => {
      this.workspace.refreshTabs()
      this.saveWorkspace()
    })
    window.jj.onFsChange((changes) => void this.vault.handleFsChanges(changes))
    window.addEventListener('beforeunload', () => {
      for (const l of this.workspace.leaves()) if (l.view instanceof MarkdownView) void l.view.flush()
    })
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applySettings())
  }

  // ---------- helpers used by views/panels ----------
  activeView() {
    return this.workspace.activeLeaf?.view ?? null
  }

  activeMarkdown(): MarkdownView | null {
    const v = this.activeView()
    return v instanceof MarkdownView ? v : null
  }

  activePath(): string | undefined {
    return this.activeView()?.path
  }

  notice(msg: string) {
    notice(msg)
  }

  updateStatus() {
    const md = this.activeMarkdown()
    this.statusEl.replaceChildren(
      ...(md
        ? [
            h('span', { class: 'status-bar-item' }, `${this.vault.backlinks(md.path).length} backlinks`),
            h('span', { class: 'status-bar-item' }, md.stats()),
            h('span', { class: 'status-bar-item status-mode', onclick: () => md.toggleReading() }, md.mode === 'reading' ? 'Reading' : md.mode === 'source' ? 'Source' : 'Live preview')
          ]
        : [])
    )
  }

  private updateTitle() {
    const v = this.activeView()
    document.title = `${v && v.type !== 'empty' ? v.getTitle() + ' - ' : ''}${this.vault.name} - jjunmo note`
  }

  async saveSettings() {
    await saveSettings(this.settings)
    this.applySettings()
  }

  applySettings() {
    const s = this.settings
    const dark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.body.classList.toggle('theme-dark', dark)
    document.body.classList.toggle('theme-light', !dark)
    document.body.classList.toggle('readable-line-length', s.readableLineLength)
    document.body.style.setProperty('--font-text-size', s.fontSize + 'px')
    document.body.style.setProperty('--interactive-accent', s.accent)
    for (const l of this.workspace.leaves()) {
      if (l.view instanceof MarkdownView) {
        ;(l.view as any).editor?.configure({ lineNumbers: s.showLineNumbers, vim: s.vimMode, spellcheck: s.spellcheck })
      }
    }
    this.left.refresh()
    this.right.refresh()
  }

  private async persistWorkspace() {
    try {
      await window.jj.write(WORKSPACE_PATH, JSON.stringify(this.workspace.serialize(), null, 2))
    } catch (err) {
      console.warn('could not save workspace', err)
    }
  }

  // ---------- navigation ----------
  async openFile(path: string, opts: { newTab?: boolean; split?: boolean; line?: number; mode?: string } = {}): Promise<Leaf | null> {
    if (!this.vault.exists(path)) {
      notice(`File not found: ${path}`)
      return null
    }
    const type = isMarkdown(path) ? 'markdown' : 'file'
    const leaf = await this.workspace.open({ type, path, line: opts.line, mode: opts.mode }, opts)
    leaf.view.focus()
    return leaf
  }

  /** Follows a link; creates the note when the target does not exist yet. */
  async openLink(target: string, source: string, subpath = '', newTab = false) {
    let path = target ? this.vault.resolve(target, source) : source
    if (!path) {
      const folder = target.includes('/') ? dirOf(target) : this.settings.newNoteFolder
      path = joinPath(folder, basenameOf(target).replace(/\.md$/i, '') + '.md')
      await this.vault.write(path, '')
    }
    const leaf = await this.openFile(path, { newTab })
    if (leaf?.view instanceof MarkdownView && subpath) setTimeout(() => (leaf.view as MarkdownView).scrollToSubpath(subpath), 50)
  }

  searchFor(query: string) {
    this.left.show('search')
    this.searchPanel.setQuery(query)
  }

  revealInExplorer(path: string) {
    this.left.show('explorer')
    this.explorer.reveal(path)
  }

  // ---------- file operations ----------
  async newNote(folder = this.settings.newNoteFolder, opts: { newTab?: boolean } = {}) {
    const path = await this.vault.createNote(folder)
    await this.openFile(path, { ...opts, mode: this.settings.defaultViewMode === 'reading' ? 'live' : undefined })
    // Focus the title so the user can name the note right away.
    this.activeMarkdown()?.focusTitle()
  }

  async renamePrompt(path: string) {
    const isFolder = this.vault.isFolder(path)
    const current = isFolder ? basenameOf(path) : Vault.title(path)
    const name = await prompt(isFolder ? 'Rename folder' : 'Rename file', current)
    if (!name || name === current) return
    const clean = name.replace(/[\\/:*?"<>|]/g, '-')
    const ext = isFolder ? '' : isMarkdown(path) ? '.md' : ''
    const target = joinPath(dirOf(path), clean + ext)
    await this.movePath(path, target)
  }

  async movePath(from: string, to: string) {
    if (this.vault.exists(to)) {
      notice(`"${to}" already exists`)
      return
    }
    for (const l of this.workspace.leaves()) if (l.view instanceof MarkdownView) await l.view.flush()
    try {
      await this.vault.rename(from, to)
    } catch (err) {
      notice(String((err as Error).message ?? err))
    }
  }

  moveTo(path: string) {
    const folders = ['', ...this.vault.folders()].filter((f) => f !== path && !f.startsWith(path + '/') && f !== dirOf(path))
    new ListSuggest('Move to folder…', folders, (f) => f || '/', (f) => void this.movePath(path, joinPath(f, basenameOf(path)))).open()
  }

  async duplicate(path: string) {
    const text = await this.vault.read(path)
    const name = Vault.title(path)
    const copy = this.vault.availablePath(dirOf(path), name + ' copy', isMarkdown(path) ? '.md' : '')
    await this.vault.write(copy, text)
    await this.openFile(copy)
  }

  async deletePath(path: string) {
    const isFolder = this.vault.isFolder(path)
    const ok = await confirm(isFolder ? 'Delete folder' : 'Delete file', `"${basenameOf(path)}" will be moved to the system trash.`)
    if (!ok) return
    await this.vault.trash(path)
  }

  async toggleBookmark(path: string) {
    const b = this.settings.bookmarks
    const i = b.indexOf(path)
    if (i >= 0) b.splice(i, 1)
    else b.push(path)
    await this.saveSettings()
    this.left.refresh('bookmarks')
    notice(i >= 0 ? 'Bookmark removed' : 'Bookmarked')
  }

  /** Turns an unlinked mention into a wikilink. */
  async linkMention(source: string, line: number, target: string) {
    const text = await this.vault.read(source)
    const lines = text.split('\n')
    const title = Vault.title(target)
    const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[])(${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}\\]])`, 'iu')
    const link = linkTextFor(target, this.vault.paths())
    lines[line] = lines[line].replace(re, (_m, pre, word) => `${pre}[[${link === word ? word : `${link}|${word}`}]]`)
    await this.vault.write(source, lines.join('\n'))
  }

  // ---------- templates & daily notes ----------
  private applyTemplate(text: string, title: string) {
    const now = new Date()
    return text
      .replace(/\{\{\s*title\s*\}\}/g, title)
      .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_m, fmt) => formatDate(now, fmt?.trim() || 'YYYY-MM-DD'))
      .replace(/\{\{\s*time(?::([^}]+))?\s*\}\}/g, (_m, fmt) => formatDate(now, fmt?.trim() || 'HH:mm'))
  }

  async openDailyNote() {
    const s = this.settings
    const name = formatDate(new Date(), s.dailyNoteFormat || 'YYYY-MM-DD')
    const path = joinPath(s.dailyNoteFolder, name + '.md')
    if (!this.vault.exists(path)) {
      let content = ''
      if (s.dailyNoteTemplate) {
        const tpl = this.vault.resolve(s.dailyNoteTemplate, '')
        if (tpl) content = this.applyTemplate(await this.vault.read(tpl), name)
      }
      await this.vault.write(path, content)
    }
    await this.openFile(path)
  }

  insertTemplate() {
    const md = this.activeMarkdown()
    if (!md) return notice('Open a note to insert a template')
    const folder = this.settings.templateFolder
    const templates = this.vault.notes().filter((p) => folder && (p.startsWith(folder + '/') || dirOf(p) === folder))
    if (!templates.length) return notice(`No templates found in "${folder || '(not set)'}". Create notes in that folder first.`)
    new ListSuggest('Choose a template…', templates, (p) => Vault.title(p), async (p) => md.insertText(this.applyTemplate(await this.vault.read(p), md.getTitle()))).open()
  }

  // ---------- commands ----------
  private registerCommands() {
    const md = () => this.activeMarkdown()
    const hasMd = () => !!md()
    const cmds: Command[] = [
      { id: 'new-note', name: 'Create new note', hotkey: 'Mod-n', run: () => this.newNote() },
      { id: 'new-note-tab', name: 'Create new note in new tab', hotkey: 'Mod-Shift-n', run: () => this.newNote(undefined, { newTab: true }) },
      { id: 'new-tab', name: 'New tab', hotkey: 'Mod-t', run: () => void this.workspace.open({ type: 'empty' }, { newTab: true }) },
      { id: 'quick-switcher', name: 'Quick switcher: Open', hotkey: 'Mod-o', run: () => new QuickSwitcher(this).open() },
      { id: 'command-palette', name: 'Command palette: Open', hotkey: 'Mod-p', run: () => new CommandPalette(this).open() },
      { id: 'search', name: 'Search: Search in all files', hotkey: 'Mod-Shift-f', run: () => this.searchFor(this.searchPanel.input.value) },
      { id: 'graph', name: 'Graph view: Open graph view', hotkey: 'Mod-g', run: () => void this.workspace.open({ type: 'graph' }) },
      { id: 'local-graph', name: 'Graph view: Open local graph', available: hasMd, run: () => void this.workspace.split({ type: 'graph', path: md()!.path }) },
      { id: 'toggle-reading', name: 'Toggle reading view', hotkey: 'Mod-e', available: hasMd, run: () => md()!.toggleReading() },
      { id: 'toggle-source', name: 'Toggle live preview / source mode', available: hasMd, run: () => md()!.setMode(md()!.mode === 'source' ? 'live' : 'source') },
      { id: 'close-tab', name: 'Close current tab', hotkey: 'Mod-w', run: () => this.workspace.activeLeaf && this.workspace.closeLeaf(this.workspace.activeLeaf) },
      { id: 'split-right', name: 'Split right', hotkey: 'Mod-\\', run: () => void this.workspace.split(this.activeView()?.getState() ?? { type: 'empty' }) },
      { id: 'next-tab', name: 'Go to next tab', hotkey: 'Ctrl-Tab', run: () => this.cycleTab(1) },
      { id: 'prev-tab', name: 'Go to previous tab', hotkey: 'Ctrl-Shift-Tab', run: () => this.cycleTab(-1) },
      { id: 'go-back', name: 'Navigate back', hotkey: 'Mod-Alt-ArrowLeft', run: () => this.workspace.activeLeaf?.goBack() },
      { id: 'go-forward', name: 'Navigate forward', hotkey: 'Mod-Alt-ArrowRight', run: () => this.workspace.activeLeaf?.goForward() },
      { id: 'settings', name: 'Open settings', hotkey: 'Mod-,', run: () => new SettingsModal(this).open() },
      { id: 'daily-note', name: "Daily notes: Open today's daily note", run: () => this.openDailyNote() },
      { id: 'insert-template', name: 'Templates: Insert template', run: () => this.insertTemplate() },
      { id: 'insert-date', name: 'Templates: Insert current date', available: hasMd, run: () => md()!.insertText(formatDate(new Date(), 'YYYY-MM-DD')) },
      { id: 'insert-time', name: 'Templates: Insert current time', available: hasMd, run: () => md()!.insertText(formatDate(new Date(), 'HH:mm')) },
      { id: 'toggle-left', name: 'Toggle left sidebar', run: () => this.left.toggle() },
      { id: 'toggle-right', name: 'Toggle right sidebar', run: () => this.right.toggle() },
      { id: 'show-files', name: 'Files: Show file explorer', hotkey: 'Mod-Shift-e', run: () => this.left.show('explorer') },
      { id: 'show-tags', name: 'Tags: Show tags', run: () => this.left.show('tags') },
      { id: 'show-bookmarks', name: 'Bookmarks: Show bookmarks', run: () => this.left.show('bookmarks') },
      { id: 'show-backlinks', name: 'Backlinks: Show backlinks', run: () => this.right.show('backlinks') },
      { id: 'show-outgoing', name: 'Outgoing links: Show outgoing links', run: () => this.right.show('outgoing') },
      { id: 'show-outline', name: 'Outline: Show outline', run: () => this.right.show('outline') },
      { id: 'reveal-active', name: 'Files: Reveal current file in navigation', available: () => !!this.activePath(), run: () => this.revealInExplorer(this.activePath()!) },
      { id: 'rename', name: 'Rename file', hotkey: 'F2', available: () => !!this.activePath(), run: () => this.renamePrompt(this.activePath()!) },
      { id: 'move', name: 'Move file to another folder', available: () => !!this.activePath(), run: () => this.moveTo(this.activePath()!) },
      { id: 'delete', name: 'Delete current file', available: () => !!this.activePath(), run: () => this.deletePath(this.activePath()!) },
      { id: 'bookmark', name: 'Bookmark current file', available: () => !!this.activePath(), run: () => this.toggleBookmark(this.activePath()!) },
      { id: 'copy-link', name: 'Copy wikilink to current file', available: hasMd, run: () => navigator.clipboard.writeText(`[[${linkTextFor(md()!.path, this.vault.paths())}]]`) },
      {
        id: 'random-note',
        name: 'Random note: Open random note',
        run: () => {
          const notes = this.vault.notes()
          if (notes.length) void this.openFile(notes[Math.floor(Math.random() * notes.length)])
        }
      },
      { id: 'reload-vault', name: 'Reload vault from disk', run: async () => (await this.vault.load(), notice('Vault reloaded')) },
      {
        id: 'switch-vault',
        name: 'Open another vault',
        run: async () => {
          for (const l of this.workspace.leaves()) if (l.view instanceof MarkdownView) await l.view.flush()
          localStorage.removeItem('lastVault')
          location.reload()
        }
      }
    ]
    for (const c of cmds) this.commands.add(c)
  }

  private cycleTab(dir: number) {
    const pane = this.workspace.activePane
    if (!pane.active || pane.leaves.length < 2) return
    const i = pane.leaves.indexOf(pane.active)
    void this.workspace.setActive(pane.leaves[(i + dir + pane.leaves.length) % pane.leaves.length])
  }
}

// ---------- modals that need the app ----------

class QuickSwitcher extends SuggestModal<string> {
  constructor(private app: App) {
    super('Find or create a note…', [
      ['↑↓', 'to navigate'],
      ['↵', 'to open'],
      [isMac() ? '⌘ ↵' : 'Ctrl ↵', 'to open in new tab'],
      ['⇧ ↵', 'to create'],
      ['esc', 'to dismiss']
    ])
  }
  getItems() {
    // Recently modified first when the query is empty.
    return this.app.vault
      .paths()
      .slice()
      .sort((a, b) => (this.app.vault.files.get(b)?.mtime ?? 0) - (this.app.vault.files.get(a)?.mtime ?? 0))
  }
  itemText(p: string) {
    return p.replace(/\.md$/i, '')
  }
  render(p: string): SuggestItem {
    return { label: p.replace(/\.md$/i, ''), detail: isMarkdown(p) ? undefined : 'attachment' }
  }
  choose(p: string, e: KeyboardEvent | MouseEvent) {
    void this.app.openFile(p, { newTab: e.metaKey || e.ctrlKey })
  }
  chooseEmpty(q: string, e: KeyboardEvent) {
    void this.app.openLink(q, '', '', e.metaKey || e.ctrlKey)
  }
}

class CommandPalette extends SuggestModal<Command> {
  constructor(private app: App) {
    super('Type a command…', [
      ['↑↓', 'to navigate'],
      ['↵', 'to use'],
      ['esc', 'to dismiss']
    ])
  }
  getItems() {
    return this.app.commands.list().sort((a, b) => a.name.localeCompare(b.name))
  }
  itemText(c: Command) {
    return c.name
  }
  render(c: Command): SuggestItem {
    return { label: c.name, hotkey: c.hotkey }
  }
  choose(c: Command) {
    this.app.commands.run(c.id)
  }
}
