import 'katex/dist/katex.min.css'
import './styles/app.css'
import { App } from './app'
import { h, icon } from './ui/dom'
import type { JjApi, VaultInfo } from '../../shared/api'

declare global {
  interface Window {
    jj: JjApi
  }
}

const root = document.getElementById('app')!
document.body.classList.add('theme-dark', window.jj.platform === 'darwin' ? 'is-mac' : 'is-other')

async function open(info: VaultInfo | string | null) {
  if (!info) return
  const path = typeof info === 'string' ? info : info.path
  try {
    root.replaceChildren(h('div', { class: 'loading' }, 'Loading vault…'))
    await App.boot(root, path)
  } catch (err) {
    console.error(err)
    localStorage.removeItem('lastVault')
    await startScreen(`Could not open vault: ${(err as Error).message ?? err}`)
  }
}

async function startScreen(error?: string) {
  const recent = await window.jj.recentVaults()
  const list = h('div', { class: 'vault-list' })
  for (const v of recent) {
    const row = h(
      'div',
      { class: 'vault-list-item', onclick: () => open(v) },
      h('div', { class: 'vault-list-item-title' }, v.name),
      h('div', { class: 'vault-list-item-path' }, v.path)
    )
    const forget = h('button', { class: 'icon-button vault-forget', title: 'Remove from list' }, icon('x', 14))
    forget.addEventListener('click', async (e) => {
      e.stopPropagation()
      await window.jj.forgetVault(v.path)
      row.remove()
    })
    row.append(forget)
    list.append(row)
  }
  const nameInput = h('input', { type: 'text', placeholder: 'Vault name', value: 'My vault', class: 'prompt-input' })
  root.replaceChildren(
    h(
      'div',
      { class: 'starter' },
      recent.length ? h('div', { class: 'starter-recent' }, h('div', { class: 'starter-heading' }, 'Recent vaults'), list) : null,
      h(
        'div',
        { class: 'starter-main' },
        h('div', { class: 'starter-logo' }, 'jjunmo note'),
        h('div', { class: 'starter-version' }, 'Local-first markdown knowledge base'),
        error ? h('div', { class: 'starter-error' }, error) : null,
        h(
          'div',
          { class: 'starter-action' },
          h('div', {}, h('div', { class: 'starter-action-title' }, 'Create new vault'), h('div', { class: 'starter-action-desc' }, 'Create a new folder of notes.')),
          h('div', { class: 'starter-create' }, nameInput, h('button', { class: 'mod-cta', onclick: async () => open(await window.jj.createVault(nameInput.value.trim() || 'My vault')) }, 'Create'))
        ),
        h(
          'div',
          { class: 'starter-action' },
          h('div', {}, h('div', { class: 'starter-action-title' }, 'Open folder as vault'), h('div', { class: 'starter-action-desc' }, 'Choose an existing folder of markdown files. Wikilink-based vaults work as-is.')),
          h('button', { onclick: async () => open(await window.jj.pickVault()) }, 'Open')
        )
      )
    )
  )
}

const last = localStorage.getItem('lastVault')
if (last) void open(last)
else void startScreen()
