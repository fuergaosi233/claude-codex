import assert from 'node:assert/strict'
import test from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

// Streamed `command/exec` output is capped per stream like buffered output,
// as Codex's `spawn_process_output` caps it: the delta that reaches the cap
// says capReached, later data on that stream is dropped, and the process runs
// on to its end.

// Writes 4 bytes of stdout, then after a pause 200 KB more (past a pipe's
// buffer, so a reader that stopped draining would hang the child), and 50
// bytes of stderr.
const SCRIPT = [
  'process.stdout.write("abcd")',
  'setTimeout(() => {',
  '  process.stdout.write("e".repeat(200_000))',
  '  process.stderr.write("x".repeat(50))',
  '}, 50)',
].join('\n')

function deltas(app: InProcessApp, processId: string, stream: string) {
  return app
    .notified('command/exec/outputDelta')
    .filter((params) => params.processId === processId && params.stream === stream)
}

const sent = (list: any[]): string =>
  list.map((delta) => Buffer.from(delta.deltaBase64, 'base64').toString('utf8')).join('')

// Chunk boundaries depend on timing, so only the last delta may say capReached.
function assertOnlyLastReachedCap(list: any[]): void {
  assert.ok(list.length > 0)
  assert.deepEqual(
    list.map((delta) => delta.capReached),
    list.map((_, index) => index === list.length - 1),
  )
}

test('streamed command/exec output stops at outputBytesCap and says so', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const result = await app.request('command/exec', {
      processId: 'capped',
      command: [process.execPath, '-e', SCRIPT],
      streamStdoutStderr: true,
      outputBytesCap: 10,
    })
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' })

    const stdout = deltas(app, 'capped', 'stdout')
    assert.equal(sent(stdout), 'abcdeeeeee')
    assertOnlyLastReachedCap(stdout)
    const stderr = deltas(app, 'capped', 'stderr')
    assert.equal(sent(stderr), 'x'.repeat(10))
    assertOnlyLastReachedCap(stderr)
  })
})

test('disableOutputCap streams all output without capReached', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    await app.request('command/exec', {
      processId: 'uncapped',
      command: [process.execPath, '-e', SCRIPT],
      streamStdoutStderr: true,
      disableOutputCap: true,
    })
    const stdout = deltas(app, 'uncapped', 'stdout')
    assert.equal(sent(stdout), `abcd${'e'.repeat(200_000)}`)
    assert.equal(sent(deltas(app, 'uncapped', 'stderr')), 'x'.repeat(50))
    assert.ok([...stdout, ...deltas(app, 'uncapped', 'stderr')].every((delta) => !delta.capReached))
  })
})

test('outputBytesCap 0 sends one empty capReached delta for each stream with output', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const result = await app.request('command/exec', {
      processId: 'zero',
      command: [process.execPath, '-e', SCRIPT],
      streamStdoutStderr: true,
      outputBytesCap: 0,
    })
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' })
    for (const stream of ['stdout', 'stderr']) {
      const list = deltas(app, 'zero', stream)
      assert.equal(list.length, 1)
      assert.equal(list[0].deltaBase64, '')
      assert.equal(list[0].capReached, true)
    }
  })
})
