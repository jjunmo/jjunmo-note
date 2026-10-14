export interface Command {
  id: string
  name: string
  hotkey?: string // e.g. "Mod-Shift-f"
  run: () => void | Promise<void>
  /** Hidden from the palette when this returns false. */
  available?: () => boolean
}

export class CommandRegistry {
  private commands = new Map<string, Command>()

  add(cmd: Command) {
    this.commands.set(cmd.id, cmd)
  }

  list(): Command[] {
    return [...this.commands.values()].filter((c) => !c.available || c.available())
  }

  run(id: string) {
    const cmd = this.commands.get(id)
    if (!cmd || (cmd.available && !cmd.available())) return
    void Promise.resolve(cmd.run()).catch((err) => console.error(`command ${id} failed`, err))
  }

  /** Matches a keyboard event against registered hotkeys. */
  handleKey(e: KeyboardEvent, isMac: boolean): boolean {
    if (e.isComposing) return false
    const mod = isMac ? e.metaKey : e.ctrlKey
    for (const cmd of this.commands.values()) {
      if (!cmd.hotkey) continue
      const parts = cmd.hotkey.split('-')
      const key = parts[parts.length - 1]
      const want = {
        mod: parts.includes('Mod'),
        shift: parts.includes('Shift'),
        alt: parts.includes('Alt'),
        ctrl: parts.includes('Ctrl')
      }
      if (want.mod !== mod || want.shift !== e.shiftKey || want.alt !== e.altKey) continue
      if (isMac && want.ctrl !== e.ctrlKey) continue
      const pressed = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const code = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code.startsWith('Digit') ? e.code.slice(5) : null
      if (pressed !== key.toLowerCase() && code !== key.toLowerCase() && !(key === ',' && e.code === 'Comma') && !(key === '\\' && e.code === 'Backslash')) continue
      if (cmd.available && !cmd.available()) continue
      e.preventDefault()
      e.stopPropagation()
      this.run(cmd.id)
      return true
    }
    return false
  }
}
