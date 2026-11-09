import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { INVALID_REQUEST } from '../src/host-methods.mjs'
import { MockRuntime } from '../src/mock-runtime.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

// Codex's own `fs/watch` callers watch single files in .git (HEAD, FETCH_HEAD),
// which git replaces by renaming a lock file over them. The watch keeps the
// path the App sent, follows the file across renames, and accepts a file that
// does not exist yet.

// A fresh `.git` with HEAD, under the tmpdir path as given (not its realpath).
const roots: string[] = []
function gitDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'fs-watch-'))
  roots.push(root)
  const git = join(root, '.git')
  mkdirSync(git)
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  return git
}

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Watches `path` and waits until the watch is live. On macOS a directory watch
// starts asynchronously, so a write right after fs/watch can be missed: write
// to `probe` (the target itself, or an entry of a watched directory) until the
// first fs/changed arrives, then forget what was seen.
async function watchLive(
  app: InProcessApp,
  watchId: string,
  path: string,
  probe: string,
): Promise<void> {
  assert.deepEqual(await app.request('fs/watch', { watchId, path }), { path })
  const isMine = (message: any): boolean =>
    message.method === 'fs/changed' && message.params.watchId === watchId
  for (let attempt = 0; !app.messages.some(isMine); attempt++) {
    if (attempt >= 100) throw new Error('watch never went live')
    writeFileSync(probe, String(attempt))
    await delay(50)
  }
  await delay(300) // let the probe's debounce window close
  for (let index = app.messages.length - 1; index >= 0; index--) {
    if (isMine(app.messages[index])) app.messages.splice(index, 1)
  }
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
    await watchLive(app, 'head', head, head)

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
    await watchLive(app, 'fetch', fetchHead, fetchHead)
    rmSync(fetchHead)
    await delay(300)
    app.messages.splice(
      0,
      app.messages.length,
      ...app.messages.filter((m) => m.method !== 'fs/changed'),
    )

    gitUpdate(fetchHead, 'abc\tbranch main\n')
    assert.deepEqual(await nextChange(app, 'fetch', 0), [fetchHead])
    await app.request('fs/unwatch', { watchId: 'fetch' })
  })
})

test('a watched directory reports the changed entry under the requested path', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const git = gitDir()
    await watchLive(app, 'git', git, join(git, '.probe'))

    writeFileSync(join(git, 'ORIG_HEAD'), 'abc\n')
    const changed = await nextChange(app, 'git', 0)
    assert.ok(changed.includes(join(git, 'ORIG_HEAD')), JSON.stringify(changed))
    await app.request('fs/unwatch', { watchId: 'git' })
  })
})

test('bursts of events for one watch arrive as one fs/changed', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const head = join(gitDir(), 'HEAD')
    await watchLive(app, 'head', head, head)
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
    await watchLive(app, 'head', head, head)
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

test('watch ids are per connection: reuse across connections, refusal within one, unwatch scoped', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const head = join(gitDir(), 'HEAD')
    const other: RpcPeer = { id: 'other', send: () => {}, close: () => {} }
    const send = (peer: RpcPeer, id: string, method: string, params: Record<string, unknown>) =>
      app.server.handle(peer, { jsonrpc: '2.0', id, method, params } as WireMessage)

    await watchLive(app, 'head', head, head)
    // Another connection may use the same id...
    await send(other, 'o1', 'fs/watch', { watchId: 'head', path: head })
    // ...and its unwatch leaves the owner's watch alone.
    await send(other, 'o2', 'fs/unwatch', { watchId: 'head' })
    // The owner still cannot reuse its own id.
    const reply = await app.call('fs/watch', { watchId: 'head', path: head })
    assert.equal(reply.error?.code, INVALID_REQUEST)

    // Foreign unwatch of the owner's id (never watched by `other` now) is a no-op.
    await send(other, 'o3', 'fs/unwatch', { watchId: 'head' })
    gitUpdate(head, 'ref: refs/heads/z\n')
    assert.deepEqual(await nextChange(app, 'head', 0), [head])

    app.server.closePeer(other)
    await app.request('fs/unwatch', { watchId: 'head' })
  })
})
