import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'

// What a stopped server leaves behind: the processes and watchers its clients
// started must not outlive it.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('stopping the server ends its processes and closes its fs watchers', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CODEX_HOME: process.env.CLAUDE_CODEX_HOME,
  }
  process.env.CODEX_HOME = home
  process.env.CLAUDE_CODEX_HOME = home
  const server = new CodexClaudeAppServer(
    new SessionStore(join(home, 'state.sqlite')),
    new MockRuntime(),
  )
  const pids: number[] = []
  try {
    const replies = new Map<number | string, WireMessage>()
    const peer: RpcPeer = {
      id: 'client',
      send: (message) => {
        if ('id' in message && message.id != null) replies.set(message.id, message)
      },
      close: () => {},
    }
    const request = async (id: number, method: string, params: object) => {
      await server.handle(peer, { jsonrpc: '2.0', id, method, params } as WireMessage)
      const reply = replies.get(id) as any
      assert.ok(reply && !reply.error, `${method}: ${JSON.stringify(reply?.error)}`)
      return reply.result
    }
    const state = server as any

    // A terminal with streamed stdin and a streamed command/exec have no
    // timeout, so only the server can end them.
    await request(1, 'process/spawn', {
      processHandle: 'terminal',
      command: ['sleep', '30'],
      cwd: home,
      streamStdoutStderr: true,
      streamStdin: true,
    })
    const exec = request(2, 'command/exec', {
      processId: 'exec',
      command: ['sleep', '30'],
      cwd: home,
      streamStdoutStderr: true,
      streamStdin: true,
      disableTimeout: true,
    })
    await request(3, 'fs/watch', { watchId: 'watch', path: home })

    for (let waited = 0; state.commandProcesses.size === 0 && waited < 5_000; waited += 20)
      await delay(20)
    pids.push(state.processHandles.get('terminal').pid, state.commandProcesses.get('exec').pid)
    assert.ok(pids.every(alive))
    let watcherClosed = false
    state.fsWatchers.get('watch').once('close', () => {
      watcherClosed = true
    })

    await server.stop()

    assert.equal(state.processHandles.size, 0)
    assert.equal(state.commandProcesses.size, 0)
    assert.equal(state.fsWatchers.size, 0)
    // A watcher reports its close on the next tick.
    for (let waited = 0; (!watcherClosed || pids.some(alive)) && waited < 5_000; waited += 20)
      await delay(20)
    assert.ok(watcherClosed, 'the fs/watch watcher is still open')
    for (const pid of pids) assert.ok(!alive(pid), `process ${pid} outlived the server`)
    await exec
  } finally {
    await server.stop()
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
