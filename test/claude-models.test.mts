import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_EFFORTS,
  defaultReasoningEffort,
  listClaudeModels,
  noteClaudeModels,
  reasoningEffortOptions,
  reportedClaudeModel,
} from '../src/claude-models.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'

const ALL = ['low', 'medium', 'high', 'xhigh', 'max']

// Shaped like Query.supportedModels() from Claude Code: both effort fields are
// left out on a model that takes no effort.
const REPORT = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-4-7',
    displayName: 'Default (recommended)',
    description: 'Opus 4.7 · Most capable for complex work',
    supportsEffort: true,
    supportedEffortLevels: ALL,
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-4-7',
    displayName: 'Opus',
    description: 'Opus 4.7 · Most capable for complex work',
    supportsEffort: true,
    supportedEffortLevels: ALL,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-4-6',
    displayName: 'Sonnet',
    description: 'Sonnet 4.6 · Best for everyday tasks',
    supportsEffort: true,
    // Out of order, and with a level the adapter does not know.
    supportedEffortLevels: ['high', 'turbo', 'low', 'medium'],
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
  {
    value: 'claude-custom-1',
    displayName: 'claude-custom-1',
    description: 'Custom model',
    supportsEffort: true,
  },
]

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-models-'))
  const previous = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = home
  try {
    return await run(home)
  } finally {
    if (previous == null) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

function efforts(sdkModel: string | null): string[] | null {
  const model = reportedClaudeModel(sdkModel)
  return model ? [...model.efforts] : null
}

test('noteClaudeModels keeps each model its own efforts and merges later reports', async () => {
  await withHome(async (home) => {
    const catalog = join(home, 'claude-models.json')
    assert.deepEqual(listClaudeModels(), [])
    assert.equal(reportedClaudeModel('opus'), null)

    // An empty report, and one from a Claude Code that says nothing about
    // effort, leave model/list on its static efforts.
    noteClaudeModels([])
    noteClaudeModels(undefined)
    noteClaudeModels([
      { value: 'opus', displayName: 'Opus', description: 'Opus' },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku' },
    ])
    assert.deepEqual(listClaudeModels(), [])
    assert.equal(existsSync(catalog), false)

    noteClaudeModels(REPORT)
    assert.deepEqual(
      listClaudeModels().map((model) => [model.value, model.efforts.join(',')]),
      [
        ['default', ALL.join(',')],
        ['opus', ALL.join(',')],
        ['sonnet', 'low,medium,high'],
        ['haiku', ''],
        // Takes effort without saying which levels.
        ['claude-custom-1', DEFAULT_EFFORTS.join(',')],
      ],
    )
    const saved = JSON.parse(await readFile(catalog, 'utf8'))
    assert.deepEqual(saved.models[1], {
      value: 'opus',
      resolvedModel: 'claude-opus-4-7',
      displayName: 'Opus',
      description: 'Opus 4.7 · Most capable for complex work',
      efforts: ALL,
    })
    assert.equal(saved.models[4].resolvedModel, null)

    // Another session reports its own model next to the presets: rows are
    // replaced by value and new ones appended, so earlier rows stay put.
    noteClaudeModels([
      {
        value: 'opus',
        resolvedModel: 'claude-opus-4-7',
        displayName: 'Opus',
        description: 'Opus 4.7 · Most capable for complex work',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      { value: 'claude-custom-2', displayName: 'claude-custom-2', description: '' },
    ])
    assert.deepEqual(
      listClaudeModels().map((model) => model.value),
      ['default', 'opus', 'sonnet', 'haiku', 'claude-custom-1', 'claude-custom-2'],
    )
    assert.deepEqual(efforts('opus'), ['low', 'medium', 'high'])
    assert.deepEqual(efforts('claude-custom-2'), [])
  })
})

test('the reported models are read back from disk after a restart', async () => {
  await withHome(async (home) => {
    await writeFile(
      join(home, 'claude-models.json'),
      JSON.stringify({
        models: [
          { value: 'opus', resolvedModel: 'claude-opus-4-7', efforts: ['max', 'low', 'huge'] },
          { value: '', efforts: ['low'] },
          { value: 'sonnet' },
          'haiku',
        ],
      }),
    )
    assert.deepEqual(listClaudeModels(), [
      {
        value: 'opus',
        resolvedModel: 'claude-opus-4-7',
        displayName: '',
        description: '',
        efforts: ['low', 'max'],
      },
    ])
  })
  await withHome(async (home) => {
    await writeFile(join(home, 'claude-models.json'), 'not json')
    assert.deepEqual(listClaudeModels(), [])
  })
})

test('reportedClaudeModel matches a picker value, then the model id behind it', async () => {
  await withHome(async () => {
    noteClaudeModels(REPORT)
    assert.equal(reportedClaudeModel('OPUS')?.value, 'opus')
    // No model is Claude Code's own default.
    assert.equal(reportedClaudeModel(null)?.value, 'default')
    // A gateway alias that names the full model id finds the preset row,
    // not the 'default' one that runs the same model.
    assert.equal(reportedClaudeModel('claude-opus-4-7')?.value, 'opus')
    assert.deepEqual(efforts('claude-haiku-4-5'), [])
    // 'sonnet[1m]' is not listed: Sonnet's efforts, but not its description.
    const longContext = reportedClaudeModel('sonnet[1m]')
    assert.deepEqual(longContext?.efforts, ['low', 'medium', 'high'])
    assert.equal(longContext?.description, '')
    assert.equal(reportedClaudeModel('opusplan'), null)
    assert.equal(reportedClaudeModel('glm-5'), null)
  })
})

test('defaultReasoningEffort keeps the configured level where the model takes it', () => {
  assert.equal(defaultReasoningEffort(['low', 'medium', 'high', 'xhigh', 'max'], 'max'), 'max')
  assert.equal(defaultReasoningEffort(['low', 'medium', 'high'], 'max'), 'high')
  assert.equal(defaultReasoningEffort(['low', 'high'], 'medium'), 'low')
  assert.equal(defaultReasoningEffort(['high', 'max'], 'low'), 'high')
  assert.equal(defaultReasoningEffort(DEFAULT_EFFORTS, 'xhigh'), 'xhigh')
  assert.equal(defaultReasoningEffort(DEFAULT_EFFORTS, null), 'medium')
  // Codex reports 'none' for a model without reasoning levels.
  assert.equal(defaultReasoningEffort([], 'medium'), 'none')
  assert.deepEqual(reasoningEffortOptions(['xhigh', 'max']), [
    { reasoningEffort: 'xhigh', description: 'Extra-high reasoning' },
    { reasoningEffort: 'max', description: 'Maximum reasoning' },
  ])
})

const context: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn',
  prompt: 'models check',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  enableFileCheckpointing: false,
  outputFormat: null,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

async function runInitTurn(supportedModels: (() => Promise<unknown>) | null): Promise<boolean> {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: () => {
      const messages = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-1' }
        yield { type: 'result', subtype: 'success', result: 'done' }
      })()
      return supportedModels ? Object.assign(messages, { supportedModels }) : messages
    },
  })
  let completed = false
  await runtime.runTurn(context, {
    onEvent: async (event) => {
      if (event.type === 'completed') completed = event.success
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onUserInputRequest: async () => ({ answers: {} }),
  })
  return completed
}

test('a Claude session notes the models Claude Code reports when it starts', async () => {
  const reap = process.env.CLAUDE_CODEX_REAP_ORPHANED_CLI
  process.env.CLAUDE_CODEX_REAP_ORPHANED_CLI = '0'
  await withHome(async (home) => {
    // An SDK without supportedModels() leaves the static efforts in place.
    assert.equal(await runInitTurn(null), true)
    assert.equal(
      await runInitTurn(async () => {
        throw new Error('not supported')
      }),
      true,
    )
    assert.deepEqual(listClaudeModels(), [])

    assert.equal(await runInitTurn(async () => REPORT), true)
    const deadline = Date.now() + 2_000
    while (!existsSync(join(home, 'claude-models.json')) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(efforts('opus'), ALL)
    assert.deepEqual(efforts('haiku'), [])
  }).finally(() => {
    if (reap == null) delete process.env.CLAUDE_CODEX_REAP_ORPHANED_CLI
    else process.env.CLAUDE_CODEX_REAP_ORPHANED_CLI = reap
  })
})
