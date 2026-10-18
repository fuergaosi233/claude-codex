import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { askRuleCovers, askRulesGuard, bashRuleCovers } from '../src/ask-rules.mjs'

test('a Bash ask rule covers every command of a command line and what wrappers run', () => {
  const covered = (specifier: string, line: string) => bashRuleCovers(specifier, line)
  for (const line of [
    'git push',
    'git push origin main',
    'npm test && git push',
    'npm test || git push; echo done',
    'git fetch | git push',
    'npm test & git push',
    'FOO=1 BAR="a b" git push',
    'timeout 30 git push',
    'nice -n 5 nohup git push',
    'sh -c "git push --force"',
    "bash -lc 'cd app && git push'",
    'eval git push',
    'echo hi > out.txt; git  push',
    'git push 2>&1 | tee log',
    '/usr/bin/git push',
    'if true; then git push; fi',
    'xargs -n1 git push < remotes',
  ])
    assert.equal(covered('git push:*', line), true, line)
  for (const line of [
    'git status',
    'git status 2>&1 | grep push',
    'echo git push',
    "echo 'git push'",
    'npm test # git push',
  ])
    assert.equal(covered('git push:*', line), false, line)

  // A command line whose commands only the shell can work out could run
  // anything, so any Bash rule asks about it.
  for (const line of [
    'echo $(git push)',
    'echo `git push`',
    'cat <<EOF\ngit push\nEOF',
    '$GIT push',
    'echo $(date)',
    'diff <(ls a) <(ls b)',
    "echo 'unterminated",
    'sh -c "echo $(id)"',
  ]) {
    assert.equal(covered('git push:*', line), true, line)
    assert.equal(covered('rm *', line), true, line)
  }

  // Wildcards: `cmd *` covers cmd and its arguments, not a longer name.
  assert.equal(covered('ls *', 'ls'), true)
  assert.equal(covered('ls *', 'ls -la'), true)
  assert.equal(covered('ls *', 'lsof'), false)
  assert.equal(covered('git * main', 'git push origin main'), true)
  assert.equal(covered('git * main', 'git push origin dev'), false)
  // A plain command covers more arguments too, and its quoting need not
  // match.
  assert.equal(covered('git commit -m "wip"', "git commit -m 'wip'"), true)
  assert.equal(covered('git commit', 'git commit --amend'), true)
  assert.equal(covered('git commit', 'git commits'), false)
  assert.equal(covered('rm:*', 'find . -name "*.tmp" -exec rm {} \\;'), true)
})

