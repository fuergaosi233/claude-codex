import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendCommandOutput,
  CommandOutputs,
  nextOutputDelta,
  type OutputSink,
  parseTaskOutput,
  type TaskOutputTail,
} from '../src/command-output.mjs'

function tail(
  output: string,
  totalBytes = Buffer.byteLength(output),
  truncated = false,
): TaskOutputTail {
  return { output, totalBytes, truncated }
}

// A CLI whose tasks have printed `outputs` so far, answering get_task_output
// the way the Claude CLI does.
function fakeCli() {
  const outputs = new Map<string, string>()
  const reads: string[] = []
  const read = async (taskId: string): Promise<unknown> => {
    reads.push(taskId)
    const output = outputs.get(taskId)
    if (output === undefined) throw new Error(`No task found with ID: ${taskId}`)
    return { output, total_bytes: Buffer.byteLength(output), truncated: false }
  }
  return { outputs, reads, read }
}

interface RecordingSink extends OutputSink {
  deltas: string[]
  open: boolean
}

function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    deltas: [],
    open: true,
    live: () => sink.open,
    emit: (delta) => {
      sink.deltas.push(delta)
    },
  }
  return sink
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(probe: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (probe()) return
    await sleep(2)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('parseTaskOutput accepts only the get_task_output answer', () => {
  assert.deepEqual(parseTaskOutput({ output: 'a\n', total_bytes: 2, truncated: false }), {
    output: 'a\n',
    totalBytes: 2,
    truncated: false,
  })
  for (const value of [
    null,
    'a',
    [],
    { output: 'a', total_bytes: '1', truncated: false },
    { output: 'a', total_bytes: -1, truncated: false },
    { output: 'a', total_bytes: 1.5, truncated: false },
    { output: 1, total_bytes: 1, truncated: false },
    { output: 'a', total_bytes: 1 },
  ])
    assert.equal(parseTaskOutput(value), null, JSON.stringify(value))
})

test('nextOutputDelta emits what the tail adds past the bytes already shown', () => {
  assert.deepEqual(nextOutputDelta(0, tail('')), { kind: 'wait' })
  assert.deepEqual(nextOutputDelta(0, tail('a\n')), {
    kind: 'emit',
    delta: 'a\n',
    consumed: 2,
    skipped: false,
  })
  assert.deepEqual(nextOutputDelta(2, tail('a\nb\n')), {
    kind: 'emit',
    delta: 'b\n',
    consumed: 4,
    skipped: false,
  })
  assert.deepEqual(nextOutputDelta(4, tail('a\nb\n')), { kind: 'wait' })
  // Offsets count bytes, not characters.
  assert.deepEqual(nextOutputDelta(3, tail('é\nü\n')), {
    kind: 'emit',
    delta: 'ü\n',
    consumed: 6,
    skipped: false,
  })
  // A cut tail starts inside a character; the bytes before it do not matter.
  assert.deepEqual(nextOutputDelta(9_997, tail('\uFFFD\uFFFDab\n', 10_000, true)), {
    kind: 'emit',
    delta: 'ab\n',
    consumed: 10_000,
    skipped: false,
  })
})

test('nextOutputDelta waits for a partly written character and stops on bytes that are not UTF-8', () => {
  assert.deepEqual(nextOutputDelta(0, tail('ab\uFFFD', 3)), { kind: 'wait' })
  assert.deepEqual(nextOutputDelta(0, tail('a\uFFFDb', 3)), { kind: 'stop', reason: 'not_utf8' })
  assert.deepEqual(nextOutputDelta(19_993, tail('\uFFFDab\uFFFDc\n', 20_000, true)), {
    kind: 'stop',
    reason: 'not_utf8',
  })
  // The CLI answers for a task whose output file is gone with no output.
  assert.deepEqual(nextOutputDelta(10, tail('')), { kind: 'stop', reason: 'output_shrank' })
})

test('nextOutputDelta marks output that came and went between two reads', () => {
  assert.deepEqual(nextOutputDelta(10, tail('ial line\nlast\n', 50_000, true)), {
    kind: 'emit',
    delta: 'last\n',
    consumed: 50_000,
    skipped: true,
  })
})

test('appendCommandOutput keeps the last 20000 characters the way the App does', () => {
  assert.equal(appendCommandOutput(null, 'a'), 'a')
  assert.equal(appendCommandOutput('a', 'b'), 'ab')
  const long = appendCommandOutput('x'.repeat(19_999), 'yz')
  assert.equal(long, `[output truncated]\n${'x'.repeat(19_998)}yz`)
  assert.equal(appendCommandOutput(long, 'w'), `[output truncated]\n${'x'.repeat(19_997)}yzw`)
  assert.equal(appendCommandOutput('[output truncated]\nab', 'c'), '[output truncated]\nabc')
})

test('each Bash call gets the output of the task that names it, until its result', async () => {
  const cli = fakeCli()
  const outputs = new CommandOutputs(cli.read, 5)
  const first = recordingSink()
  const second = recordingSink()
  const thread = recordingSink()
  outputs.call('call-1', first)
  outputs.call('call-2', second)
  cli.outputs.set('t1', 'one\n')
  cli.outputs.set('t2', 'two\n')
  outputs.taskStarted('t2', 'call-2', false)
  outputs.taskStarted('t1', 'call-1', false)
  await waitFor(() => first.deltas.length === 1 && second.deltas.length === 1, 'first output')
  cli.outputs.set('t1', 'one\nmore\n')
  await waitFor(() => first.deltas.length === 2, 'more output')

  // The results end both: a command that finished goes on nowhere.
  outputs.callEnded('call-1', null, () => false)
  outputs.callEnded(
    'call-2',
    () => thread,
    () => false,
  )
  const reads = cli.reads.length
  cli.outputs.set('t1', 'one\nmore\nlate\n')
  cli.outputs.set('t2', 'two\nlate\n')
  await sleep(30)
  assert.equal(cli.reads.length, reads)
  assert.deepEqual(first.deltas, ['one\n', 'more\n'])
  assert.deepEqual(second.deltas, ['two\n'])
  assert.deepEqual(thread.deltas, [])
  outputs.close()
})

test('a call two tasks name, or a task naming no call of the main loop, shows nothing', async () => {
  const cli = fakeCli()
  const outputs = new CommandOutputs(cli.read, 5)
  const sink = recordingSink()
  outputs.call('call-1', sink)
  for (const id of ['t1', 't2', 't3', 't4']) cli.outputs.set(id, `${id}\n`)
  outputs.taskStarted('t1', 'call-1', false)
  outputs.taskStarted('t2', 'call-1', false)
  // A subagent's own Bash call, and a task with no call.
  outputs.taskStarted('t3', 'subagent-call', false)
  outputs.taskStarted('t4', null, false)
  await sleep(30)
  assert.deepEqual(cli.reads, [])
  assert.deepEqual(sink.deltas, [])

  // Not even once the call goes on in the background.
  const thread = recordingSink()
  outputs.callEnded(
    'call-1',
    () => thread,
    () => true,
  )
  outputs.taskStarted('t5', 'call-1', true)
  await sleep(30)
  assert.deepEqual(cli.reads, [])
  assert.deepEqual(thread.deltas, [])
  outputs.close()
})

test('a failed read, a read that never answers or an answer of another shape ends the stream quietly', async () => {
  for (const answer of [
    async () => {
      throw new Error('No task found with ID: task')
    },
    async () => ({ output: 'x' }),
    () => new Promise<unknown>(() => {}),
  ]) {
    let reads = 0
    const outputs = new CommandOutputs(
      () => {
        reads += 1
        return answer()
      },
      5,
      20,
    )
    const sink = recordingSink()
    outputs.call('call', sink)
    outputs.taskStarted('task', 'call', false)
    await sleep(60)
    assert.equal(reads, 1)
    assert.deepEqual(sink.deltas, [])
    outputs.close()
  }
})

test('output that is gone before the first read shows nothing, and output that shrinks ends the stream', async () => {
  const cli = fakeCli()
  const outputs = new CommandOutputs(cli.read, 5)
  const sink = recordingSink()
  outputs.call('call', sink)
  cli.outputs.set('task', '')
  outputs.taskStarted('task', 'call', false)
  await waitFor(() => cli.reads.length >= 2, 'reads')
  assert.deepEqual(sink.deltas, [])

  cli.outputs.set('task', 'abc\n')
  await waitFor(() => sink.deltas.length === 1, 'output')
  cli.outputs.set('task', '')
  await sleep(20)
  const reads = cli.reads.length
  await sleep(20)
  assert.equal(cli.reads.length, reads)
  assert.deepEqual(sink.deltas, ['abc\n'])
  outputs.close()
})

test('a turn that ended takes no more output', async () => {
  const cli = fakeCli()
  const outputs = new CommandOutputs(cli.read, 5)
  const sink = recordingSink()
  outputs.call('call', sink)
  cli.outputs.set('task', 'one\n')
  outputs.taskStarted('task', 'call', false)
  await waitFor(() => sink.deltas.length === 1, 'output')
  sink.open = false
  cli.outputs.set('task', 'one\ntwo\n')
  await sleep(30)
  assert.deepEqual(sink.deltas, ['one\n'])
  outputs.close()
})

test('a command moved to the background streams again from its start after its result, then says how it ended', async () => {
  const cli = fakeCli()
  const outputs = new CommandOutputs(cli.read, 5)
  const turn = recordingSink()
  const thread = recordingSink()
  const backgroundFor: string[] = []
  outputs.call('call', turn)
  cli.outputs.set('task', 'building\n')
  outputs.taskStarted('task', 'call', false)
  await waitFor(() => turn.deltas.length === 1, 'foreground output')

  outputs.taskBackgrounded('task')
  outputs.callEnded(
    'call',
    (taskId) => {
      backgroundFor.push(taskId)
      return thread
    },
    () => false,
  )
  // A second result for the same call changes nothing.
  outputs.callEnded(
    'call',
    () => recordingSink(),
    () => true,
  )
  await waitFor(() => thread.deltas.length === 1, 'background output')
  assert.deepEqual(thread.deltas, ['\nbuilding\n'])

  cli.outputs.set('task', 'building\ndone')
  outputs.taskEnded('task')
  outputs.taskNotified(
    'task',
    'Background command "make" was stopped after reaching its background time limit',
  )
  await waitFor(() => thread.deltas.length === 3, 'end note')
  assert.deepEqual(thread.deltas, [
    '\nbuilding\n',
    'done',
    '\n[Background command "make" was stopped after reaching its background time limit]\n',
  ])
  assert.deepEqual(turn.deltas, ['building\n'])
  assert.deepEqual(backgroundFor, ['task'])
  outputs.close()
})

test("a background task_started that follows its call's result still finds the call", async () => {
  const cli = fakeCli()
  const outputs = new CommandOutputs(cli.read, 5)
  const turn = recordingSink()
  const thread = recordingSink()
  outputs.call('call', turn)
  outputs.callEnded(
    'call',
    () => thread,
    () => false,
  )
  cli.outputs.set('task', 'listening\n')
  outputs.taskStarted('task', 'call', true)
  await waitFor(() => thread.deltas.length === 1, 'output')
  // A command that completed needs no note.
  outputs.taskNotified('task', null)
  await sleep(20)
  assert.deepEqual(thread.deltas, ['\nlistening\n'])
  assert.deepEqual(turn.deltas, [])
  outputs.close()
})

test('without get_task_output, with polling off or once closed, nothing is read', async () => {
  const cli = fakeCli()
  cli.outputs.set('task', 'out\n')
  const closed = new CommandOutputs(cli.read, 5)
  closed.close()
  for (const outputs of [new CommandOutputs(null, 5), new CommandOutputs(cli.read, 0), closed]) {
    const sink = recordingSink()
    outputs.call('call', sink)
    outputs.taskStarted('task', 'call', false)
    await sleep(20)
    assert.deepEqual(sink.deltas, [])
    outputs.close()
  }
  assert.deepEqual(cli.reads, [])
})

test("other tools' results do not crowd out a Bash call waiting for its background task", async () => {
  const cli = fakeCli()
  const outputs = new CommandOutputs(cli.read, 5)
  const thread = recordingSink()
  outputs.call('bash', recordingSink())
  outputs.callEnded(
    'bash',
    () => thread,
    () => false,
  )
  // Reads, edits and agent calls of the same turn end here too.
  for (let index = 0; index < 40; index += 1)
    outputs.callEnded(
      `other-${index}`,
      () => recordingSink(),
      () => false,
    )
  cli.outputs.set('task', 'listening\n')
  outputs.taskStarted('task', 'bash', true)
  await waitFor(() => thread.deltas.length === 1, 'output')
  assert.deepEqual(thread.deltas, ['\nlistening\n'])
  // A task that names one of those other calls is not a shell of the main loop.
  cli.outputs.set('other', 'x\n')
  outputs.taskStarted('other', 'other-39', true)
  await sleep(20)
  assert.ok(!cli.reads.includes('other'))
  outputs.close()
})
