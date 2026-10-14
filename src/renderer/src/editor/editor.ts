import { Compartment, EditorState, EditorSelection } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  rectangularSelection,
  crosshairCursor,
  placeholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionSource } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import { Strikethrough, Table, TaskList } from '@lezer/markdown'
import { vim } from '@replit/codemirror-vim'
import { livePreview, refreshEffect, type LivePreviewHost } from "./livePreview"

const highlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-hd cm-hd1' },
  { tag: t.heading2, class: 'cm-hd cm-hd2' },
  { tag: t.heading3, class: 'cm-hd cm-hd3' },
  { tag: [t.heading4, t.heading5, t.heading6], class: 'cm-hd' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', class: 'cm-strike' },
  { tag: t.link, class: 'cm-link-text' },
  { tag: t.url, class: 'cm-url' },
  { tag: t.monospace, class: 'cm-inline-code' },
  { tag: t.quote, class: 'cm-quote-text' },
  { tag: t.processingInstruction, class: 'cm-formatting' },
  { tag: t.meta, class: 'cm-formatting' },
  { tag: t.contentSeparator, class: 'cm-formatting' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: [t.string, t.special(t.string)], class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: [t.number, t.bool, t.null], class: 'tok-number' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-function' },
  { tag: [t.typeName, t.className], class: 'tok-type' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.operator, class: 'tok-operator' }
])

/** Wraps the selection with `mark`, or removes it when already wrapped. */
function toggleWrap(mark: string) {
  return (view: EditorView) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const { from, to } = range
        const before = view.state.sliceDoc(from - mark.length, from)
        const after = view.state.sliceDoc(to, to + mark.length)
        if (before === mark && after === mark) {
          return {
            changes: [
              { from: from - mark.length, to: from },
              { from: to, to: to + mark.length }
            ],
            range: EditorSelection.range(from - mark.length, to - mark.length)
          }
        }
        return {
          changes: [
            { from, insert: mark },
            { from: to, insert: mark }
          ],
          range: EditorSelection.range(from + mark.length, to + mark.length)
        }
      })
    )
    return true
  }
}

function insertLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to)
      const insert = `[[${text}]]`
      return {
        changes: { from: range.from, to: range.to, insert },
        range: text ? EditorSelection.cursor(range.from + insert.length) : EditorSelection.cursor(range.from + 2)
      }
    })
  )
  return true
}

function toggleTask(view: EditorView) {
  const changes = []
  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.head)
    const m = /^(\s*)([-*+]\s+)?(\[[ xX]\]\s+)?/.exec(line.text)!
    const indent = m[1].length
    if (m[3]) {
      const box = line.from + indent + (m[2]?.length ?? 0)
      const checked = /x/i.test(m[3])
      changes.push({ from: box + 1, to: box + 2, insert: checked ? ' ' : 'x' })
    } else if (m[2]) {
      changes.push({ from: line.from + indent + m[2].length, insert: '[ ] ' })
    } else {
      changes.push({ from: line.from + indent, insert: '- [ ] ' })
    }
  }
  view.dispatch({ changes })
  return true
}

export interface EditorOptions {
  doc: string
  mode: 'live' | 'source'
  host: LivePreviewHost
  completion: CompletionSource
  lineNumbers: boolean
  vim: boolean
  spellcheck: boolean
  onChange: (doc: string) => void
  onSelection?: (view: EditorView) => void
  onPasteFiles?: (files: File[], view: EditorView) => boolean
}

export class NoteEditor {
  view: EditorView
  private modeConf = new Compartment()
  private lineNumConf = new Compartment()
  private vimConf = new Compartment()
  private spellConf = new Compartment()
  private silent = false

  constructor(parent: HTMLElement, private opts: EditorOptions) {
    const state = EditorState.create({
      doc: opts.doc,
      extensions: [
        this.vimConf.of(opts.vim ? vim() : []),
        this.lineNumConf.of(opts.lineNumbers ? [lineNumbers(), foldGutter()] : []),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        placeholder('Start writing…'),
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table, TaskList] }),
        syntaxHighlighting(highlight),
        autocompletion({ override: [opts.completion], activateOnTyping: true, icons: false }),
        this.modeConf.of(livePreview(opts.host, opts.mode === 'live')),
        this.spellConf.of(EditorView.contentAttributes.of({ spellcheck: String(opts.spellcheck) })),
        keymap.of([
          { key: 'Mod-b', run: toggleWrap('**') },
          { key: 'Mod-i', run: toggleWrap('*') },
          { key: 'Mod-Shift-h', run: toggleWrap('==') },
          { key: 'Mod-Shift-x', run: toggleWrap('~~') },
          { key: 'Mod-`', run: toggleWrap('`') },
          { key: 'Mod-k', run: insertLink },
          { key: 'Mod-l', run: toggleTask },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !this.silent) opts.onChange(u.state.doc.toString())
          if (u.selectionSet || u.docChanged) opts.onSelection?.(u.view)
        }),
        EditorView.domEventHandlers({
          paste: (e, view) => {
            const files = [...(e.clipboardData?.files ?? [])]
            if (files.length && opts.onPasteFiles?.(files, view)) {
              e.preventDefault()
              return true
            }
            return false
          },
          drop: (e, view) => {
            const files = [...(e.dataTransfer?.files ?? [])]
            if (files.length && opts.onPasteFiles?.(files, view)) {
              e.preventDefault()
              return true
            }
            // Dragging a note from the file explorer inserts a link.
            const path = e.dataTransfer?.getData('application/x-jjnote-path')
            if (path) {
              e.preventDefault()
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
              const name = path.replace(/\.md$/i, '').split('/').pop()
              view.dispatch({ changes: { from: pos, insert: `[[${name}]]` } })
              return true
            }
            return false
          }
        })
      ]
    })
    this.view = new EditorView({ state, parent })
  }

  setMode(mode: 'live' | 'source') {
    this.view.dispatch({ effects: this.modeConf.reconfigure(livePreview(this.opts.host, mode === 'live')) })
  }

  configure(o: { lineNumbers: boolean; vim: boolean; spellcheck: boolean }) {
    this.view.dispatch({
      effects: [
        this.lineNumConf.reconfigure(o.lineNumbers ? [lineNumbers(), foldGutter()] : []),
        this.vimConf.reconfigure(o.vim ? vim() : []),
        this.spellConf.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(o.spellcheck) }))
      ]
    })
  }

  /** Replaces the document without firing onChange (used for external edits). */
  setDoc(text: string) {
    if (text === this.view.state.doc.toString()) return
    const head = Math.min(this.view.state.selection.main.head, text.length)
    this.silent = true
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, selection: { anchor: head } })
    this.silent = false
  }

  /** Re-runs decorations, e.g. after the file list changed so link resolution differs. */
  refresh() {
    this.view.dispatch({ effects: refreshEffect.of(null) })
  }

  scrollToLine(line: number, select = true) {
    const l = this.view.state.doc.line(Math.min(Math.max(line + 1, 1), this.view.state.doc.lines))
    this.view.dispatch({
      selection: select ? { anchor: l.from } : undefined,
      effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 60 })
    })
  }

  insertAtCursor(text: string) {
    const { from, to } = this.view.state.selection.main
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    this.view.focus()
  }

  focus() {
    this.view.focus()
  }

  destroy() {
    this.view.destroy()
  }
}
