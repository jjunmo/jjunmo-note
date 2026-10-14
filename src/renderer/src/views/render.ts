import markdownIt, { type MarkdownIt, type StateInline, type StateBlock } from 'markdown-it'
import katex from 'katex'
import hljs from 'highlight.js/lib/common'
import { Vault, IMAGE_EXT, isMarkdown } from '../core/vault'
import { frontmatterRange, parseFrontmatter, splitWikiTarget } from '../core/parse'
import { VAULT_PROTOCOL } from '../../../shared/api'

export const vaultUrl = (path: string) => `${VAULT_PROTOCOL}://vault/${path.split('/').map(encodeURIComponent).join('/')}`

export interface RenderContext {
  vault: Vault
  sourcePath: string
  depth?: number
  onToggleTask?: (line: number, checked: boolean) => void
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// ---------- markdown-it plugins ----------

function wikilinks(md: MarkdownIt) {
  md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
    const src = state.src
    let pos = state.pos
    const embed = src.charCodeAt(pos) === 0x21 /* ! */
    if (embed) pos++
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false
    const end = src.indexOf(']]', pos + 2)
    if (end < 0) return false
    const inner = src.slice(pos + 2, end)
    if (!inner || inner.includes('\n') || inner.includes('[')) return false
    if (!silent) {
      const token = state.push(embed ? 'wikiembed' : 'wikilink', '', 0)
      token.content = inner
    }
    state.pos = end + 2
    return true
  })
}

function tags(md: MarkdownIt) {
  md.inline.ruler.push('hashtag', (state: StateInline, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x23) return false
    const prev = state.pos > 0 ? state.src[state.pos - 1] : ' '
    if (!/[\s(\[,;]/.test(prev)) return false
    const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(state.src.slice(state.pos))
    if (!m) return false
    if (!silent) state.push('hashtag', '', 0).content = m[1]
    state.pos += m[0].length
    return true
  })
}

function highlightMark(md: MarkdownIt) {
  md.inline.ruler.before('emphasis', 'mark', (state: StateInline, silent: boolean) => {
    if (!state.src.startsWith('==', state.pos)) return false
    const end = state.src.indexOf('==', state.pos + 2)
    if (end < 0 || end === state.pos + 2) return false
    if (!silent) {
      state.push('mark_open', 'mark', 1)
      const oldMax = state.posMax
      state.pos += 2
      state.posMax = end
      state.md.inline.tokenize(state)
      state.posMax = oldMax
      state.push('mark_close', 'mark', -1)
    }
    state.pos = end + 2
    return true
  })
}

function comments(md: MarkdownIt) {
  md.inline.ruler.before('emphasis', 'percent_comment', (state: StateInline) => {
    if (!state.src.startsWith('%%', state.pos)) return false
    const end = state.src.indexOf('%%', state.pos + 2)
    if (end < 0) return false
    state.pos = end + 2
    return true
  })
}

function math(md: MarkdownIt) {
  md.inline.ruler.after('escape', 'math_inline', (state: StateInline, silent: boolean) => {
    if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false
    const end = state.src.indexOf('$', state.pos + 1)
    if (end < 0) return false
    const content = state.src.slice(state.pos + 1, end)
    if (!content.trim() || /^\s|\s$/.test(content)) return false
    if (!silent) state.push('math_inline', '', 0).content = content
    state.pos = end + 1
    return true
  })
  md.block.ruler.after('blockquote', 'math_block', (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    if (!state.src.startsWith('$$', start)) return false
    const firstLine = state.src.slice(start + 2, state.eMarks[startLine])
    if (silent) return true
    let content = ''
    let next = startLine
    if (firstLine.trim().endsWith('$$') && firstLine.trim().length > 2) {
      content = firstLine.trim().slice(0, -2)
    } else {
      content = firstLine
      for (next = startLine + 1; next < endLine; next++) {
        const line = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next])
        if (line.trim().endsWith('$$')) {
          content += '\n' + line.trim().slice(0, -2)
          break
        }
        content += '\n' + line
      }
    }
    state.line = next + 1
    const token = state.push('math_block', '', 0)
    token.content = content
    token.map = [startLine, state.line]
    return true
  })
}

