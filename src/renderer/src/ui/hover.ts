import { h } from './dom'
import { createRenderer, sliceSubpath } from '../views/render'
import type { App } from '../app'
import { isMarkdown } from '../core/vault'

let popover: HTMLElement | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

function hide() {
  popover?.remove()
  popover = null
}

/** Shows a preview of linked notes when hovering internal links. */
export function attachHoverPreview(app: App, root: HTMLElement, source: () => string) {
  let showTimer: ReturnType<typeof setTimeout> | null = null
  root.addEventListener('mouseover', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('a.internal-link, .cm-wikilink-widget, .cm-wikilink')
    if (!link || popover?.dataset.for === link.dataset.href) return
    if (showTimer) clearTimeout(showTimer)
    showTimer = setTimeout(() => {
      // Live editing links require the modifier key so typing is not interrupted.
      if (link.classList.contains('cm-wikilink') && !(e.metaKey || e.ctrlKey)) return
      show(app, link, source())
    }, 450)
    link.addEventListener(
      'mouseleave',
      () => {
        if (showTimer) clearTimeout(showTimer)
        scheduleHide()
      },
      { once: true }
    )
  })
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(hide, 300)
}

function show(app: App, link: HTMLElement, source: string) {
  const target = link.dataset.href ?? ''
  const subpath = link.dataset.subpath ?? ''
  const resolved = target ? app.vault.resolve(target, source) : source
  if (!resolved || !isMarkdown(resolved)) return
  hide()
  const body = h('div', { class: 'markdown-rendered' })
  const renderer = createRenderer(() => ({ vault: app.vault, sourcePath: resolved, depth: 1 }))
  renderer.render(sliceSubpath(app.vault.text(resolved) ?? '', subpath), body)
  popover = h('div', { class: 'popover hover-popover' }, body)
  popover.dataset.for = target
  popover.addEventListener('mouseenter', () => hideTimer && clearTimeout(hideTimer))
  popover.addEventListener('mouseleave', scheduleHide)
  popover.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a.internal-link')
    if (a) {
      e.preventDefault()
      hide()
      app.openLink(a.dataset.href ?? '', resolved, a.dataset.subpath ?? '', e.metaKey || e.ctrlKey)
    }
  })
  document.body.appendChild(popover)
  const r = link.getBoundingClientRect()
  const pw = 460
  const ph = 380
  let left = Math.min(r.left, window.innerWidth - pw - 12)
  let top = r.bottom + 6
  if (top + ph > window.innerHeight) top = Math.max(8, r.top - ph - 6)
  popover.style.left = Math.max(8, left) + 'px'
  popover.style.top = top + 'px'
}
