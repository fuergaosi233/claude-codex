import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCommandActions, shortDisplayPath } from '../src/command-actions.mjs'
import {
  capOutput,
  exploreToolCommand,
  imageReadPath,
  isExploreTool,
  splitMcpToolName,
} from '../src/tool-items.mjs'
import type { CommandAction } from '../src/types.mjs'

const cwd = '/repo'

const read = (command: string, name: string, path: string): CommandAction => ({
  type: 'read',
  command,
  name,
  path,
})
const list = (command: string, path: string | null): CommandAction => ({
  type: 'listFiles',
  command,
  path,
})
const search = (command: string, query: string | null, path: string | null): CommandAction => ({
  type: 'search',
  command,
  query,
  path,
})
const unknown = (command: string): CommandAction[] => [{ type: 'unknown', command }]

test('commands that read a file are read actions with an absolute path', () => {
  const cases: [string, CommandAction[]][] = [
    ['cat README.md', [read('cat README.md', 'README.md', '/repo/README.md')]],
    ['cat /etc/hosts', [read('cat /etc/hosts', 'hosts', '/etc/hosts')]],
    ['head -n 50 src/app.ts', [read('head -n 50 src/app.ts', 'app.ts', '/repo/src/app.ts')]],
    ['tail -n +10 log.txt', [read('tail -n +10 log.txt', 'log.txt', '/repo/log.txt')]],
    [
      "sed -n '1,40p' src/app.ts",
      [read("sed -n '1,40p' src/app.ts", 'app.ts', '/repo/src/app.ts')],
    ],
    ['nl -ba src/app.ts', [read('nl -ba src/app.ts', 'app.ts', '/repo/src/app.ts')]],
    [
      'bat --style plain notes.md',
      [read('bat --style plain notes.md', 'notes.md', '/repo/notes.md')],
    ],
    [
      "awk '{print $1}' data.csv",
      [read("awk '{print $1}' data.csv", 'data.csv', '/repo/data.csv')],
    ],
  ]
  for (const [script, expected] of cases)
    assert.deepEqual(parseCommandActions(script, cwd), expected, script)
})

test('commands that list or search files are listFiles and search actions', () => {
  const cases: [string, CommandAction[]][] = [
    ['ls', [list('ls', null)]],
    ['ls -la src/lib', [list('ls -la src/lib', 'lib')]],
    ['tree -L 2 docs', [list('tree -L 2 docs', 'docs')]],
    ['rg --files src', [list('rg --files src', 'src')]],
    ['git ls-files', [list('git ls-files', null)]],
    ['fd -t f', [list('fd -t f', null)]],
    ['fd main src', [search('fd main src', 'main', 'src')]],
    ["find . -name '*.ts'", [search("find . -name '*.ts'", '*.ts', '.')]],
    ['find docs -type f', [list('find docs -type f', 'docs')]],
    ['rg -n "fn main" crates', [search('rg -n "fn main" crates', 'fn main', 'crates')]],
    ['rg TODO', [search('rg TODO', 'TODO', null)]],
    ['grep -rn TODO src/lib', [search('grep -rn TODO src/lib', 'TODO', 'lib')]],
    ['grep -e needle -r .', [search('grep -e needle -r .', 'needle', '.')]],
    ['git grep -n TODO', [search('git grep -n TODO', 'TODO', null)]],
    ['ag needle lib', [search('ag needle lib', 'needle', 'lib')]],
  ]
  for (const [script, expected] of cases)
    assert.deepEqual(parseCommandActions(script, cwd), expected, script)
})

test('command lists follow cd and drop formatting helpers and noise', () => {
  const cases: [string, CommandAction[]][] = [
    // A read in another directory resolves against it.
    ['cd src && cat app.ts', [read('cat app.ts', 'app.ts', '/repo/src/app.ts')]],
    ['cd /tmp && cat a.txt', [read('cat a.txt', 'a.txt', '/tmp/a.txt')]],
    // A helper that only trims output leaves the command it trims.
    ['rg --files | wc -l', [list('rg --files', null)]],
    ['rg -n TODO src | head -n 5', [search('rg -n TODO src', 'TODO', 'src')]],
    // Paging through a numbered file keeps the whole pipeline.
    [
      "nl -ba src/app.ts | sed -n '1,20p'",
      [read("nl -ba src/app.ts | sed -n '1,20p'", 'app.ts', '/repo/src/app.ts')],
    ],
    ['echo start && ls', [list('ls', null)]],
    ['ls || true', [list('ls', null)]],
    [
      'cat a.txt && cat b.txt',
      [read('cat a.txt', 'a.txt', '/repo/a.txt'), read('cat b.txt', 'b.txt', '/repo/b.txt')],
    ],
    ['ls\ncat a.txt', [list('ls', null), read('cat a.txt', 'a.txt', '/repo/a.txt')]],
    ['ls &&\n  cat a.txt', [list('ls', null), read('cat a.txt', 'a.txt', '/repo/a.txt')]],
    ['cat a.txt; cat a.txt', [read('cat a.txt', 'a.txt', '/repo/a.txt')]],
    // A lone cd has nothing to show.
    ['cd src', []],
  ]
  for (const [script, expected] of cases)
    assert.deepEqual(parseCommandActions(script, cwd), expected, script)
})

