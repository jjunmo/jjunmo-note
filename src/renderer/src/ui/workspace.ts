import { h, icon, iconButton, clear } from './dom'
import { showMenu } from './menu'
import { Emitter } from '../core/events'
import type { App } from '../app'

export interface ViewState {
  type: string
  path?: string
  mode?: string
  line?: number
}

export abstract class View {
  el = h('div', { class: 'view-content' })
  constructor(public app: App, public leaf: Leaf) {}
  abstract type: string
  abstract getTitle(): string
  getIcon() {
    return 'file'
  }
  get path(): string | undefined {
    return undefined
  }
  abstract getState(): ViewState
  /** Called once after the element is mounted. */
  async onOpen(_state: ViewState): Promise<void> {}
  onClose() {}
  /** Called when the view becomes visible again (tab switch). */
  onShow() {}
  focus() {}
  /** Return true if the view handled the new state in place (same type). */
  async setState(_state: ViewState): Promise<boolean> {
    return false
  }
}

export type ViewFactory = (app: App, leaf: Leaf, state: ViewState) => View

export class Leaf {
  view: View
  tabEl: HTMLElement
  private back: ViewState[] = []
  private forward: ViewState[] = []
  constructor(public pane: Pane, view: View) {
    this.view = view
    this.tabEl = h('div', { class: 'workspace-tab' })
  }

  updateTab() {
    clear(this.tabEl)
    this.tabEl.title = this.view.path ?? this.view.getTitle()
    this.tabEl.append(
      icon(this.view.getIcon(), 14),
      h('span', { class: 'workspace-tab-title' }, this.view.getTitle()),
      iconButton('x', 'Close', (e) => {
        e.stopPropagation()
        this.pane.ws.closeLeaf(this)
      }, 'workspace-tab-close')
    )
  }

  /** Navigates this leaf to a new state, keeping history for back/forward. */
  async navigate(state: ViewState, record = true) {
    const ws = this.pane.ws
    const prev = this.view.getState()
    if (record && (prev.path !== state.path || prev.type !== state.type)) {
      this.back.push(prev)
      this.forward = []
    }
    if (!(await this.view.setState(state))) {
      this.view.onClose()
      this.view.el.remove()
      this.view = ws.createView(this, state)
      this.pane.mount(this)
      await this.view.onOpen(state)
    }
    this.updateTab()
    ws.emit('layout-change', undefined)
    ws.emit('active-change', ws.activeLeaf)
  }

  canGoBack() {
    return this.back.length > 0
  }
  canGoForward() {
    return this.forward.length > 0
  }
  async goBack() {
    const s = this.back.pop()
    if (!s) return
    this.forward.push(this.view.getState())
    await this.navigate(s, false)
  }
  async goForward() {
    const s = this.forward.pop()
    if (!s) return
    this.back.push(this.view.getState())
    await this.navigate(s, false)
  }
}

export class Pane {
  el: HTMLElement
  tabBar: HTMLElement
  contentEl: HTMLElement
  leaves: Leaf[] = []
  active: Leaf | null = null

  constructor(public ws: Workspace) {
    this.tabBar = h('div', { class: 'workspace-tab-bar' })
    this.contentEl = h('div', { class: 'workspace-pane-content' })
    this.el = h('div', { class: 'workspace-pane' }, h('div', { class: 'workspace-tab-header' }, this.tabBar, iconButton('plus', 'New tab', () => ws.app.commands.run('new-tab'), 'new-tab-button')), this.contentEl)
    this.el.addEventListener('mousedown', () => {
      if (this.active && ws.activeLeaf !== this.active) ws.setActive(this.active)
    }, true)
    this.tabBar.addEventListener('wheel', (e) => {
      this.tabBar.scrollLeft += e.deltaY
    })
  }

  mount(leaf: Leaf) {
    leaf.view.el.dataset.type = leaf.view.type
    this.contentEl.append(leaf.view.el)
    leaf.view.el.style.display = leaf === this.active ? '' : 'none'
  }

