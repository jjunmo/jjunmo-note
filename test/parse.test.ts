import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNote,
  resolveLink,
  rewriteLinks,
  splitWikiTarget,
  fuzzyMatch,
  linkTextFor,
  countWords
} from '../src/renderer/src/core/parse.ts'

test('splitWikiTarget handles heading, block and alias', () => {
  assert.deepEqual(splitWikiTarget('Note#Head|Shown'), { target: 'Note', subpath: '#Head', alias: 'Shown' })
  assert.deepEqual(splitWikiTarget('Note#^abc'), { target: 'Note', subpath: '#^abc', alias: null })
  assert.deepEqual(splitWikiTarget('#Local'), { target: '', subpath: '#Local', alias: null })
})

test('parseNote extracts links, tags, headings, tasks, frontmatter', () => {
  const md = [
    '---',
    'tags: [project, idea]',
    'aliases:',
    '  - Alt name',
    '---',
    '# Title',
    'See [[Other]] and ![[img.png]] and [md](Folder/Doc.md#Sec).',
    'Tagged #todo and #nested/tag but not #123 or a#b.',
    '- [ ] open task',
    '- [x] done task',
    '```',
    '[[ignored]] #ignored',
    '```',
    '`[[inline code]]`',
    '## Second'
  ].join('\n')
  const m = parseNote(md)
  assert.deepEqual(
    m.links.map((l) => [l.target, l.embed, l.kind, l.subpath]),
    [
      ['Other', false, 'wiki', ''],
      ['img.png', true, 'wiki', ''],
      ['Folder/Doc.md', false, 'markdown', '#Sec']
    ]
  )
  assert.deepEqual(m.tags, ['project', 'idea', 'todo', 'nested/tag'])
  assert.deepEqual(m.aliases, ['Alt name'])
  assert.deepEqual(
    m.headings.map((h) => [h.level, h.text]),
    [
      [1, 'Title'],
      [2, 'Second']
    ]
  )
  assert.deepEqual(
    m.tasks.map((t) => t.done),
    [false, true]
  )
  assert.equal(m.frontmatterEnd, 5)
})

test('link offsets point at the link source', () => {
  const md = 'a\nxx [[Target|t]] yy'
  const [l] = parseNote(md).links
  assert.equal(md.slice(l.from, l.to), '[[Target|t]]')
})

test('resolveLink prefers exact path, then same folder, then shortest', () => {
  const files = ['A.md', 'x/A.md', 'x/y/B.md', 'z/B.md', 'img/pic.png', 'Deep/Note.md']
  assert.equal(resolveLink('A', 'q.md', files), 'A.md')
  assert.equal(resolveLink('A', 'x/other.md', files), 'x/A.md')
  assert.equal(resolveLink('B', 'q.md', files), 'z/B.md')
  assert.equal(resolveLink('y/B', 'q.md', files), 'x/y/B.md')
  assert.equal(resolveLink('pic.png', 'q.md', files), 'img/pic.png')
  assert.equal(resolveLink('note', 'q.md', files), 'Deep/Note.md')
  assert.equal(resolveLink('Missing', 'q.md', files), null)
})

test('rewriteLinks updates only links that pointed at the renamed file', () => {
  const before = ['Old.md', 'Other.md', 'src.md']
  const after = ['New.md', 'Other.md', 'src.md']
  const text = 'x [[Old]] [[Old#H|alias]] ![[Old]] [[Other]]'
  assert.equal(rewriteLinks(text, 'src.md', 'Old.md', 'New.md', before, after), 'x [[New]] [[New#H|alias]] ![[New]] [[Other]]')
})

test('linkTextFor disambiguates duplicate names', () => {
  assert.equal(linkTextFor('a/N.md', ['a/N.md', 'b/N.md']), 'a/N')
  assert.equal(linkTextFor('a/N.md', ['a/N.md']), 'N')
})

test('fuzzyMatch ranks prefix matches higher', () => {
  const a = fuzzyMatch('mtg', 'Meeting notes.md')!
  const b = fuzzyMatch('mtg', 'random/time/thing.md')!
  assert.ok(a && b && a.score > b.score)
  assert.equal(fuzzyMatch('zzz', 'abc'), null)
})

test('countWords counts latin words and CJK characters', () => {
  assert.equal(countWords('hello world'), 2)
  assert.equal(countWords('안녕 세상'), 2)
  assert.equal(countWords('日本語'), 3)
})