test('anything else is one unknown action holding the whole command', () => {
  for (const script of [
    'npm test',
    'git status',
    'echo hi',
    'wc -l a.txt',
    'cat a.txt && npm test',
    'cat README.md > out.txt',
    'cat < a.txt',
    'cat *.md',
    'cat ~/notes.md',
    'echo $HOME',
    'cat "$FILE"',
    'cat `which node`',
    'FOO=1 cat a.txt',
    '"cat" a.txt',
    'if true; then cat a.txt; fi',
    'cat a.txt &',
    'cat a.txt |& head',
    'cat a.txt |',
    '&& cat a.txt',
    'cat a.txt && && ls',
    "cat 'a.txt",
    '(cat a.txt)',
    'cat a.txt # note',
    'sed -i s/a/b/ a.txt',
    "sed 's/a/b/' a.txt",
    'rg --files | xargs sed -i s/a/b/',
  ])
    assert.deepEqual(parseCommandActions(script, cwd), unknown(script), script)
})

test('a short display path names the innermost meaningful directory', () => {
  assert.equal(shortDisplayPath('src/lib/'), 'lib')
  assert.equal(shortDisplayPath('a/b/node_modules'), 'b')
  assert.equal(shortDisplayPath('/repo/dist/build'), 'repo')
  assert.equal(shortDisplayPath('src'), 'src')
  assert.equal(shortDisplayPath('.'), '.')
})

test('Claude file exploration tools show as commands with matching actions', () => {
  assert.equal(isExploreTool('Read'), true)
  assert.equal(isExploreTool('Grep'), true)
  assert.equal(isExploreTool('Glob'), true)
  assert.equal(isExploreTool('LS'), true)
  assert.equal(isExploreTool('Bash'), false)
  assert.equal(isExploreTool('WebFetch'), false)

  assert.deepEqual(exploreToolCommand('Read', { file_path: '/repo/src/app.ts' }, cwd), {
    command: 'Read src/app.ts',
    commandActions: [read('Read src/app.ts', 'app.ts', '/repo/src/app.ts')],
  })
  assert.deepEqual(exploreToolCommand('Read', { file_path: 'notes.md' }, cwd), {
    command: 'Read notes.md',
    commandActions: [read('Read notes.md', 'notes.md', '/repo/notes.md')],
  })
  assert.deepEqual(exploreToolCommand('Read', { file_path: '/etc/hosts' }, cwd), {
    command: 'Read /etc/hosts',
    commandActions: [read('Read /etc/hosts', 'hosts', '/etc/hosts')],
  })
  assert.deepEqual(exploreToolCommand('Read', {}, cwd), {
    command: 'Read',
    commandActions: unknown('Read'),
  })
  assert.deepEqual(exploreToolCommand('Grep', { pattern: 'TODO', path: '/repo/src' }, cwd), {
    command: 'Grep TODO in src',
    commandActions: [search('Grep TODO in src', 'TODO', 'src')],
  })
  assert.deepEqual(exploreToolCommand('Grep', { pattern: 'TODO' }, cwd), {
    command: 'Grep TODO',
    commandActions: [search('Grep TODO', 'TODO', null)],
  })
  assert.deepEqual(exploreToolCommand('Glob', { pattern: '**/*.ts', path: '/other' }, cwd), {
    command: 'Glob **/*.ts in /other',
    commandActions: [search('Glob **/*.ts in /other', '**/*.ts', '/other')],
  })
  assert.deepEqual(exploreToolCommand('LS', { path: '/repo' }, cwd), {
    command: 'LS .',
    commandActions: [list('LS .', '.')],
  })
  assert.deepEqual(exploreToolCommand('LS', {}, cwd), {
    command: 'LS',
    commandActions: [list('LS', null)],
  })
})

test('only a Read of an image file is an image view', () => {
  assert.equal(imageReadPath('Read', { file_path: 'shot.PNG' }, cwd), '/repo/shot.PNG')
  assert.equal(imageReadPath('Read', { file_path: '/tmp/a.webp' }, cwd), '/tmp/a.webp')
  assert.equal(imageReadPath('Read', { file_path: 'notes.md' }, cwd), null)
  assert.equal(imageReadPath('Glob', { pattern: '*.png' }, cwd), null)
  assert.equal(imageReadPath('Read', { file_path: 'a.png' }, ''), null)
})

test('MCP tool names split into their server and tool', () => {
  assert.deepEqual(splitMcpToolName('mcp__github__create_issue'), {
    server: 'github',
    tool: 'create_issue',
  })
  // A configured server whose name holds `__` or other characters wins.
  assert.deepEqual(splitMcpToolName('mcp__team__docs__search', ['team', 'team__docs']), {
    server: 'team__docs',
    tool: 'search',
  })
  assert.deepEqual(splitMcpToolName('mcp__my_server__do-it', ['my.server']), {
    server: 'my.server',
    tool: 'do-it',
  })
  assert.deepEqual(splitMcpToolName('mcp__team__docs__search'), {
    server: 'team',
    tool: 'docs__search',
  })
  assert.equal(splitMcpToolName('Read'), null)
  assert.equal(splitMcpToolName('mcp__only'), null)
  assert.equal(splitMcpToolName('mcp__server__'), null)
})

test('long exploration output is cut for the App', () => {
  assert.equal(capOutput('abc', 5), 'abc')
  assert.equal(capOutput('abcdefg', 5), 'abcde\n… 2 more characters not shown')
})