/** Adds data-line to block tokens so tasks and headings can map back to source lines. */
function sourceLines(md: MarkdownIt, offset: () => number) {
  md.core.ruler.push('source_lines', (state) => {
    for (const t of state.tokens) if (t.map && t.nesting === 1) t.attrSet('data-line', String(t.map[0] + offset()))
  })
}

// ---------- renderer ----------

export function createRenderer(ctx: () => RenderContext) {
  let lineOffset = 0
  const md: MarkdownIt = markdownIt({
    html: true,
    linkify: true,
    breaks: true,
    highlight: (code, lang) => {
      if (lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(code)}</pre>`
      try {
        if (lang && hljs.getLanguage(lang)) return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`
      } catch {}
      return ''
    }
  })
  md.use(wikilinks).use(tags).use(highlightMark).use(comments).use(math)
  sourceLines(md, () => lineOffset)

  md.renderer.rules.wikilink = (tokens, idx) => {
    const { target, subpath, alias } = splitWikiTarget(tokens[idx].content)
    const c = ctx()
    const resolved = target ? c.vault.resolve(target, c.sourcePath) : c.sourcePath
    const label = alias ?? (target ? target + (subpath ? ' > ' + subpath.slice(1) : '') : subpath.slice(1))
    const cls = resolved ? 'internal-link' : 'internal-link is-unresolved'
    return `<a class="${cls}" data-href="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath)}" href="#">${escapeHtml(label)}</a>`
  }
  md.renderer.rules.wikiembed = (tokens, idx) => {
    const { target, subpath, alias } = splitWikiTarget(tokens[idx].content)
    return `<span class="internal-embed" data-href="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath)}" data-alias="${escapeHtml(alias ?? '')}"></span>`
  }
  md.renderer.rules.hashtag = (tokens, idx) => {
    const t = escapeHtml(tokens[idx].content)
    return `<a class="tag" data-tag="${t}" href="#">#${t}</a>`
  }
  md.renderer.rules.math_inline = (tokens, idx) => katexHtml(tokens[idx].content, false)
  md.renderer.rules.math_block = (tokens, idx) => `<div class="math-block">${katexHtml(tokens[idx].content, true)}</div>`

  // Relative markdown links/images to vault files.
  const defaultImage = md.renderer.rules.image!
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx]
    const src = String(token.attrGet('src') ?? '')
    if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      const c = ctx()
      const resolved = c.vault.resolve(safeDecode(src), c.sourcePath)
      if (resolved) token.attrSet('src', vaultUrl(resolved))
    }
    return defaultImage(tokens, idx, opts, env, self)
  }
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o))
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const token = tokens[idx]
    const href = String(token.attrGet('href') ?? '')
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
      const decoded = safeDecode(href)
      const hash = decoded.indexOf('#')
      token.attrSet('data-href', hash >= 0 ? decoded.slice(0, hash) : decoded)
      token.attrSet('data-subpath', hash >= 0 ? decoded.slice(hash) : '')
      token.attrSet('class', 'internal-link')
      token.attrSet('href', '#')
    } else if (/^https?:/i.test(href)) {
      token.attrSet('class', 'external-link')
    }
    return defaultLinkOpen(tokens, idx, opts, env, self)
  }

  return {
    /** Renders markdown into `el`, returning the element. */
    render(text: string, el: HTMLElement): HTMLElement {
      const c = ctx()
      el.innerHTML = ''
      let body = text
      const fm = frontmatterRange(text)
      lineOffset = 0
      if (fm) {
        const props = parseFrontmatter(fm.body)
        if (Object.keys(props).length && (c.depth ?? 0) === 0) el.appendChild(renderProperties(props))
        body = text.slice(fm.endOffset)
        lineOffset = fm.end
      }
      const html = md.render(body)
      const container = document.createElement('div')
      container.className = 'markdown-rendered-body'
      container.innerHTML = html
      el.appendChild(container)
      postProcess(container, c, this)
      return el
    },
    md
  }
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function katexHtml(tex: string, display: boolean) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false })
  } catch (err) {
    return `<span class="math-error">${escapeHtml(String(err))}</span>`
  }
}

