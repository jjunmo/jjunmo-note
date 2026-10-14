import { h, clear, highlightMatches, formatHotkey } from './dom'
import { fuzzyMatch } from '../core/parse'

export class Modal {
  container: HTMLElement
  modalEl: HTMLElement
  contentEl: HTMLElement
  private prevFocus: Element | null = null

  constructor(cls = '') {
    this.contentEl = h('div', { class: 'modal-content' })
    this.modalEl = h('div', { class: `modal ${cls}` }, this.contentEl)
    this.container = h('div', { class: 'modal-container' }, h('div', { class: 'modal-bg', onclick: () => this.close() }), this.modalEl)
    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.close()
      }
    })
  }

  open() {
    this.prevFocus = document.activeElement
    document.body.appendChild(this.container)
    this.onOpen()
  }

  close() {
    this.container.remove()
    this.onClose()
    ;(this.prevFocus as HTMLElement | null)?.focus?.()
  }

  onOpen() {}
  onClose() {}
}

export interface SuggestItem {
  label: string
  detail?: string
  hotkey?: string
  icon?: Node
}

/** Fuzzy-filtered list with keyboard navigation (quick switcher, command palette, etc.). */
export abstract class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement
  listEl: HTMLElement
  footerEl: HTMLElement
  private results: { item: T; matches: number[] }[] = []
  private selected = 0
  emptyText = 'No results.'
  limit = 200

  constructor(placeholder: string, instructions: [string, string][] = []) {
    super('suggest-modal')
    this.inputEl = h('input', { class: 'prompt-input', type: 'text', placeholder, spellcheck: false })
    this.listEl = h('div', { class: 'suggestion-list' })
    this.footerEl = h(
      'div',
      { class: 'prompt-instructions' },
      ...instructions.map(([k, v]) => h('span', { class: 'prompt-instruction' }, h('kbd', {}, k), ' ' + v))
    )
    this.contentEl.append(this.inputEl, this.listEl, this.footerEl)
    this.inputEl.addEventListener('input', () => this.update())
    this.inputEl.addEventListener('keydown', (e) => this.onKey(e))
  }

  abstract getItems(): T[]
  abstract itemText(item: T): string
  abstract render(item: T, matches: number[]): SuggestItem
  abstract choose(item: T, evt: KeyboardEvent | MouseEvent): void
  /** Called on Enter when nothing matches (or with Shift+Enter). */
  chooseEmpty?(query: string, evt: KeyboardEvent): void

  onOpen() {
    this.update()
    this.inputEl.focus()
  }

  update() {
    const q = this.inputEl.value.trim()
    const items = this.getItems()
    if (!q) this.results = items.slice(0, this.limit).map((item) => ({ item, matches: [] }))
    else {
      const scored: { item: T; matches: number[]; score: number }[] = []
      for (const item of items) {
        const m = fuzzyMatch(q, this.itemText(item))
        if (m) scored.push({ item, matches: m.matches, score: m.score })
      }
      scored.sort((a, b) => b.score - a.score)
      this.results = scored.slice(0, this.limit)
    }
    this.selected = 0
    this.renderList()
  }

  private renderList() {
    clear(this.listEl)
    if (!this.results.length) {
      const q = this.inputEl.value.trim()
      this.listEl.append(h('div', { class: 'suggestion-empty' }, this.chooseEmpty && q ? `Enter to create "${q}"` : this.emptyText))
      return
    }
    this.results.forEach((r, i) => {
      const s = this.render(r.item, r.matches)
      const el = h(
        'div',
        { class: 'suggestion-item' + (i === this.selected ? ' is-selected' : '') },
        s.icon ?? null,
        h('div', { class: 'suggestion-content' }, h('div', { class: 'suggestion-title' }, highlightMatches(s.label, r.matches)), s.detail ? h('div', { class: 'suggestion-note' }, s.detail) : null),
        s.hotkey ? h('kbd', { class: 'suggestion-hotkey' }, formatHotkey(s.hotkey)) : null
      )
      el.addEventListener('mousemove', () => this.select(i))
      el.addEventListener('click', (e) => {
        this.close()
        this.choose(r.item, e)
      })
      this.listEl.append(el)
    })
  }

  private select(i: number) {
    if (i === this.selected) return
    this.listEl.children[this.selected]?.classList.remove('is-selected')
    this.selected = i
    const el = this.listEl.children[i]
    el?.classList.add('is-selected')
    el?.scrollIntoView({ block: 'nearest' })
  }

  private onKey(e: KeyboardEvent) {
    const n = this.results.length
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      if (n) this.select((this.selected + 1) % n)
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      if (n) this.select((this.selected - 1 + n) % n)
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      const q = this.inputEl.value.trim()
      if ((e.shiftKey || !n) && this.chooseEmpty && q) {
        this.close()
        this.chooseEmpty(q, e)
      } else if (n) {
        this.close()
        this.choose(this.results[this.selected].item, e)
      }
    }
  }
}

/** Fuzzy list built from a plain array. */
export class ListSuggest<T> extends SuggestModal<T> {
  constructor(
    placeholder: string,
    private items: T[],
    private text: (t: T) => string,
    private onChoose: (t: T) => void,
    private detail?: (t: T) => string | undefined
  ) {
    super(placeholder, [
      ['↑↓', 'to navigate'],
      ['↵', 'to choose'],
      ['esc', 'to dismiss']
    ])
  }
  getItems() {
    return this.items
  }
  itemText(t: T) {
    return this.text(t)
  }
  render(t: T) {
    return { label: this.text(t), detail: this.detail?.(t) }
  }
  choose(t: T) {
    this.onChoose(t)
  }
}

export function prompt(title: string, initial = '', placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const m = new Modal('prompt-modal')
    let result: string | null = null
    const input = h('input', { class: 'prompt-input', type: 'text', value: initial, placeholder, spellcheck: false })
    const submit = () => {
      result = input.value.trim() || null
      m.close()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        submit()
      }
    })
    m.contentEl.append(
      h('div', { class: 'modal-title' }, title),
      input,
      h('div', { class: 'modal-buttons' }, h('button', { class: 'mod-cta', onclick: submit }, 'OK'), h('button', { onclick: () => m.close() }, 'Cancel'))
    )
    m.onClose = () => resolve(result)
    m.open()
    input.focus()
    input.select()
  })
}

export function confirm(title: string, message: string, cta = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    const m = new Modal('confirm-modal')
    let ok = false
    const yes = h(
      'button',
      {
        class: 'mod-warning',
        onclick: () => {
          ok = true
          m.close()
        }
      },
      cta
    )
    m.contentEl.append(
      h('div', { class: 'modal-title' }, title),
      h('p', {}, message),
      h('div', { class: 'modal-buttons' }, yes, h('button', { onclick: () => m.close() }, 'Cancel'))
    )
    m.onClose = () => resolve(ok)
    m.open()
    yes.focus()
  })
}

export function notice(message: string, ms = 3000) {
  let box = document.querySelector<HTMLElement>('.notice-container')
  if (!box) {
    box = h('div', { class: 'notice-container' })
    document.body.appendChild(box)
  }
  const n = h('div', { class: 'notice' }, message)
  n.addEventListener('click', () => n.remove())
  box.appendChild(n)
  setTimeout(() => n.remove(), ms)
}