  add(leaf: Leaf, index = this.leaves.length) {
    this.leaves.splice(index, 0, leaf)
    leaf.tabEl.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        this.ws.closeLeaf(leaf)
      } else this.ws.setActive(leaf)
    })
    leaf.tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showMenu(e, [
        { title: 'Close', icon: 'x', onClick: () => this.ws.closeLeaf(leaf) },
        { title: 'Close others', onClick: () => this.leaves.filter((l) => l !== leaf).forEach((l) => this.ws.closeLeaf(l)) },
        { title: 'Split right', icon: 'split', onClick: () => this.ws.split(leaf.view.getState()) },
        ...(leaf.view.path ? [{ title: 'Reveal in file explorer', icon: 'folder-open', onClick: () => this.ws.app.revealInExplorer(leaf.view.path!) }] : [])
      ])
    })
    this.renderTabs()
    this.mount(leaf)
  }

  renderTabs() {
    clear(this.tabBar)
    for (const leaf of this.leaves) {
      leaf.updateTab()
      leaf.tabEl.classList.toggle('is-active', leaf === this.active)
      this.tabBar.append(leaf.tabEl)
    }
  }

  show(leaf: Leaf) {
    this.active = leaf
    for (const l of this.leaves) l.view.el.style.display = l === leaf ? '' : 'none'
    for (const l of this.leaves) l.tabEl.classList.toggle('is-active', l === leaf)
    leaf.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

type WsEvents = {
  'active-change': Leaf | null
  'layout-change': void
}

export class Workspace extends Emitter<WsEvents> {
  el = h('div', { class: 'workspace-split' })
  panes: Pane[] = []
  activeLeaf: Leaf | null = null
  private factories = new Map<string, ViewFactory>()

  constructor(public app: App) {
    super()
  }

  register(type: string, factory: ViewFactory) {
    this.factories.set(type, factory)
  }

  createView(leaf: Leaf, state: ViewState): View {
    const f = this.factories.get(state.type) ?? this.factories.get('empty')!
    return f(this.app, leaf, state)
  }

  get activePane(): Pane {
    return this.activeLeaf?.pane ?? this.panes[0] ?? this.addPane()
  }

  private addPane(after?: Pane): Pane {
    const pane = new Pane(this)
    const idx = after ? this.panes.indexOf(after) + 1 : this.panes.length
    this.panes.splice(idx, 0, pane)
    this.renderPanes()
    return pane
  }

  private renderPanes() {
    clear(this.el)
    this.panes.forEach((p, i) => {
      if (i > 0) this.el.append(this.resizer(this.panes[i - 1], p))
      this.el.append(p.el)
    })
  }

  private resizer(left: Pane, right: Pane) {
    const r = h('div', { class: 'workspace-resizer' })
    r.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const lw = left.el.getBoundingClientRect().width
      const rw = right.el.getBoundingClientRect().width
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        left.el.style.flex = `0 0 ${Math.max(200, lw + dx)}px`
        right.el.style.flex = `0 0 ${Math.max(200, rw - dx)}px`
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    return r
  }

  async newLeaf(pane: Pane, state: ViewState, index?: number): Promise<Leaf> {
    const leaf = new Leaf(pane, null as unknown as View)
    leaf.view = this.createView(leaf, state)
    pane.add(leaf, index)
    await leaf.view.onOpen(state)
    leaf.updateTab()
    await this.setActive(leaf)
    return leaf
  }

  async setActive(leaf: Leaf) {
    const changed = this.activeLeaf !== leaf
    this.activeLeaf = leaf
    leaf.pane.show(leaf)
    for (const p of this.panes) p.el.classList.toggle('is-active', p === leaf.pane)
    leaf.view.onShow()
    if (changed) {
      this.emit('active-change', leaf)
      this.emit('layout-change', undefined)
    }
  }

  /**
   * Opens a state: reuses the active tab unless `newTab`, or an existing tab
   * already showing the same file.
   */
  async open(state: ViewState, opts: { newTab?: boolean; split?: boolean } = {}): Promise<Leaf> {
    if (opts.split) return this.split(state)
    const pane = this.activePane
    if (state.path && !opts.newTab) {
      const existing = this.leaves().find((l) => l.view.path === state.path && l.view.type === state.type)
      if (existing && existing !== this.activeLeaf) {
        await this.setActive(existing)
        if (state.line != null) await existing.view.setState(state)
        return existing
      }
    }
    if (!opts.newTab && pane.active) {
      await pane.active.navigate(state)
      await this.setActive(pane.active)
      return pane.active
    }
    const index = pane.active ? pane.leaves.indexOf(pane.active) + 1 : undefined
    return this.newLeaf(pane, state, index)
  }

  async split(state: ViewState): Promise<Leaf> {
    const pane = this.addPane(this.activePane)
    return this.newLeaf(pane, state)
  }

  leaves(): Leaf[] {
    return this.panes.flatMap((p) => p.leaves)
  }

  closeLeaf(leaf: Leaf) {
    const pane = leaf.pane
    const idx = pane.leaves.indexOf(leaf)
    pane.leaves.splice(idx, 1)
    leaf.view.onClose()
    leaf.view.el.remove()
    leaf.tabEl.remove()
    if (pane.leaves.length === 0) {
      if (this.panes.length > 1) {
        this.panes.splice(this.panes.indexOf(pane), 1)
        for (const p of this.panes) p.el.style.flex = ''
        this.renderPanes()
        const next = this.panes[0].active
        if (this.activeLeaf === leaf) {
          this.activeLeaf = null
          if (next) this.setActive(next)
        }
      } else {
        this.activeLeaf = null
        pane.active = null
        void this.newLeaf(pane, { type: 'empty' })
      }
    } else if (pane.active === leaf) {
      const next = pane.leaves[Math.min(idx, pane.leaves.length - 1)]
      pane.active = null
      if (this.activeLeaf === leaf) this.activeLeaf = null
      this.setActive(next)
    }
    pane.renderTabs()
    this.emit('layout-change', undefined)
    if (!this.activeLeaf) this.emit('active-change', null)
  }

  /** Refreshes tab titles (after renames). */
  refreshTabs() {
    for (const p of this.panes) p.renderTabs()
  }

  serialize() {
    return {
      panes: this.panes.map((p) => ({
        leaves: p.leaves.map((l) => l.view.getState()).filter((s) => s.type !== 'empty' || p.leaves.length === 1),
        active: p.active ? p.leaves.indexOf(p.active) : 0
      })),
      activePane: this.activeLeaf ? this.panes.indexOf(this.activeLeaf.pane) : 0
    }
  }

  async restore(data: ReturnType<Workspace['serialize']> | null) {
    this.panes = []
    this.activeLeaf = null
    this.renderPanes()
    const panes = data?.panes?.length ? data.panes : [{ leaves: [{ type: 'empty' }], active: 0 }]
    for (const p of panes) {
      const pane = this.addPane()
      const leaves = p.leaves.length ? p.leaves : [{ type: 'empty' }]
      for (const s of leaves) {
        const valid = !s.path || this.app.vault.exists(s.path) ? s : { type: 'empty' }
        await this.newLeaf(pane, valid)
      }
      const active = pane.leaves[p.active] ?? pane.leaves[0]
      if (active) await this.setActive(active)
    }
    const activePane = this.panes[data?.activePane ?? 0] ?? this.panes[0]
    if (activePane?.active) await this.setActive(activePane.active)
  }

  /** Icon used for sidebar headers etc. */
  static icon = icon
}
