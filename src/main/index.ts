import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { join, resolve, relative, sep, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FileEntry, FsChange, VaultInfo } from '../shared/api'
import { VAULT_PROTOCOL } from '../shared/api'

// Lets tests run against an isolated profile.
if (process.env.JJNOTE_USER_DATA) app.setPath('userData', process.env.JJNOTE_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: VAULT_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const IGNORED = new Set(['.git', 'node_modules', '.trash', '.DS_Store'])

let win: BrowserWindow | null = null
let vaultRoot: string | null = null
let watcher: FSWatcher | null = null

// ---------- recent vaults ----------
const recentFile = () => join(app.getPath('userData'), 'vaults.json')

async function loadRecent(): Promise<VaultInfo[]> {
  try {
    return JSON.parse(await fs.readFile(recentFile(), 'utf8'))
  } catch {
    return []
  }
}

async function saveRecent(list: VaultInfo[]) {
  await fs.mkdir(dirname(recentFile()), { recursive: true })
  await fs.writeFile(recentFile(), JSON.stringify(list.slice(0, 20), null, 2))
}

async function rememberVault(info: VaultInfo) {
  const list = (await loadRecent()).filter((v) => v.path !== info.path)
  await saveRecent([info, ...list])
}

// ---------- path safety ----------
function abs(rel: string): string {
  if (!vaultRoot) throw new Error('No vault is open')
  const target = resolve(vaultRoot, rel)
  const back = relative(vaultRoot, target)
  if (back.startsWith('..') || resolve(back) === back) throw new Error(`Path escapes vault: ${rel}`)
  return target
}

const toPosix = (p: string) => p.split(sep).join('/')

async function walk(dir: string, out: FileEntry[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (IGNORED.has(e.name) || (e.name.startsWith('.') && e.name !== '.jjnote')) continue
    if (e.name === '.jjnote') continue
    const full = join(dir, e.name)
    const st = await fs.stat(full).catch(() => null)
    if (!st) continue
    const path = toPosix(relative(vaultRoot!, full))
    if (st.isDirectory()) {
      out.push({ path, type: 'folder', mtime: st.mtimeMs, size: 0 })
      await walk(full, out)
    } else {
      out.push({ path, type: 'file', mtime: st.mtimeMs, size: st.size })
    }
  }
}

// ---------- watching ----------
let pending: FsChange[] = []
let flushTimer: NodeJS.Timeout | null = null

function startWatch() {
  watcher?.close()
  if (!vaultRoot) return
  try {
    watcher = watch(vaultRoot, { recursive: true }, (kind, filename) => {
      if (!filename) return
      const path = toPosix(filename.toString())
      if (path.split('/').some((seg) => IGNORED.has(seg) || seg.startsWith('.'))) return
      pending.push({ kind: kind as FsChange['kind'], path })
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(() => {
        win?.webContents.send('fs:changed', pending)
        pending = []
      }, 150)
    })
  } catch (err) {
    console.error('watch failed', err)
  }
}

async function openVault(path: string): Promise<VaultInfo> {
  const st = await fs.stat(path)
  if (!st.isDirectory()) throw new Error('Vault must be a folder')
  vaultRoot = path
  await fs.mkdir(join(path, '.jjnote'), { recursive: true })
  const info = { path, name: basename(path) }
  await rememberVault(info)
  startWatch()
  win?.setTitle(`${info.name} - jjunmo note`)
  return info
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('vault:pick', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    return openVault(res.filePaths[0])
  })
  ipcMain.handle('vault:create', async (_e, name: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose where to create the vault',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    const target = join(res.filePaths[0], name.replace(/[\\/:*?"<>|]/g, '-'))
    await fs.mkdir(target, { recursive: true })
    const welcome = join(target, 'Welcome.md')
    await fs.writeFile(welcome, WELCOME, { flag: 'wx' }).catch(() => {})
    return openVault(target)
  })
  ipcMain.handle('vault:open', (_e, path: string) => openVault(path))
  ipcMain.handle('vault:recent', () => loadRecent())
  ipcMain.handle('vault:forget', async (_e, path: string) => {
    await saveRecent((await loadRecent()).filter((v) => v.path !== path))
  })

  ipcMain.handle('fs:list', async () => {
    const out: FileEntry[] = []
    await walk(vaultRoot!, out)
    return out
  })
  ipcMain.handle('fs:read', (_e, p: string) => fs.readFile(abs(p), 'utf8'))
  ipcMain.handle('fs:write', async (_e, p: string, content: string) => {
    const target = abs(p)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  })
  ipcMain.handle('fs:writeBinary', async (_e, p: string, data: ArrayBuffer) => {
    const target = abs(p)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, Buffer.from(data))
  })
  ipcMain.handle('fs:mkdir', (_e, p: string) => fs.mkdir(abs(p), { recursive: true }))
  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    const target = abs(to)
    await fs.mkdir(dirname(target), { recursive: true })
    try {
      await fs.access(target)
      if (from.toLowerCase() !== to.toLowerCase()) throw new Error(`"${to}" already exists`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await fs.rename(abs(from), target)
  })
  ipcMain.handle('fs:trash', (_e, p: string) => shell.trashItem(abs(p)))
  ipcMain.handle('fs:exists', async (_e, p: string) => {
    try {
      await fs.access(abs(p))
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(abs(p)))
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url)
    return shell.openPath(abs(url))
  })
}

// Keep the menu small so Cmd+W / Cmd+P / Cmd+O / Cmd+N reach the renderer.
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' as const }] : [{ role: 'quit' as const }])] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'jjunmo note',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win?.show())

  // External links open in the browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  protocol.handle(VAULT_PROTOCOL, (req) => {
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    try {
      return net.fetch(pathToFileURL(abs(rel)).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  watcher?.close()
  if (process.platform !== 'darwin') app.quit()
})

const WELCOME = `# Welcome to jjunmo note

This is your new vault. Every note is a plain markdown file in this folder.

## Try it
- Link notes with [[wikilinks]] — type \`[[\` for suggestions
- Open the **quick switcher** with \`Cmd/Ctrl + O\`
- Open the **command palette** with \`Cmd/Ctrl + P\`
- Search everything with \`Cmd/Ctrl + Shift + F\`
- See how notes connect in the **graph view** (\`Cmd/Ctrl + G\`)
- Toggle reading view with \`Cmd/Ctrl + E\`

> [!tip] Tags
> Add #tags anywhere and browse them in the Tags panel.

- [ ] Create your first note
- [ ] Link it back to [[Welcome]]
`
