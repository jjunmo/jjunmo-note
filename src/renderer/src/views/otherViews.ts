import { View, type ViewState } from '../ui/workspace'
import { h, icon, formatHotkey } from '../ui/dom'
import { GraphRenderer, DEFAULT_GRAPH, type GraphOptions } from './graph'
import { vaultUrl } from './render'
import { Vault, IMAGE_EXT } from '../core/vault'
import { debounce } from '../core/events'
import { basenameOf } from '../core/parse'

export class EmptyView extends View {
  type = 'empty'
  getTitle() {
    return 'New tab'
  }
  getState(): ViewState {
    return { type: 'empty' }
  }
  async onOpen() {
    const action = (label: string, cmd: string, key: string) =>
      h('div', { class: 'empty-state-action', onclick: () => this.app.commands.run(cmd) }, label, h('span', { class: 'empty-state-hotkey' }, formatHotkey(key)))
    this.el.classList.add('empty-state')
    this.el.append(
      h(
        'div',
        { class: 'empty-state-container' },
        h('div', { class: 'empty-state-title' }, 'No file is open'),
        action('Create new note', 'new-note', 'Mod-n'),
        action('Go to file', 'quick-switcher', 'Mod-o'),
        action('Open graph view', 'graph', 'Mod-g'),
        action('Command palette', 'command-palette', 'Mod-p'),
        h('div', { class: 'empty-state-action', onclick: () => this.app.workspace.closeLeaf(this.leaf) }, 'Close')
      )
    )
  }
}

/** Images, PDF, audio, video and other files that are not markdown. */
export class FileView extends View {
  type = 'file'
  private file = ''
  get path() {
    return this.file
  }
  getTitle() {
    return basenameOf(this.file)
  }
  getIcon() {
    return IMAGE_EXT.test(this.file) ? 'image' : 'file'
  }
  getState(): ViewState {
    return { type: 'file', path: this.file }
  }
  async onOpen(state: ViewState) {
    this.file = state.path ?? ''
    this.el.classList.add('file-view')
    const url = vaultUrl(this.file)
    let content: HTMLElement
    if (IMAGE_EXT.test(this.file)) content = h('img', { src: url, class: 'image-view' })
    else if (/\.pdf$/i.test(this.file)) content = h('iframe', { src: url, class: 'pdf-view' })
    else if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(this.file)) content = h('audio', { src: url, controls: true })
    else if (/\.(mp4|webm|mov)$/i.test(this.file)) content = h('video', { src: url, controls: true, class: 'video-view' })
    else
      content = h(
        'div',
        { class: 'empty-state-container' },
        h('div', { class: 'empty-state-title' }, 'This file type cannot be previewed'),
        h('div', { class: 'empty-state-action', onclick: () => window.jj.openExternal(this.file) }, 'Open in default app')
      )
    this.el.append(content)
  }
  async setState(state: ViewState) {
    if (state.type !== 'file') return false
    this.el.replaceChildren()
    await this.onOpen(state)
    return true
  }
}

export class GraphView extends View {
  type = 'graph'
  private local: string | null = null
  private renderer: GraphRenderer | null = null
  private opts: GraphOptions = { ...DEFAULT_GRAPH }
  private unsubs: (() => void)[] = []

  getTitle() {
    return this.local ? `Graph of ${Vault.title(this.local)}` : 'Graph view'
  }
  getIcon() {
    return 'graph'
  }
  getState(): ViewState {
    return { type: 'graph', path: this.local ?? undefined }
  }
  get path() {
    return undefined
  }

  async onOpen(state: ViewState) {
    this.local = state.path ?? null
    this.el.classList.add('graph-view')
    this.renderer = new GraphRenderer(this.app, this.opts, () => this.local)
    this.el.append(this.renderer.canvas, this.controls())
    const rebuild = debounce(() => this.renderer?.rebuild(), 300)
    this.unsubs.push(this.app.vault.on('structure', rebuild), this.app.vault.on('modify', rebuild))
    requestAnimationFrame(() => this.renderer?.rebuild())
  }

  onShow() {
    this.renderer?.rebuild()
  }

  private controls() {
    const box = h('div', { class: 'graph-controls' })
    const toggle = (label: string, key: 'showOrphans' | 'showUnresolved' | 'showTags') => {
      const input = h('input', { type: 'checkbox', checked: this.opts[key] })
      input.addEventListener('change', () => this.renderer?.setOptions({ [key]: input.checked }))
      return h('label', { class: 'graph-control-row' }, input, label)
    }
    const slider = (label: string, key: 'depth' | 'linkDistance' | 'repel', min: number, max: number) => {
      const input = h('input', { type: 'range', min, max, value: this.opts[key] })
      input.addEventListener('input', () => this.renderer?.setOptions({ [key]: Number(input.value) }))
      return h('label', { class: 'graph-control-row is-slider' }, label, input)
    }
    const search = h('input', { type: 'search', placeholder: 'Filter files…', class: 'graph-search' })
    search.addEventListener('input', debounce(() => this.renderer?.setOptions({ search: search.value }), 200))
    const body = h(
      'div',
      { class: 'graph-controls-body' },
      search,
      toggle('Tags', 'showTags'),
      toggle('Unresolved links', 'showUnresolved'),
      toggle('Orphans', 'showOrphans'),
      this.local ? slider('Depth', 'depth', 1, 5) : null,
      slider('Link distance', 'linkDistance', 20, 200),
      slider('Repel force', 'repel', 20, 600)
    )
    const header = h('div', { class: 'graph-controls-header', onclick: () => box.classList.toggle('is-collapsed') }, icon('settings', 14), ' Filters & forces')
    box.append(header, body)
    return box
  }

  async setState(state: ViewState) {
    if (state.type !== 'graph') return false
    this.local = state.path ?? null
    this.renderer?.rebuild()
    return true
  }

  onClose() {
    this.unsubs.forEach((u) => u())
    this.renderer?.destroy()
  }
}
