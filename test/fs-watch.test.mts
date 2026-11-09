import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { INVALID_REQUEST } from '../src/host-methods.mjs'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

// Codex's own `fs/watch` callers watch single files in .git (HEAD, FETCH_HEAD),
// which git replaces by renaming a lock file over them. The watch keeps the
// path the App sent, follows the file across renames, and accepts a file that
// does not exist yet.

// A fresh `.git` with HEAD, under the tmpdir path as given (not its realpath).
function gitDir(): string {
  const git = join(mkdtempSync(join(tmpdir(), 'fs-watch-')), '.git')
  mkdirSync(git)
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  return git
}

// git's atomic update: write `<file>.lock`, rename it over `<file>`.
function gitUpdate(file: string, content: string): void {
  writeFileSync(`${file}.lock`, content)
  renameSync(`${file}.lock`, file)
}

function changes(app: InProcessApp, watchId: string): string[][] {
  return app
    .notified('fs/changed')
    .filter((params) => params.watchId === watchId)
    .map((params) => params.changedPaths)
}

// The changes for the watch once one more batch arrives after `seen` batches.
async function nextChange(app: InProcessApp, watchId: string, seen: number): Promise<string[]> {
  return app.waitFor(() => changes(app, watchId)[seen])
}

test('a watched file reports its own path after each atomic rename', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const head = join(gitDir(), 'HEAD')
    const reply = await app.request('fs/watch', { watchId: 'head', path: head })
    assert.deepEqual(reply, { path: head })

    for (const [index, branch] of ['a', 'b', 'c'].entries()) {
      gitUpdate(head, `ref: refs/heads/${branch}\n`)
      assert.deepEqual(await nextChange(app, 'head', index), [head])
      // Let the debounce window close so the next rename is its own batch.
      await delay(250)
    }
    // The lock file next to HEAD is never reported for a HEAD watch.
    assert.ok(changes(app, 'head').every((paths) => paths.every((path) => path === head)))
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})

test('a missing file can be watched and fires once it appears', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const fetchHead = join(gitDir(), 'FETCH_HEAD')
    const reply = await app.request('fs/watch', { watchId: 'fetch', path: fetchHead })
    assert.deepEqual(reply, { path: fetchHead })

    gitUpdate(fetchHead, 'abc\tbranch main\n')
    assert.deepEqual(await nextChange(app, 'fetch', 0), [fetchHead])
    await app.request('fs/unwatch', { watchId: 'fetch' })
  })
})

test('a watched directory reports the changed entry under the requested path', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    assert.deepEqual(await app.request('fs/watch', { watchId: 'git', path: git }), { path: git })

    writeFileSync(join(git, 'ORIG_HEAD'), 'abc\n')
    const changed = await nextChange(app, 'git', 0)
    assert.ok(changed.includes(join(git, 'ORIG_HEAD')), JSON.stringify(changed))
    await app.request('fs/unwatch', { watchId: 'git' })
  })
})

test('bursts of events for one watch arrive as one fs/changed', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const head = join(gitDir(), 'HEAD')
    await app.request('fs/watch', { watchId: 'head', path: head })
    for (let index = 0; index < 5; index++) writeFileSync(head, `ref: refs/heads/b${index}\n`)
    assert.deepEqual(await nextChange(app, 'head', 0), [head])
    await delay(300)
    assert.equal(changes(app, 'head').length, 1)
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})

test('a watchId already in use is refused and the first watch keeps working', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    const head = join(git, 'HEAD')
    await app.request('fs/watch', { watchId: 'head', path: head })
    const reply = await app.call('fs/watch', { watchId: 'head', path: git })
    assert.equal(reply.error?.code, INVALID_REQUEST)
    assert.equal(reply.error?.message, 'watchId already exists: head')

    gitUpdate(head, 'ref: refs/heads/a\n')
    assert.deepEqual(await nextChange(app, 'head', 0), [head])
    await app.request('fs/unwatch', { watchId: 'head' })
    // An unwatched id can be used again.
    await app.request('fs/watch', { watchId: 'head', path: head })
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})
