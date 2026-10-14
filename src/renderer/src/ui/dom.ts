import {
  createElement,
  FileText,
  Folder,
  FolderOpen,
  Search,
  Tags,
  Bookmark,
  Link,
  ListTree,
  Network,
  Calendar,
  Settings,
  Command,
  PanelLeft,
  PanelRight,
  Plus,
  FolderPlus,
  X,
  BookOpen,
  Pencil,
  Code,
  MoreHorizontal,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
  Columns2,
  Trash2,
  Star,
  FilePlus,
  ChevronsDownUp,
  Image,
  Hash,
  FileStack,
  Link2Off,
  LayoutTemplate,
  Shuffle,
  type IconNode
} from 'lucide'

const ICONS: Record<string, IconNode> = {
  file: FileText,
  folder: Folder,
  'folder-open': FolderOpen,
  search: Search,
  tags: Tags,
  bookmark: Bookmark,
  link: Link,
  'link-off': Link2Off,
  outline: ListTree,
  graph: Network,
  calendar: Calendar,
  settings: Settings,
  command: Command,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  plus: Plus,
  'folder-plus': FolderPlus,
  x: X,
  reading: BookOpen,
  edit: Pencil,
  source: Code,
  more: MoreHorizontal,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  back: ArrowLeft,
  forward: ArrowRight,
  split: Columns2,
  trash: Trash2,
  star: Star,
  'file-plus': FilePlus,
  collapse: ChevronsDownUp,
  image: Image,
  hash: Hash,
  files: FileStack,
  template: LayoutTemplate,
  random: Shuffle
}

export function icon(name: string, size = 16): SVGElement {
  const node = ICONS[name] ?? FileText
  const svg = createElement(node) as unknown as SVGElement
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.classList.add('icon')
  return svg
}

type Child = Node | string | null | undefined | false
type Attrs = Record<string, unknown> & { class?: string; onclick?: (e: MouseEvent) => void }

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = String(v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k in el && typeof v !== 'string') (el as any)[k] = v
    else el.setAttribute(k, String(v))
  }
  for (const c of children) if (c != null && c !== false) el.append(c)
  return el
}

export function iconButton(name: string, label: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `icon-button ${cls}`, 'aria-label': label, title: label, onclick }, icon(name))
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

/** Wraps matched character indices in <mark>. */
export function highlightMatches(text: string, matches: number[]): DocumentFragment {
  const frag = document.createDocumentFragment()
  const set = new Set(matches)
  let buf = ''
  let inMark = false
  const flush = () => {
    if (!buf) return
    frag.append(inMark ? h('mark', {}, buf) : buf)
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (m !== inMark) {
      flush()
      inMark = m
    }
    buf += text[i]
  }
  flush()
  return frag
}

export const isMac = () => window.jj.platform === 'darwin'

export function formatHotkey(key: string): string {
  if (!key) return ''
  return key
    .split('-')
    .map((p) => {
      if (p === 'Mod') return isMac() ? '⌘' : 'Ctrl'
      if (p === 'Shift') return isMac() ? '⇧' : 'Shift'
      if (p === 'Alt') return isMac() ? '⌥' : 'Alt'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join(isMac() ? '' : '+')
}
