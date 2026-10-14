import { h, icon } from './dom'

export interface MenuItem {
  title: string
  icon?: string
  danger?: boolean
  onClick: () => void
}

let current: HTMLElement | null = null

function closeMenu() {
  current?.remove()
  current = null
  document.removeEventListener('mousedown', onOutside, true)
  document.removeEventListener('keydown', onKey, true)
}

function onOutside(e: MouseEvent) {
  if (current && !current.contains(e.target as Node)) closeMenu()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu()
}

/** Shows a context menu at the mouse position. `null` entries render separators. */
export function showMenu(e: { clientX: number; clientY: number }, items: (MenuItem | null)[]) {
  closeMenu()
  const menu = h('div', { class: 'menu' })
  for (const item of items) {
    if (!item) {
      menu.append(h('div', { class: 'menu-separator' }))
      continue
    }
    menu.append(
      h(
        'div',
        {
          class: 'menu-item' + (item.danger ? ' is-danger' : ''),
          onclick: () => {
            closeMenu()
            item.onClick()
          }
        },
        item.icon ? icon(item.icon, 14) : h('span', { class: 'menu-item-icon-space' }),
        h('span', {}, item.title)
      )
    )
  }
  document.body.appendChild(menu)
  const { innerWidth, innerHeight } = window
  const rect = menu.getBoundingClientRect()
  menu.style.left = Math.min(e.clientX, innerWidth - rect.width - 8) + 'px'
  menu.style.top = Math.min(e.clientY, innerHeight - rect.height - 8) + 'px'
  current = menu
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  })
}
