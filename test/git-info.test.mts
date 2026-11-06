import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gitInfoFor, patchGitInfo, sanitizeGitRemoteUrl } from '../src/git-info.mjs'

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim()
}

test('git remotes lose their credentials the way Codex sanitizes them', () => {
  const cases: Array<[string, string | null]> = [
    ['https://user:secret@example.com/acme/app.git', 'https://example.com/acme/app.git'],
    ['https://token@example.com/acme/app.git', 'https://example.com/acme/app.git'],
    ['https://example.com/acme/app.git', 'https://example.com/acme/app.git'],
    ['ssh://git@example.com/acme/app.git', 'ssh://git@example.com/acme/app.git'],
    ['ssh://git:secret@example.com/acme/app.git', 'ssh://git@example.com/acme/app.git'],
    ['ssh://alice@example.com:2222/acme/app.git', 'ssh://example.com:2222/acme/app.git'],
    ['git@github.com:acme/app.git', 'git@github.com:acme/app.git'],
    ['alice@example.com:acme/app.git', 'example.com:acme/app.git'],
    ['alice@[::1]:acme/app.git', '[::1]:acme/app.git'],
    ['hg::https://user:secret@example.com/repo', 'hg::https://example.com/repo'],
    ['/srv/git/app.git', '/srv/git/app.git'],
    ['file:///srv/git/app.git', 'file:///srv/git/app.git'],
    ['  https://example.com/acme/app.git  ', 'https://example.com/acme/app.git'],
    // A helper's command line can hold secrets anywhere.
    ['ext::ssh -i secret.key example.com %S', null],
    ['https://', null],
    ['https://example.com/acme\napp.git', null],
    ['', null],
  ]
  for (const [remote, expected] of cases)
    assert.equal(sanitizeGitRemoteUrl(remote), expected, remote)
})

test('a gitInfo patch keeps omitted fields, clears null ones and checks the rest', () => {
  const current = { sha: 'abc', branch: 'main', originUrl: 'https://example.com/acme/app.git' }
  assert.deepEqual(patchGitInfo(current, { branch: '  feature/x  ' }), {
    ...current,
    branch: 'feature/x',
  })
  assert.deepEqual(patchGitInfo(current, { sha: null, originUrl: 'https://u:p@example.com/r' }), {
    sha: null,
    branch: 'main',
    originUrl: 'https://example.com/r',
  })
  assert.deepEqual(patchGitInfo(null, { branch: 'main' }), {
    sha: null,
    branch: 'main',
    originUrl: null,
  })
  assert.equal(patchGitInfo(current, { sha: null, branch: null, originUrl: null }), null)
  assert.throws(() => patchGitInfo(current, {}), /gitInfo must include at least one field/)
  assert.throws(() => patchGitInfo(current, { branch: '  ' }), /gitInfo.branch must not be empty/)
  assert.throws(
    () => patchGitInfo(current, { originUrl: 'ext::sh -c secret' }),
    /gitInfo.originUrl must be a valid Git remote/,
  )
  assert.throws(() => patchGitInfo(current, { sha: 1 }), /gitInfo.sha must be a string or null/)
  assert.throws(() => patchGitInfo(current, 'main'), /gitInfo must be an object/)
})

test('gitInfoFor reads HEAD, its branch and origin, and caches per directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-git-info-'))
  try {
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature/sidebar')
    // An unborn branch has a name but no commit yet.
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), {
      sha: null,
      branch: 'feature/sidebar',
      originUrl: null,
    })
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(repo, 'remote', 'add', 'origin', 'https://user:secret@example.com/acme/app.git')
    const sha = git(repo, 'rev-parse', 'HEAD')
    const expected = {
      sha,
      branch: 'feature/sidebar',
      originUrl: 'https://example.com/acme/app.git',
    }
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), expected)

    // Cached until it expires or a caller asks for a fresh lookup.
    git(repo, 'checkout', '-q', '-b', 'fix/later')
    assert.deepEqual(await gitInfoFor(repo), expected)
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), { ...expected, branch: 'fix/later' })

    // A detached HEAD has no branch.
    git(repo, 'checkout', '-q', '--detach')
    assert.deepEqual(await gitInfoFor(repo, { fresh: true }), { ...expected, branch: null })

    assert.equal(await gitInfoFor(root), null)
    assert.equal(await gitInfoFor(join(root, 'missing')), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a git call that times out fails the lookup instead of reading as a detached HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-git-info-'))
  const path = process.env.PATH
  try {
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature/x')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
    // A git that answers symbolic-ref after the 1s timeout while `slow` exists.
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const slow = join(root, 'slow')
    await mkdir(join(root, 'bin'))
    await writeFile(
      join(root, 'bin', 'git'),
      `#!/bin/sh\n[ "$1" = symbolic-ref ] && [ -e '${slow}' ] && sleep 1.5\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    )
    process.env.PATH = `${join(root, 'bin')}:${path}`

    await writeFile(slow, '')
    const failed = gitInfoFor(repo, { fresh: true })
    await assert.rejects(failed)
    // The failure is not cached: the next lookup runs git again.
    await rm(slow)
    const next = gitInfoFor(repo)
    assert.notEqual(next, failed)
    // Its own result depends on how loaded the machine is.
    await next.catch(() => null)
  } finally {
    process.env.PATH = path
    await rm(root, { recursive: true, force: true })
  }
})
