// Contract between the preload bridge and the renderer. All paths are
// vault-relative and use forward slashes.

export interface FileEntry {
  path: string
  type: 'file' | 'folder'
  mtime: number
  size: number
}

export interface FsChange {
  kind: 'change' | 'rename'
  path: string
}

export interface VaultInfo {
  path: string
  name: string
}

export interface JjApi {
  pickVault(): Promise<VaultInfo | null>
  createVault(name: string): Promise<VaultInfo | null>
  openVault(path: string): Promise<VaultInfo>
  recentVaults(): Promise<VaultInfo[]>
  forgetVault(path: string): Promise<void>

  list(): Promise<FileEntry[]>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  writeBinary(path: string, data: ArrayBuffer): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  trash(path: string): Promise<void>
  exists(path: string): Promise<boolean>

  reveal(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  onFsChange(cb: (changes: FsChange[]) => void): () => void
  platform: string
}

// Custom protocol used to serve vault files (images, pdf) to the renderer.
export const VAULT_PROTOCOL = 'jjvault'
