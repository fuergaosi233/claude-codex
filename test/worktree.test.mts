import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { maybeCreateThreadWorktree, worktreeLabel } from '../src/worktree.mjs'

test('worktree label keeps thread ids root-confined and collision-resistant', () => {
  const unsafe = '../thread/../../with spaces'
  const first = '12345678-first-thread'
  const second = '12345678-second-thread'

  assert.equal(worktreeLabel(unsafe).includes('/'), false)
  assert.equal(worktreeLabel(unsafe).includes('..'), false)
  assert.notEqual(worktreeLabel(first), worktreeLabel(second))
  assert.match(worktreeLabel(first), /^12345678-first-thread-[a-f0-9]{16}$/)
})

test('auto worktree creates and then reuses an existing per-thread worktree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-worktree-test-'))
  const repo = join(home, 'repo')
  const root = join(home, 'worktrees')
  const threadId = '../same-prefix-thread'
  const restore = withWorktreeEnv(root)
  try {
    execFileSync('mkdir', ['-p', repo])
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    await writeFile(join(repo, 'README.md'), 'hello\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
      { cwd: repo, stdio: 'ignore' },
    )

    const created = maybeCreateThreadWorktree(threadId, repo)
    const reused = maybeCreateThreadWorktree(threadId, repo)

    assert.equal(created.created, true)
    assert.equal(reused.created, false)
    assert.equal(reused.cwd, created.cwd)
    assert.equal(basename(created.cwd), worktreeLabel(threadId))
    assert.equal(created.cwd.startsWith(root), true)
  } finally {
    restore()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('auto worktree falls back to original cwd outside git repositories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-worktree-test-'))
  const root = join(home, 'worktrees')
  const restore = withWorktreeEnv(root)
  try {
    const result = maybeCreateThreadWorktree('thread-a', home)

    assert.deepEqual(result, { cwd: home, created: false })
  } finally {
    restore()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

function withWorktreeEnv(root: string): () => void {
  const previousAuto = process.env.CLAUDE_CODEX_AUTO_WORKTREE
  const previousRoot = process.env.CLAUDE_CODEX_WORKTREE_ROOT
  process.env.CLAUDE_CODEX_AUTO_WORKTREE = '1'
  process.env.CLAUDE_CODEX_WORKTREE_ROOT = root
  return () => {
    restoreEnv('CLAUDE_CODEX_AUTO_WORKTREE', previousAuto)
    restoreEnv('CLAUDE_CODEX_WORKTREE_ROOT', previousRoot)
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
