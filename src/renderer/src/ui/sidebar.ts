import { h, icon, clear } from './dom'

export interface Panel {
  id: string
  title: string
  icon: string
  el: HTMLElement
  /** Called when the panel is shown or data it depends on changed. */
  refresh(): void
  actions?: HTMLElement[]
}

export class Sidebar {
  el: HTMLElement
  private header: HTMLElement
  private body: HTMLElement
  private panels: Panel[] = []
  active: Panel | null = null
  collapsed = false

  constructor(public side: 'left' | 'right') {
    this.header = h('div', { class: 'sidebar-tab-header' })
    this.body = h('div', { class: 'sidebar-body' })
    this.el = h('div', { class: `sidebar sidebar-${side}` }, this.header, this.body, this.resizer())
  }

  add(panel: Panel) {
    this.panels.push(panel)
    panel.el.classList.add('sidebar-panel')
    this.renderHeader()
    if (!this.active) this.show(panel.id)
  }

  show(id: string) {
    const panel = this.panels.find((p) => p.id === id)
    if (!panel) return
    this.active = panel
    clear(this.body)
    const actions = panel.actions?.length ? h('div', { class: 'nav-buttons-container' }, ...panel.actions) : null
    if (actions) this.body.append(actions)
    this.body.append(panel.el)
    this.renderHeader()
    panel.refresh()
    if (this.collapsed) this.toggle(false)
  }

  /** Refreshes the visible panel only; hidden panels refresh when shown. */
  refresh(id?: string) {
    if (!this.active || this.collapsed) return
    if (!id || this.active.id === id) this.active.refresh()
  }

  toggle(collapse = !this.collapsed) {
    this.collapsed = collapse
    this.el.classList.toggle('is-collapsed', collapse)
    if (!collapse) this.active?.refresh()
  }

  private renderHeader() {
    clear(this.header)
    for (const p of this.panels) {
      this.header.append(
        h('div', { class: 'sidebar-tab' + (p === this.active ? ' is-active' : ''), title: p.title, 'aria-label': p.title, onclick: () => this.show(p.id) }, icon(p.icon))
      )
    }
  }

  private resizer() {
    const r = h('div', { class: 'sidebar-resizer' })
    r.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = this.el.getBoundingClientRect().width
      const move = (ev: MouseEvent) => {
        const dx = this.side === 'left' ? ev.clientX - startX : startX - ev.clientX
        this.el.style.width = Math.min(600, Math.max(180, startW + dx)) + 'px'
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
}
