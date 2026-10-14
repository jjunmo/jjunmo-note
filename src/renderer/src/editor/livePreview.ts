import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateEffect, type EditorState, type Range } from "@codemirror/state"

// Dispatch to force decorations to rebuild (e.g. link targets changed).
export const refreshEffect = StateEffect.define<null>()
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import katex from 'katex'
import { splitWikiTarget } from '../core/parse'

export interface LivePreviewHost {
  resolveLink(target: string): string | null
  imageUrl(target: string): string | null
  openLink(target: string, subpath: string, newTab: boolean): void
  openTag(tag: string): void
}

const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g
const TAG_RE = /(^|[\s(\[,;])(#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu
const HIGHLIGHT_RE = /==([^=\n]+)==/g
const MATH_RE = /(?<![\\$])\$([^$\s](?:[^$\n]*[^$\s])?)\$(?!\$)/g

// ---------- widgets ----------

class LinkWidget extends WidgetType {
  constructor(readonly label: string, readonly target: string, readonly subpath: string, readonly unresolved: boolean) {
    super()
  }
  eq(o: LinkWidget) {
    return o.label === this.label && o.target === this.target && o.subpath === this.subpath && o.unresolved === this.unresolved
  }
  toDOM() {
    const a = document.createElement('span')
    a.className = 'cm-wikilink-widget' + (this.unresolved ? ' is-unresolved' : '')
    a.textContent = this.label
    a.dataset.href = this.target
    a.dataset.subpath = this.subpath
    return a
  }
  ignoreEvent() {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width: number | null) {
    super()
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.width === this.width
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image-widget'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    if (this.width) img.width = this.width
    wrap.appendChild(img)
    return wrap
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super()
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'task-list-item-checkbox'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent() {
    return true
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-list-bullet'
    s.textContent = '•'
    return s
  }
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super()
  }
  eq(o: MathWidget) {
    return o.tex === this.tex
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-math-widget'
    s.innerHTML = katex.renderToString(this.tex, { throwOnError: false })
    return s
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-hr-widget'
    return s
  }
}

const hidden = Decoration.replace({})

function touches(state: EditorState, from: number, to: number) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true
  return false
}

function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let i = a; i <= b; i++) set.add(i)
  }
  return set
}