test('file ask rules cover the tools that read or edit the file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ask-rules-')))
  const cwd = join(root, 'repo')
  try {
    await mkdir(join(cwd, 'src'), { recursive: true })
    await symlink(cwd, join(root, 'link'))
    const covers = (rule: string, tool: string, input: Record<string, unknown>) =>
      askRuleCovers(rule, tool, input, cwd)

    // Edit rules cover every tool that edits files, relative paths start at
    // the thread's folder, and a pattern without a slash matches anywhere.
    assert.equal(covers('Edit(/src/**)', 'Write', { file_path: join(cwd, 'src/new.ts') }), true)
    assert.equal(covers('Edit(/src/**)', 'MultiEdit', { file_path: 'src/a/b.ts' }), true)
    assert.equal(covers('Edit(/src/**)', 'Edit', { file_path: join(cwd, 'test/a.ts') }), false)
    assert.equal(covers('Edit(src)', 'Edit', { file_path: join(cwd, 'src/a.ts') }), true)
    assert.equal(
      covers('Edit(*.ipynb)', 'NotebookEdit', { notebook_path: join(cwd, 'a/b/c.ipynb') }),
      true,
    )
    assert.equal(covers('Edit', 'Write', { file_path: '/anywhere' }), true)
    assert.equal(covers('Edit(/src/**)', 'Read', { file_path: join(cwd, 'src/a.ts') }), false)
    // Through a symlink to the folder too.
    assert.equal(
      covers('Edit(/src/**)', 'Edit', { file_path: join(root, 'link', 'src', 'a.ts') }),
      true,
    )

    // Read rules cover reading tools, a search tool by the folder it looks in.
    assert.equal(covers('Read(./.env)', 'Read', { file_path: join(cwd, '.env') }), true)
    assert.equal(covers('Read(.env)', 'Read', { file_path: join(cwd, 'app/.env') }), true)
    assert.equal(covers('Read(./.env)', 'Read', { file_path: join(cwd, 'x.env') }), false)
    assert.equal(covers('Read(/src/**)', 'Grep', { pattern: 'x', path: 'src' }), true)
    assert.equal(covers('Read(/src/**)', 'Glob', { pattern: '*.ts' }), false)
    assert.equal(covers('Read(//etc/**)', 'Read', { file_path: '/etc/hosts' }), true)
    assert.equal(covers('Read(~/.ssh/**)', 'Read', { file_path: '~/.ssh/id' }), true)
    assert.equal(
      covers('Read(~/.ssh/**)', 'Read', { file_path: join(homedir(), '.ssh', 'id') }),
      true,
    )
    // A call that names no file is asked about.
    assert.equal(covers('Read(./.env)', 'Read', {}), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('other ask rules: whole tools, domains, MCP servers and subagents', () => {
  const covers = (rule: string, tool: string, input: Record<string, unknown> = {}) =>
    askRuleCovers(rule, tool, input, '/')
  assert.equal(covers('WebSearch', 'WebSearch'), true)
  assert.equal(covers('WebSearch', 'WebFetch'), false)
  assert.equal(covers('Bash', 'Bash', { command: 'ls' }), true)
  assert.equal(covers('Bash(*)', 'Bash', { command: 'ls' }), true)
  const fetch = (url: string) => covers('WebFetch(domain:example.com)', 'WebFetch', { url })
  assert.equal(fetch('https://example.com/a'), true)
  assert.equal(fetch('https://api.example.com/a'), true)
  assert.equal(fetch('https://example.org/a'), false)
  assert.equal(fetch('https://notexample.com/a'), false)
  assert.equal(fetch('not a url'), true)
  assert.equal(covers('mcp__docs', 'mcp__docs__read'), true)
  assert.equal(covers('mcp__docs__*', 'mcp__docs__read'), true)
  assert.equal(covers('mcp__docs__write', 'mcp__docs__read'), false)
  assert.equal(covers('mcp__docs__read', 'mcp__docs__read'), true)
  assert.equal(covers('mcp__docs', 'mcp__docsearch__read'), false)
  assert.equal(covers('Agent(reviewer)', 'Task', { subagent_type: 'reviewer' }), true)
  assert.equal(covers('Task(reviewer)', 'Agent', { subagent_type: 'other' }), false)
  assert.equal(covers('Agent', 'Agent', { subagent_type: 'other' }), true)
  // A specifier the guard cannot read asks.
  assert.equal(covers('NewTool(something)', 'NewTool'), true)
})

test('the ask guard answers ask with the rule, and nothing for other calls', async () => {
  const guard = askRulesGuard(['WebSearch', 'Bash(git push:*)'], '/')
  const run = (tool_name: string, tool_input: Record<string, unknown>) =>
    guard.hooks[0]?.({ tool_name, tool_input }, undefined, {
      signal: new AbortController().signal,
    })
  assert.equal(guard.matcher, undefined)
  assert.deepEqual(await run('Bash', { command: 'git push' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Your Claude Code settings ask before Bash(git push:*).',
    },
  })
  assert.deepEqual(await run('Bash', { command: 'git status' }), {})
  // Whatever runs inside $(...) is not known: the Bash rule asks.
  assert.deepEqual(await run('Bash', { command: 'echo $(date)' }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'Your Claude Code settings ask before Bash(git push:*).',
    },
  })
  assert.deepEqual(await run('Read', { file_path: '/a' }), {})
})
