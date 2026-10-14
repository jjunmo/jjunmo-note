import type { EditorView } from '@codemirror/view'
import { View, type ViewState } from '../ui/workspace'
import { h, iconButton, icon } from '../ui/dom'
import { showMenu } from '../ui/menu'
import { NoteEditor } from '../editor/editor'
import { vaultCompletions } from '../editor/complete'
import { createRenderer, vaultUrl } from './render'
import { Vault, IMAGE_EXT } from '../core/vault'
import { debounce } from '../core/events'
import { basenameOf, dirOf, joinPath, countWords, frontmatterRange } from '../core/parse'
import { formatDate, type ViewMode } from '../core/settings'
import { attachHoverPreview } from '../ui/hover'

export class MarkdownView extends View {
  type = 'markdown'
  file = ''
  mode: ViewMode = 'live'
  private editor: NoteEditor | null = null
  private headerEl = h('div', { class: 'view-header' })
  private titleEl = h('div', { class: 'view-header-title', contenteditable: 'true', spellcheck: false })
  private modeBtn = h('span')
  private navBack = iconButton('back', 'Navigate back', () => this.leaf.goBack())
  private navFwd = iconButton('forward', 'Navigate forward', () => this.leaf.goForward())
  private bodyEl = h('div', { class: 'markdown-view-body' })
  private editorEl = h('div', { class: 'markdown-source-view' })
  private readerEl = h('div', { class: 'markdown-reading-view markdown-rendered' })
  private inlineTitle = h('div', { class: 'inline-title', contenteditable: 'true', spellcheck: false })
  private renderer = createRenderer(() => ({
    vault: this.app.vault,
    sourcePath: this.file,
    onToggleTask: (line, checked) => this.toggleTaskLine(line, checked)
  }))
  private dirty = false
  private text = ''
  private unsubs: (() => void)[] = []

  private save = debounce(() => this.flush(), 600)

  get path() {
    return this.file
  }

  getTitle() {
    return Vault.title(this.file)
  }

  getState(): ViewState {
    return { type: 'markdown', path: this.file, mode: this.mode }
  }