function renderProperties(props: Record<string, unknown>): HTMLElement {
  const box = document.createElement('div')
  box.className = 'metadata-properties'
  for (const [k, v] of Object.entries(props)) {
    const row = document.createElement('div')
    row.className = 'metadata-property'
    const key = document.createElement('div')
    key.className = 'metadata-key'
    key.textContent = k
    const val = document.createElement('div')
    val.className = 'metadata-value'
    const list = Array.isArray(v) ? v : [v]
    for (const item of list) {
      const pill = document.createElement('span')
      pill.className = Array.isArray(v) ? 'metadata-pill' : ''
      pill.textContent = item == null ? '' : String(item)
      val.appendChild(pill)
    }
    row.append(key, val)
    box.appendChild(row)
  }
  return box
}

let mermaidLoaded: Promise<typeof import('mermaid').default> | null = null
let mermaidId = 0

function postProcess(root: HTMLElement, ctx: RenderContext, renderer: { render(text: string, el: HTMLElement): HTMLElement }) {
  // Callouts: > [!type] Title
  for (const bq of root.querySelectorAll<HTMLElement>('blockquote')) {
    const first = bq.firstElementChild
    if (!first || first.tagName !== 'P') continue
    const m = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/m.exec(first.innerHTML.split('<br>')[0].trim())
    if (!m) continue
    const [, type, fold, title] = m
    const callout = document.createElement('div')
    callout.className = `callout callout-${type.toLowerCase()}`
    callout.dataset.callout = type.toLowerCase()
    const titleEl = document.createElement('div')
    titleEl.className = 'callout-title'
    titleEl.innerHTML = `<span class="callout-icon"></span><span>${title || type.charAt(0).toUpperCase() + type.slice(1)}</span>`
    const content = document.createElement('div')
    content.className = 'callout-content'
    const rest = first.innerHTML.split('<br>').slice(1).join('<br>').trim()
    if (rest) {
      const p = document.createElement('p')
      p.innerHTML = rest
      content.appendChild(p)
    }
    for (const child of [...bq.children].slice(1)) content.appendChild(child)
    callout.append(titleEl, content)
    if (fold) {
      callout.classList.add('is-collapsible')
      if (fold === '-') callout.classList.add('is-collapsed')
      titleEl.addEventListener('click', () => callout.classList.toggle('is-collapsed'))
    }
    bq.replaceWith(callout)
  }

  // Task list items.
  for (const li of root.querySelectorAll<HTMLElement>('li')) {
    const first = li.firstChild
    const target = first?.nodeType === Node.TEXT_NODE ? first : li.querySelector(':scope > p')?.firstChild
    if (!target || target.nodeType !== Node.TEXT_NODE) continue
    const m = /^\[( |x|X)\]\s?/.exec(target.textContent ?? '')
    if (!m) continue
    target.textContent = (target.textContent ?? '').slice(m[0].length)
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'task-list-item-checkbox'
    box.checked = m[1] !== ' '
    li.classList.add('task-list-item')
    if (box.checked) li.classList.add('is-checked')
    const line = Number(li.dataset.line)
    box.addEventListener('click', (e) => {
      e.stopPropagation()
      if (ctx.onToggleTask && !Number.isNaN(line)) ctx.onToggleTask(line, box.checked)
    })
    li.insertBefore(box, li.firstChild)
  }

  // Embeds.
  for (const span of root.querySelectorAll<HTMLElement>('.internal-embed')) {
    const target = span.dataset.href ?? ''
    const subpath = span.dataset.subpath ?? ''
    const resolved = target ? ctx.vault.resolve(target, ctx.sourcePath) : ctx.sourcePath
    if (!resolved) {
      span.classList.add('is-unresolved')
      span.textContent = `${target} (not found)`
      continue
    }
    if (IMAGE_EXT.test(resolved)) {
      const img = document.createElement('img')
      img.src = vaultUrl(resolved)
      img.alt = span.dataset.alias || target
      const size = /^(\d+)(?:x(\d+))?$/.exec(span.dataset.alias ?? '')
      if (size) {
        img.width = Number(size[1])
        if (size[2]) img.height = Number(size[2])
      }
      span.replaceWith(img)
    } else if (/\.pdf$/i.test(resolved)) {
      const frame = document.createElement('iframe')
      frame.className = 'pdf-embed'
      frame.src = vaultUrl(resolved)
      span.replaceWith(frame)
    } else if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(resolved)) {
      const audio = document.createElement('audio')
      audio.controls = true
      audio.src = vaultUrl(resolved)
      span.replaceWith(audio)
    } else if (/\.(mp4|webm|mov)$/i.test(resolved)) {
      const video = document.createElement('video')
      video.controls = true
      video.src = vaultUrl(resolved)
      span.replaceWith(video)
    } else if (isMarkdown(resolved)) {
      const depth = (ctx.depth ?? 0) + 1
      const box = document.createElement('div')
      box.className = 'markdown-embed'
      const title = document.createElement('div')
      title.className = 'markdown-embed-title'
      title.innerHTML = `<a class="internal-link" data-href="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath)}" href="#">${escapeHtml(Vault.title(resolved))}</a>`
      const content = document.createElement('div')
      content.className = 'markdown-embed-content'
      box.append(title, content)
      span.replaceWith(box)
      if (depth > 3 || resolved === ctx.sourcePath) {
        content.textContent = '(embed depth limit)'
        continue
      }
      const text = sliceSubpath(ctx.vault.text(resolved) ?? '', subpath)
      const nested = createRenderer(() => ({ vault: ctx.vault, sourcePath: resolved, depth }))
      nested.render(text, content)
    } else {
      span.innerHTML = `<a class="internal-link" data-href="${escapeHtml(target)}" href="#">${escapeHtml(target)}</a>`
    }
  }

  // Mermaid diagrams (loaded lazily, it is large).
  const diagrams = root.querySelectorAll<HTMLElement>('pre.mermaid')
  if (diagrams.length) {
    mermaidLoaded ??= import('mermaid').then((m) => {
      const dark = document.body.classList.contains('theme-dark')
      m.default.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' })
      return m.default
    })
    mermaidLoaded.then(async (mermaid) => {
      for (const pre of diagrams) {
        try {
          const { svg } = await mermaid.render(`mmd-${++mermaidId}`, pre.textContent ?? '')
          const div = document.createElement('div')
          div.className = 'mermaid-diagram'
          div.innerHTML = svg
          pre.replaceWith(div)
        } catch (err) {
          pre.classList.add('mermaid-error')
          pre.title = String(err)
        }
      }
    })
  }

  // Open external links in the system browser.
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a.external-link')) a.target = '_blank'
  void renderer
}

/** Returns only the section under a heading (#Heading) or a block (#^id). */
export function sliceSubpath(text: string, subpath: string): string {
  if (!subpath) return text
  const lines = text.split('\n')
  if (subpath.startsWith('#^')) {
    const id = subpath.slice(2)
    const i = lines.findIndex((l) => l.trimEnd().endsWith('^' + id))
    if (i < 0) return text
    // Include the whole paragraph that ends with the block id.
    let s = i
    while (s > 0 && lines[s - 1].trim() !== '') s--
    return lines
      .slice(s, i + 1)
      .join('\n')
      .replace(new RegExp(`\\s*\\^${id}\\s*$`), '')
  }
  const want = subpath.slice(1).trim().toLowerCase()
  const start = lines.findIndex((l) => {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
    return m && m[2].trim().toLowerCase() === want
  })
  if (start < 0) return text
  const level = /^(#{1,6})/.exec(lines[start])![1].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i])
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}
