import { Modal } from './modal'
import { h, clear, formatHotkey } from './dom'
import type { App } from '../app'
import type { Settings } from '../core/settings'

type Field =
  | { key: keyof Settings; name: string; desc: string; type: 'toggle' }
  | { key: keyof Settings; name: string; desc: string; type: 'text'; placeholder?: string }
  | { key: keyof Settings; name: string; desc: string; type: 'number'; min: number; max: number }
  | { key: keyof Settings; name: string; desc: string; type: 'select'; options: [string, string][] }
  | { key: keyof Settings; name: string; desc: string; type: 'color' }

const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: 'Editor',
    fields: [
      { key: 'defaultViewMode', name: 'Default view for new tabs', desc: 'Live preview hides markdown syntax except on the active line.', type: 'select', options: [['live', 'Live preview'], ['source', 'Source mode'], ['reading', 'Reading view']] },
      { key: 'readableLineLength', name: 'Readable line length', desc: 'Limit maximum line length.', type: 'toggle' },
      { key: 'showLineNumbers', name: 'Show line numbers', desc: 'Show line numbers and fold markers in the gutter.', type: 'toggle' },
      { key: 'spellcheck', name: 'Spellcheck', desc: 'Underline misspelled words.', type: 'toggle' },
      { key: 'vimMode', name: 'Vim key bindings', desc: 'Use Vim key bindings when editing.', type: 'toggle' }
    ]
  },
  {
    title: 'Files & links',
    fields: [
      { key: 'newNoteFolder', name: 'Default location for new notes', desc: 'Folder path, empty for the vault root.', type: 'text', placeholder: '/' },
      { key: 'attachmentFolder', name: 'Attachment folder', desc: 'Where pasted and dropped files are stored.', type: 'text', placeholder: 'attachments' }
    ]
  },
  {
    title: 'Appearance',
    fields: [
      { key: 'theme', name: 'Base color scheme', desc: 'Light, dark, or follow the system.', type: 'select', options: [['dark', 'Dark'], ['light', 'Light'], ['system', 'Adapt to system']] },
      { key: 'accent', name: 'Accent color', desc: 'Used for links, selection and highlights.', type: 'color' },
      { key: 'fontSize', name: 'Font size', desc: 'Editor and reading font size in pixels.', type: 'number', min: 10, max: 30 }
    ]
  },
  {
    title: 'Daily notes',
    fields: [
      { key: 'dailyNoteFolder', name: 'New file location', desc: 'Daily notes are created in this folder.', type: 'text', placeholder: 'Daily' },
      { key: 'dailyNoteFormat', name: 'Date format', desc: 'Tokens: YYYY MM DD ddd dddd', type: 'text', placeholder: 'YYYY-MM-DD' },
      { key: 'dailyNoteTemplate', name: 'Template file location', desc: 'Path to a note used as the template.', type: 'text', placeholder: 'Templates/Daily' }
    ]
  },
  {
    title: 'Templates',
    fields: [{ key: 'templateFolder', name: 'Template folder location', desc: 'Notes in this folder are offered by "Insert template". Variables: {{title}} {{date}} {{time}} {{date:FORMAT}}', type: 'text', placeholder: 'Templates' }]
  }
]

export class SettingsModal extends Modal {
  private nav = h('div', { class: 'settings-nav' })
  private body = h('div', { class: 'settings-body' })

  constructor(private app: App) {
    super('settings-modal')
    this.contentEl.append(this.nav, this.body)
  }

  onOpen() {
    const items = [...SECTIONS.map((s) => s.title), 'Hotkeys', 'About']
    for (const title of items) {
      const el = h('div', { class: 'settings-nav-item', onclick: () => this.show(title) }, title)
      this.nav.append(el)
    }
    this.show(items[0])
  }

  private show(title: string) {
    for (const el of this.nav.children) el.classList.toggle('is-active', el.textContent === title)
    clear(this.body)
    this.body.append(h('h2', {}, title))
    if (title === 'Hotkeys') return this.hotkeys()
    if (title === 'About') return this.about()
    const section = SECTIONS.find((s) => s.title === title)!
    for (const f of section.fields) this.body.append(this.field(f))
  }

  private field(f: Field) {
    const s = this.app.settings as unknown as Record<string, unknown>
    const save = (v: unknown) => {
      s[f.key] = v
      void this.app.saveSettings()
    }
    let control: HTMLElement
    switch (f.type) {
      case 'toggle': {
        const c = h('div', { class: 'checkbox-container' + (s[f.key] ? ' is-enabled' : '') })
        c.addEventListener('click', () => {
          const next = !c.classList.contains('is-enabled')
          c.classList.toggle('is-enabled', next)
          save(next)
        })
        control = c
        break
      }
      case 'select': {
        const sel = h('select', { class: 'dropdown' }, ...f.options.map(([v, label]) => h('option', { value: v, selected: s[f.key] === v }, label)))
        sel.addEventListener('change', () => save(sel.value))
        control = sel
        break
      }
      case 'number': {
        const inp = h('input', { type: 'number', min: f.min, max: f.max, value: String(s[f.key]) })
        inp.addEventListener('change', () => save(Math.min(f.max, Math.max(f.min, Number(inp.value) || f.min))))
        control = inp
        break
      }
      case 'color': {
        const inp = h('input', { type: 'color', value: String(s[f.key]) })
        inp.addEventListener('input', () => save(inp.value))
        control = inp
        break
      }
      default: {
        const inp = h('input', { type: 'text', value: String(s[f.key] ?? ''), placeholder: (f as { placeholder?: string }).placeholder ?? '', spellcheck: false })
        inp.addEventListener('change', () => save(inp.value.replace(/^\/+|\/+$/g, '').trim()))
        control = inp
      }
    }
    return h('div', { class: 'setting-item' }, h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, f.name), h('div', { class: 'setting-item-description' }, f.desc)), h('div', { class: 'setting-item-control' }, control))
  }

  private hotkeys() {
    const list = this.app.commands.list().sort((a, b) => a.name.localeCompare(b.name))
    for (const c of list) {
      this.body.append(h('div', { class: 'setting-item' }, h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, c.name)), h('div', { class: 'setting-item-control' }, c.hotkey ? h('kbd', {}, formatHotkey(c.hotkey)) : h('span', { class: 'setting-hotkey-blank' }, 'Blank'))))
    }
    const editorKeys: [string, string][] = [
      ['Mod-b', 'Bold'],
      ['Mod-i', 'Italic'],
      ['Mod-Shift-h', 'Highlight'],
      ['Mod-k', 'Insert wikilink'],
      ['Mod-l', 'Toggle checkbox'],
      ['Mod-f', 'Find in note'],
      ['Mod-z', 'Undo']
    ]
    this.body.append(h('h3', {}, 'Editor'))
    for (const [k, n] of editorKeys) this.body.append(h('div', { class: 'setting-item' }, h('div', { class: 'setting-item-info' }, h('div', { class: 'setting-item-name' }, n)), h('div', { class: 'setting-item-control' }, h('kbd', {}, formatHotkey(k)))))
  }

  private about() {
    this.body.append(
      h('p', {}, 'jjunmo note — a local-first markdown knowledge base.'),
      h('p', {}, `Vault: ${this.app.vault.root}`),
      h('p', {}, `${this.app.vault.notes().length} notes · ${this.app.vault.paths().length} files`),
      h('p', { class: 'setting-item-description' }, 'Notes are plain .md files. Settings live in the .jjnote folder inside the vault.')
    )
  }

  onClose() {
    this.app.applySettings()
  }
}