function build(view: EditorView, host: LivePreviewHost, live: boolean): DecorationSet {
  const { state } = view
  const decos: Range<Decoration>[] = []
  const active = activeLines(state)
  const focused = view.hasFocus

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const line = state.doc.lineAt(node.from)
        const lineActive = focused && active.has(line.number)

        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) {
          decos.push(Decoration.line({ class: `cm-heading cm-h${heading[1]}` }).range(line.from))
          return
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            const l = state.doc.line(n)
            const cls = n === first ? 'cm-codeblock cm-codeblock-begin' : n === last ? 'cm-codeblock cm-codeblock-end' : 'cm-codeblock'
            decos.push(Decoration.line({ class: cls }).range(l.from))
          }
          if (live) {
            const inside = focused && touches(state, node.from, node.to)
            if (!inside) {
              node.node.getChildren('CodeMark').forEach((m) => decos.push(hidden.range(m.from, m.to)))
              node.node.getChildren('CodeInfo').forEach((m) => decos.push(Decoration.mark({ class: 'cm-codeinfo' }).range(m.from, m.to)))
            }
          }
          return false
        }
        if (name === 'Blockquote') {
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(node.to).number
          const firstText = state.doc.line(first).text
          const callout = /^\s*>\s*\[!([\w-]+)\]/.exec(firstText)
          for (let n = first; n <= last; n++) {
            const cls = callout ? `cm-quote cm-callout cm-callout-${callout[1].toLowerCase()}` : 'cm-quote'
            decos.push(Decoration.line({ class: n === first && callout ? cls + ' cm-callout-title' : cls }).range(state.doc.line(n).from))
          }
          return
        }
        if (!live) return

        switch (name) {
          case 'HeaderMark': {
            if (lineActive) break
            const parent = node.node.parent?.name ?? ''
            if (!parent.startsWith('ATXHeading')) break
            const end = Math.min(node.to + 1, line.to)
            decos.push(hidden.range(node.from, end))
            break
          }
          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const p = node.node.parent!
            if (focused && touches(state, p.from, p.to)) break
            decos.push(hidden.range(node.from, node.to))
            break
          }
          case 'InlineCode': {
            if (focused && touches(state, node.from, node.to)) break
            node.node.getChildren('CodeMark').forEach((m) => decos.push(hidden.range(m.from, m.to)))
            break
          }
          case 'Link': {
            if (focused && touches(state, node.from, node.to)) break
            const marks = node.node.getChildren('LinkMark')
            const url = node.node.getChild('URL')
            if (marks.length >= 2 && url) {
              decos.push(hidden.range(marks[0].from, marks[0].to))
              decos.push(Decoration.mark({ class: 'cm-md-link', attributes: { 'data-url': state.sliceDoc(url.from, url.to) } }).range(marks[0].to, marks[1].from))
              decos.push(hidden.range(marks[1].from, node.to))
            }
            return false
          }
          case 'Image': {
            if (focused && touches(state, node.from, node.to)) break
            const url = node.node.getChild('URL')
            if (!url) break
            const src = host.imageUrl(state.sliceDoc(url.from, url.to))
            if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src, '', null) }).range(node.from, node.to))
            return false
          }
          case 'TaskMarker': {
            const checked = /x/i.test(state.sliceDoc(node.from, node.to))
            if (lineActive && touches(state, node.from, node.to)) break
            decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to))
            if (checked) decos.push(Decoration.line({ class: 'cm-task-done' }).range(line.from))
            break
          }
          case 'ListMark': {
            const text = state.sliceDoc(node.from, node.to)
            if (!/^[-*+]$/.test(text)) break
            const after = state.sliceDoc(node.to, node.to + 4)
            if (/^ \[[ xX]\]/.test(after)) {
              // Task bullets: hide the dash, checkbox replaces the marker.
              if (!lineActive) decos.push(hidden.range(node.from, node.to + 1))
              break
            }
            if (lineActive && touches(state, node.from, node.to)) break
            decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
            break
          }
          case 'QuoteMark': {
            if (lineActive) break
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            decos.push(hidden.range(node.from, end))
            break
          }
          case 'HorizontalRule': {
            if (lineActive) break
            decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to))
            break
          }
        }
      }
    })

    // Regex-driven syntax that the markdown grammar does not know about.
    const startLine = state.doc.lineAt(from).number
    const endLine = state.doc.lineAt(to).number
    const tree = syntaxTree(state)
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)
      const text = line.text
      const inCode = (pos: number) => {
        const nodeName = tree.resolveInner(pos, 1).name
        return /Code|CodeText|CodeInfo|FencedCode/.test(nodeName)
      }

      WIKI_RE.lastIndex = 0
      for (let m; (m = WIKI_RE.exec(text)); ) {
        const start = line.from + m.index
        const end = start + m[0].length
        if (inCode(start)) continue
        const { target, subpath, alias } = splitWikiTarget(m[2])
        const editing = !live || (focused && touches(state, start, end))
        const embed = m[1] === '!'
        if (!editing && embed) {
          const src = host.imageUrl(target)
          if (src) {
            const width = alias && /^\d+$/.test(alias) ? Number(alias) : null
            decos.push(Decoration.replace({ widget: new ImageWidget(src, target, width) }).range(start, end))
            continue
          }
        }
        if (!editing) {
          const label = alias ?? (target ? target + (subpath ? ' > ' + subpath.slice(1) : '') : subpath.slice(1))
          const unresolved = !!target && !host.resolveLink(target)
          decos.push(Decoration.replace({ widget: new LinkWidget(label, target, subpath, unresolved) }).range(start, end))
        } else {
          decos.push(
            Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-href': target, 'data-subpath': subpath } }).range(start, end)
          )
        }
      }

      TAG_RE.lastIndex = 0
      for (let m; (m = TAG_RE.exec(text)); ) {
        const start = line.from + m.index + m[1].length
        if (inCode(start)) continue
        if (/^#{1,6}\s/.test(text) && m.index === 0) continue
        decos.push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': m[2].slice(1) } }).range(start, start + m[2].length))
      }

      HIGHLIGHT_RE.lastIndex = 0
      for (let m; (m = HIGHLIGHT_RE.exec(text)); ) {
        const start = line.from + m.index
        const end = start + m[0].length
        if (inCode(start)) continue
        const editing = !live || (focused && touches(state, start, end))
        if (!editing) decos.push(hidden.range(start, start + 2))
        decos.push(Decoration.mark({ class: 'cm-highlight' }).range(start + 2, end - 2))
        if (!editing) decos.push(hidden.range(end - 2, end))
      }

      if (live) {
        MATH_RE.lastIndex = 0
        for (let m; (m = MATH_RE.exec(text)); ) {
          const start = line.from + m.index
          const end = start + m[0].length
          if (inCode(start) || (focused && touches(state, start, end))) continue
          decos.push(Decoration.replace({ widget: new MathWidget(m[1]) }).range(start, end))
        }
      }
    }
  }

  // RangeSetBuilder needs sorted input; line decorations must precede marks at equal positions.
  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  const builder = new RangeSetBuilder<Decoration>()
  let replacedTo = -1
  for (const d of decos) {
    const isReplace = d.value.point && d.from !== d.to
    // Replacements may not overlap; the earliest one wins.
    if (isReplace && d.from < replacedTo) continue
    builder.add(d.from, d.to, d.value)
    if (isReplace) replacedTo = d.to
  }
  return builder.finish()
}

export function livePreview(host: LivePreviewHost, live: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, host, live)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect))))
          this.decorations = build(u.view, host, live)
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e: MouseEvent) {
          const el = e.target as HTMLElement
          const link = el.closest<HTMLElement>('.cm-wikilink-widget')
          if (link) {
            e.preventDefault()
            host.openLink(link.dataset.href ?? '', link.dataset.subpath ?? '', e.metaKey || e.ctrlKey)
            return true
          }
          const mdLink = el.closest<HTMLElement>('.cm-md-link')
          if (mdLink && (e.metaKey || e.ctrlKey || live)) {
            const url = mdLink.dataset.url ?? ''
            e.preventDefault()
            if (/^[a-z][a-z0-9+.-]*:/i.test(url)) window.jj.openExternal(url)
            else {
              const hash = url.indexOf('#')
              host.openLink(decodeURIComponent(hash >= 0 ? url.slice(0, hash) : url), hash >= 0 ? url.slice(hash) : '', e.metaKey || e.ctrlKey)
            }
            return true
          }
          if (e.metaKey || e.ctrlKey) {
            const wl = el.closest<HTMLElement>('.cm-wikilink')
            if (wl) {
              e.preventDefault()
              host.openLink(wl.dataset.href ?? '', wl.dataset.subpath ?? '', true)
              return true
            }
            const tag = el.closest<HTMLElement>('.cm-tag')
            if (tag) {
              e.preventDefault()
              host.openTag(tag.dataset.tag ?? '')
              return true
            }
          }
          return false
        }
      }
    }
  )
}
