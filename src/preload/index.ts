import { contextBridge, ipcRenderer } from 'electron'
import type { FsChange, JjApi } from '../shared/api'

const api: JjApi = {
  pickVault: () => ipcRenderer.invoke('vault:pick'),
  createVault: (name) => ipcRenderer.invoke('vault:create', name),
  openVault: (path) => ipcRenderer.invoke('vault:open', path),
  recentVaults: () => ipcRenderer.invoke('vault:recent'),
  forgetVault: (path) => ipcRenderer.invoke('vault:forget', path),

  list: () => ipcRenderer.invoke('fs:list'),
  read: (path) => ipcRenderer.invoke('fs:read', path),
  write: (path, content) => ipcRenderer.invoke('fs:write', path, content),
  writeBinary: (path, data) => ipcRenderer.invoke('fs:writeBinary', path, data),
  mkdir: (path) => ipcRenderer.invoke('fs:mkdir', path),
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
  trash: (path) => ipcRenderer.invoke('fs:trash', path),
  exists: (path) => ipcRenderer.invoke('fs:exists', path),

  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onFsChange: (cb) => {
    const listener = (_e: unknown, changes: FsChange[]) => cb(changes)
    ipcRenderer.on('fs:changed', listener)
    return () => ipcRenderer.removeListener('fs:changed', listener)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('jj', api)
