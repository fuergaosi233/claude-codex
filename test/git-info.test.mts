import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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
