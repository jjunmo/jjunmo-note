export type ViewMode = 'live' | 'source' | 'reading'
export type Theme = 'dark' | 'light' | 'system'

export interface Settings {
  theme: Theme
  accent: string
  fontSize: number
  readableLineLength: boolean
  defaultViewMode: ViewMode
  showLineNumbers: boolean
  spellcheck: boolean
  vimMode: boolean
  newNoteFolder: string
  attachmentFolder: string
  dailyNoteFolder: string
  dailyNoteFormat: string
  dailyNoteTemplate: string
  templateFolder: string
  bookmarks: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#8b6cef',
  fontSize: 16,
  readableLineLength: true,
  defaultViewMode: 'live',
  showLineNumbers: false,
  spellcheck: false,
  vimMode: false,
  newNoteFolder: '',
  attachmentFolder: 'attachments',
  dailyNoteFolder: 'Daily',
  dailyNoteFormat: 'YYYY-MM-DD',
  dailyNoteTemplate: '',
  templateFolder: 'Templates',
  bookmarks: []
}

const SETTINGS_PATH = '.jjnote/app.json'
export const WORKSPACE_PATH = '.jjnote/workspace.json'

export async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return { ...fallback, ...JSON.parse(await window.jj.read(path)) }
  } catch {
    return fallback
  }
}

export const loadSettings = () => loadJson<Settings>(SETTINGS_PATH, { ...DEFAULT_SETTINGS })
export const saveSettings = (s: Settings) => window.jj.write(SETTINGS_PATH, JSON.stringify(s, null, 2))

/** Formats a date with YYYY, MM, DD, HH, mm, ss, ddd, dddd tokens. */
export function formatDate(d: Date, fmt: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    dddd: days[d.getDay()],
    ddd: days[d.getDay()].slice(0, 3)
  }
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss|dddd|ddd/g, (t) => map[t])
}
