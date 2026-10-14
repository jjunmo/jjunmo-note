// End-to-end smoke test: launches the built app against a temporary vault and
// exercises the main features. Run `npm run build` first, then `npm run test:e2e`.
import { _electron as electron } from 'playwright-core'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'jjnote-e2e-'))
const vault = join(root, 'vault')
const userData = join(root, 'userdata')
await mkdir(join(vault, 'Projects'), { recursive: true })
await mkdir(join(vault, 'Templates'), { recursive: true })
await writeFile(join(vault, 'Home.md'), '# Home\n\nSee [[Project Alpha]] and [[Ideas#Later|later ideas]].\n\n- [ ] first task\n\n#inbox\n')
await writeFile(join(vault, 'Projects', 'Project Alpha.md'), '---\ntags: [project]\n---\n# Alpha\n\nBack to [[Home]]. Mentions Ideas here.\n\n> [!tip] Callout\n> body\n\n$$\nE=mc^2\n$$\n')
await writeFile(join(vault, 'Ideas.md'), '# Ideas\n\n## Later\nSome later idea #inbox\n')
await writeFile(join(vault, 'Templates', 'Meeting.md'), '# {{title}}\nDate: {{date}}\n')

const shots = process.env.SHOTS_DIR
const app = await electron.launch({ args: ['.'], env: { ...process.env, JJNOTE_USER_DATA: userData } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const step = async (name, fn) => {
  process.stdout.write(`- ${name} ... `)
  await fn()
  console.log('ok')
}
const shot = async (name) => shots && page.screenshot({ path: join(shots, name + '.png') })

try {
  await step('start screen renders', async () => {
    await page.waitForSelector('.starter')
    await shot('01-start')
  })

  await step('open vault', async () => {
    await page.evaluate((p) => {
      localStorage.setItem('lastVault', p)
      location.reload()
    }, vault)
    await page.waitForSelector('.nav-files-container .nav-item')
    const names = await page.$$eval('.nav-item-title', (els) => els.map((e) => e.textContent))
    assert.ok(names.includes('Home') && names.includes('Projects') && names.includes('Ideas'), names.join(','))
  })

  await step('open note from explorer, live preview renders links', async () => {
    await page.click('.nav-file-title:has-text("Home")')
    await page.waitForSelector('.cm-content')
    await page.waitForSelector('.cm-wikilink-widget')
    const links = await page.$$eval('.cm-wikilink-widget', (els) => els.map((e) => e.textContent))
    assert.deepEqual(links, ['Project Alpha', 'later ideas'])
    await shot('02-live-preview')
  })

  await step('backlinks panel shows linked mentions', async () => {
    const text = await page.textContent('.backlink-pane')
    assert.match(text, /Project Alpha/)
  })

  await step('follow wikilink', async () => {
    await page.click('.cm-wikilink-widget:has-text("Project Alpha")')
    await page.waitForFunction(() => document.querySelector('.inline-title')?.textContent === 'Project Alpha')
  })

  await step('reading view renders callout, math and properties', async () => {
    await page.keyboard.press(`${mod}+e`)
    await page.waitForSelector('.markdown-reading-view .callout')
    assert.ok(await page.$('.markdown-reading-view .katex'))
    assert.ok(await page.$('.markdown-reading-view .metadata-properties'))
    await shot('03-reading')
    await page.keyboard.press(`${mod}+e`)
  })

  await step('quick switcher opens a note', async () => {
    await page.keyboard.press(`${mod}+o`)
    await page.waitForSelector('.suggest-modal')
    await page.keyboard.type('idea')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.workspace-tab.is-active')?.textContent?.includes('Ideas'))
  })

  await step('typing creates content and autosaves', async () => {
    await page.click('.cm-content')
    await page.keyboard.press(`${mod}+End`)
    await page.keyboard.type('\nNew line linking [[Home')
    await page.waitForSelector('.cm-tooltip-autocomplete')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    const disk = await readFile(join(vault, 'Ideas.md'), 'utf8')
    assert.match(disk, /New line linking \[\[Home\]\]/)
  })

  await step('rename updates links in other notes', async () => {
    await page.click('.nav-file-title:has-text("Home")', { button: 'right' })
    await page.click('.menu-item:has-text("Rename")')
    await page.fill('.prompt-modal input', 'Start')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    const alpha = await readFile(join(vault, 'Projects', 'Project Alpha.md'), 'utf8')
    const ideas = await readFile(join(vault, 'Ideas.md'), 'utf8')
    assert.match(alpha, /\[\[Start\]\]/)
    assert.match(ideas, /\[\[Start\]\]/)
  })

  await step('search finds tag matches', async () => {
    await page.keyboard.press(`${mod}+Shift+f`)
    await page.fill('.search-input', 'tag:#inbox')
    await page.waitForTimeout(400)
    const summary = await page.textContent('.search-summary')
    assert.match(summary, /^2 files/)
    await shot('04-search')
  })

  await step('command palette runs graph view', async () => {
    await page.keyboard.press(`${mod}+p`)
    await page.keyboard.type('graph view open')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.graph-view canvas')
    await page.waitForTimeout(800)
    await shot('05-graph')
  })

  await step('daily note is created', async () => {
    await page.keyboard.press(`${mod}+p`)
    await page.keyboard.type("today's daily")
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    const daily = await readdir(join(vault, 'Daily'))
    assert.equal(daily.length, 1)
  })

  await step('new note via Mod+N', async () => {
    await page.keyboard.press(`${mod}+n`)
    await page.waitForTimeout(400)
    await page.keyboard.type('Fresh note')
    await page.keyboard.press('Enter')
    await page.keyboard.type('hello')
    await page.waitForTimeout(1200)
    const disk = await readFile(join(vault, 'Fresh note.md'), 'utf8')
    assert.equal(disk, 'hello')
    await shot('06-new-note')
  })

  const real = errors.filter((e) => !/Autofill|DevTools|ERR_FILE_NOT_FOUND/.test(e))
  assert.deepEqual(real, [], 'renderer errors:\n' + real.join('\n'))
  console.log('\nAll smoke checks passed.')
} finally {
  await app.close()
}