  async onOpen(state: ViewState) {
    this.headerEl.append(
      h('div', { class: 'view-header-nav' }, this.navBack, this.navFwd),
      h('div', { class: 'view-header-title-container' }, h('span', { class: 'view-header-breadcrumb' }), this.titleEl),
      h(
        'div',
        { class: 'view-actions' },
        this.modeBtn,
        iconButton('more', 'More options', (e) => this.moreMenu(e))
      )
    )
    const sizer = h('div', { class: 'markdown-sizer' }, this.inlineTitle, this.editorEl)
    this.bodyEl.append(h('div', { class: 'markdown-scroller' }, sizer), this.readerEl)
    this.el.append(this.headerEl, this.bodyEl)
    this.el.classList.add('markdown-view')

    for (const t of [this.titleEl, this.inlineTitle]) {
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault()
          ;(e.target as HTMLElement).blur()
          if (e.target === this.inlineTitle) this.editor?.focus()
        } else if (e.key === 'Escape') {
          t.textContent = this.getTitle()
          t.blur()
        }
      })
      t.addEventListener('blur', () => this.renameFromTitle(t.textContent ?? ''))
    }

    this.readerEl.addEventListener('click', (e) => this.onReaderClick(e))
    attachHoverPreview(this.app, this.readerEl, () => this.file)
    attachHoverPreview(this.app, this.editorEl, () => this.file)

    const vault = this.app.vault
    this.unsubs.push(
      vault.on('modify', ({ path, external }) => {
        if (path !== this.file) {
          // Another note changed: link targets or embeds may differ.
          if (this.mode === 'reading') this.renderReading()
          return
        }
        if (external && !this.dirty) {
          this.text = vault.text(path) ?? this.text
          this.editor?.setDoc(this.text)
          if (this.mode === 'reading') this.renderReading()
        }
      }),
      vault.on('structure', () => {
        this.editor?.refresh()
        if (this.mode === 'reading') this.renderReading()
      }),
      vault.on('rename', ({ from, to }) => {
        if (from === this.file) {
          this.file = to
          this.updateHeader()
          this.leaf.updateTab()
        }
      }),
      vault.on('delete', (path) => {
        if (path === this.file) setTimeout(() => this.app.workspace.closeLeaf(this.leaf))
      })
    )

    await this.load(state)
  }

  private async load(state: ViewState) {
    if (this.dirty) await this.flush()
    this.file = state.path ?? ''
    this.mode = (state.mode as ViewMode) ?? this.app.settings.defaultViewMode
    this.text = await this.app.vault.read(this.file).catch(() => '')
    this.dirty = false
    this.editor?.destroy()
    const s = this.app.settings
    this.editor = new NoteEditor(this.editorEl, {
      doc: this.text,
      mode: this.mode === 'source' ? 'source' : 'live',
      host: {
        resolveLink: (t) => this.app.vault.resolve(t, this.file),
        imageUrl: (t) => {
          let target = t
          try {
            target = decodeURIComponent(t)
          } catch {}
          if (/^https?:/i.test(target)) return target
          const p = this.app.vault.resolve(target, this.file)
          return p && IMAGE_EXT.test(p) ? vaultUrl(p) : null
        },
        openLink: (t, sub, newTab) => this.app.openLink(t, this.file, sub, newTab),
        openTag: (tag) => this.app.searchFor(`tag:#${tag}`)
      },
      completion: vaultCompletions(() => this.app.vault, () => this.file),
      lineNumbers: s.showLineNumbers,
      vim: s.vimMode,
      spellcheck: s.spellcheck,
      onChange: (doc) => {
        this.text = doc
        this.dirty = true
        this.save()
        this.app.updateStatus()
      },
      onSelection: () => this.app.updateStatus(),
      onPasteFiles: (files, view) => this.pasteFiles(files, view)
    })
    this.updateHeader()
    this.applyMode()
    if (state.line != null) setTimeout(() => this.scrollToLine(state.line!))
  }

  async setState(state: ViewState) {
    if (state.type !== 'markdown') return false
    if (state.path === this.file) {
      if (state.mode && state.mode !== this.mode) this.setMode(state.mode as ViewMode)
      if (state.line != null) this.scrollToLine(state.line)
      return true
    }
    await this.load(state)
    return true
  }

  async flush() {
    this.save.cancel()
    if (!this.dirty || !this.file) return
    this.dirty = false
    try {
      await this.app.vault.write(this.file, this.text)
    } catch (err) {
      this.dirty = true
      console.error('save failed', err)
    }
  }

  onClose() {
    void this.flush()
    this.unsubs.forEach((u) => u())
    this.editor?.destroy()
  }

  onShow() {
    if (this.mode === 'reading') this.renderReading()
  }

  focus() {
    if (this.mode !== 'reading') this.editor?.focus()
  }

  /** Focuses and selects the inline title (after the editor's own autofocus). */
  focusTitle() {
    setTimeout(() => {
      this.inlineTitle.focus()
      document.getSelection()?.selectAllChildren(this.inlineTitle)
    }, 30)
  }

  get editorView(): EditorView | null {
    return this.mode === 'reading' ? null : (this.editor?.view ?? null)
  }

  get content() {
    return this.text
  }

  // ---------- modes ----------
  setMode(mode: ViewMode) {
    this.mode = mode
    if (mode !== 'reading') this.editor?.setMode(mode)
    this.applyMode()
    this.app.workspace.emit('layout-change', undefined)
  }

  toggleReading() {
    this.setMode(this.mode === 'reading' ? (this.app.settings.defaultViewMode === 'source' ? 'source' : 'live') : 'reading')
  }

  private applyMode() {
    const reading = this.mode === 'reading'
    this.bodyEl.classList.toggle('is-reading', reading)
    this.el.classList.toggle('is-source', this.mode === 'source')
    this.modeBtn.replaceChildren(
      iconButton(reading ? 'edit' : 'reading', reading ? 'Edit (Cmd/Ctrl+E)' : 'Reading view (Cmd/Ctrl+E)', () => this.toggleReading())
    )
    if (reading) {
      void this.flush()
      this.renderReading()
    } else {
      this.editor?.refresh()
      setTimeout(() => this.editor?.focus())
    }
    this.navBack.classList.toggle('is-disabled', !this.leaf.canGoBack())
    this.navFwd.classList.toggle('is-disabled', !this.leaf.canGoForward())
  }

  renderReading() {
    const scroll = this.readerEl.scrollTop
    const wrap = h('div', { class: 'markdown-preview-sizer' }, h('div', { class: 'inline-title' }, this.getTitle()))
    const out = h('div')
    this.renderer.render(this.text, out)
    wrap.append(out)
    this.readerEl.replaceChildren(wrap)
    this.readerEl.scrollTop = scroll
  }

  private updateHeader() {
    const dir = dirOf(this.file)
    const crumb = this.headerEl.querySelector('.view-header-breadcrumb')!
    crumb.textContent = dir ? dir.split('/').join(' / ') + ' / ' : ''
    this.titleEl.textContent = this.getTitle()
    this.inlineTitle.textContent = this.getTitle()
    this.navBack.classList.toggle('is-disabled', !this.leaf.canGoBack())
    this.navFwd.classList.toggle('is-disabled', !this.leaf.canGoForward())
  }

  private async renameFromTitle(raw: string) {
    const name = raw.replace(/[\\/:*?"<>|#^\[\]]/g, '').trim()
    if (!name || name === this.getTitle()) {
      this.updateHeader()
      return
    }
    const target = joinPath(dirOf(this.file), name + '.md')
    if (this.app.vault.exists(target)) {
      this.app.notice(`"${name}" already exists`)
      this.updateHeader()
      return
    }
    await this.flush()
    await this.app.vault.rename(this.file, target)
  }

  scrollToLine(line: number) {
    if (this.mode === 'reading') {
      const el = this.readerEl.querySelector<HTMLElement>(`[data-line="${line}"]`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } else this.editor?.scrollToLine(line)
  }

  scrollToSubpath(subpath: string) {
    if (!subpath) return
    const meta = this.app.vault.meta(this.file)
    if (!meta) return
    if (subpath.startsWith('#^')) {
      const id = subpath.slice(2)
      const line = this.text.split('\n').findIndex((l) => l.trimEnd().endsWith('^' + id))
      if (line >= 0) this.scrollToLine(line)
      return
    }
    const want = subpath.slice(1).toLowerCase()
    const hd = meta.headings.find((x) => x.text.toLowerCase() === want)
    if (hd) this.scrollToLine(hd.line)
  }

  // ---------- editing helpers ----------
  insertText(text: string) {
    if (this.mode === 'reading') this.setMode('live')
    this.editor?.insertAtCursor(text)
  }

  private toggleTaskLine(line: number, checked: boolean) {
    const lines = this.text.split('\n')
    if (!lines[line]) return
    lines[line] = lines[line].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]')
    this.text = lines.join('\n')
    this.editor?.setDoc(this.text)
    this.dirty = true
    void this.flush()
  }

  private pasteFiles(files: File[], view: EditorView): boolean {
    const accepted = files.filter((f) => f.type.startsWith('image/') || /\.(pdf|mp3|mp4|webm|wav|m4a)$/i.test(f.name))
    if (!accepted.length) return false
    void (async () => {
      const links: string[] = []
      for (const f of accepted) {
        const ext = (/\.[^.]+$/.exec(f.name)?.[0] ?? '.' + (f.type.split('/')[1] || 'png')).toLowerCase()
        const base = f.name && !/^image\.\w+$/.test(f.name) ? f.name.replace(/\.[^.]+$/, '') : `Pasted image ${formatDate(new Date(), 'YYYYMMDDHHmmss')}`
        const path = this.app.vault.availablePath(this.app.settings.attachmentFolder, base, ext)
        await this.app.vault.writeBinary(path, await f.arrayBuffer())
        links.push(`![[${basenameOf(path)}]]`)
      }
      const { from, to } = view.state.selection.main
      const insert = links.join('\n')
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
    })()
    return true
  }

  private onReaderClick(e: MouseEvent) {
    const el = e.target as HTMLElement
    const link = el.closest<HTMLElement>('a.internal-link')
    if (link) {
      e.preventDefault()
      this.app.openLink(link.dataset.href ?? '', this.file, link.dataset.subpath ?? '', e.metaKey || e.ctrlKey)
      return
    }
    const tag = el.closest<HTMLElement>('a.tag')
    if (tag) {
      e.preventDefault()
      this.app.searchFor(`tag:#${tag.dataset.tag}`)
      return
    }
    const ext = el.closest<HTMLAnchorElement>('a.external-link')
    if (ext) {
      e.preventDefault()
      window.jj.openExternal(ext.href)
    }
  }

  private moreMenu(e: MouseEvent) {
    showMenu(e, [
      { title: this.mode === 'source' ? 'Live preview' : 'Source mode', icon: 'source', onClick: () => this.setMode(this.mode === 'source' ? 'live' : 'source') },
      { title: this.mode === 'reading' ? 'Edit' : 'Reading view', icon: 'reading', onClick: () => this.toggleReading() },
      null,
      { title: 'Open in new tab', icon: 'plus', onClick: () => this.app.workspace.open(this.getState(), { newTab: true }) },
      { title: 'Split right', icon: 'split', onClick: () => this.app.workspace.split(this.getState()) },
      { title: 'Open local graph', icon: 'graph', onClick: () => this.app.workspace.split({ type: 'graph', path: this.file }) },
      null,
      { title: 'Rename…', icon: 'edit', onClick: () => this.inlineTitle.focus() },
      { title: this.app.settings.bookmarks.includes(this.file) ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', onClick: () => this.app.toggleBookmark(this.file) },
      { title: 'Reveal in system explorer', icon: 'folder-open', onClick: () => window.jj.reveal(this.file) },
      { title: 'Copy wikilink', icon: 'link', onClick: () => navigator.clipboard.writeText(`[[${this.getTitle()}]]`) },
      null,
      { title: 'Delete file', icon: 'trash', danger: true, onClick: () => this.app.deletePath(this.file) }
    ])
  }

  /** Status bar text: words / characters. */
  stats(): string {
    const view = this.editor?.view
    const sel = view && this.mode !== 'reading' ? view.state.selection.main : null
    if (sel && !sel.empty) {
      const s = view!.state.sliceDoc(sel.from, sel.to)
      return `${countWords(s)} words selected · ${s.length} characters`
    }
    const fm = frontmatterRange(this.text)
    const body = fm ? this.text.slice(fm.endOffset) : this.text
    return `${countWords(body)} words · ${body.length} characters`
  }

  getIcon() {
    return 'file'
  }

  static iconEl = icon
}
