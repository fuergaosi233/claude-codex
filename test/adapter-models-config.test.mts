import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ProviderLoopConfigProjectionResult } from '../src/provider-loop-config.mjs'
import { adapter, JsonLineReader, json, spawnMockAdapter } from './support/adapter-harness.mjs'

test('model/list exposes Claude model aliases and Codex-safe reasoning efforts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
      CLAUDE_CODEX_DEFAULT_EFFORT: 'xhigh',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(1)
    assert.equal(config.result.config.model, 'opus')
    assert.equal(config.result.config.model_reasoning_effort, 'xhigh')
    assert.equal(config.result.config.model_provider, 'claude-code')
    assert.equal(config.result.config.model_providers['claude-code'].name, 'Claude Code')
    assert.equal(config.result.config.model_providers['claude-code'].requires_openai_auth, false)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult
    assert.deepEqual(
      providerLoopConfig.providers.map((provider) => provider.id),
      ['claude-code', 'codex'],
    )
    assert.deepEqual(providerLoopConfig.issues, [])
    const claudeCodeProvider = providerLoopConfig.providers.find(
      (provider) => provider.id === 'claude-code',
    )
    assert.ok(claudeCodeProvider)
    assert.equal(claudeCodeProvider.loopId, 'native-claude-code-sdk')
    assert.equal(claudeCodeProvider.providerFamily, 'anthropic')
    assert.equal(claudeCodeProvider.status, 'stable')
    assert.equal(claudeCodeProvider.supportsSteer, true)
    const allowedCredentialSources = new Set<string>(claudeCodeProvider.allowedCredentialSources)
    assert.equal(allowedCredentialSources.has('user-api-key'), true)
    assert.equal(allowedCredentialSources.has('personal-session'), false)
    assert.equal(allowedCredentialSources.has('browser-cookie'), false)

    proc.stdin.write(json({ id: 7, method: 'account/read', params: {} }))
    const account = await reader.nextResponse(7)
    assert.deepEqual(account.result.account, { type: 'amazonBedrock' })
    assert.equal(account.result.requiresOpenaiAuth, false)

    // The App's main process reads its flags only under the auth method it
    // derives from account/read.
    proc.stdin.write(json({ id: 8, method: 'getAuthStatus', params: {} }))
    const authStatus = await reader.nextResponse(8)
    assert.deepEqual(authStatus.result, {
      authMethod: 'amazonBedrock',
      authToken: null,
      requiresOpenaiAuth: false,
    })

    proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
    const models = await reader.nextResponse(2)
    const ids = models.result.data.map((model: any) => model.id)
    assert.equal(ids.includes('sonnet'), true)
    assert.equal(ids.includes('opus'), true)
    assert.equal(ids.includes('fable'), true)
    assert.equal(ids.includes('sonnet-1m'), true)
    assert.equal(ids.includes('opus-plan'), true)
    const fable = models.result.data.find((model: any) => model.id === 'fable')
    assert.equal(fable.displayName, 'Claude Fable')
    const opusPlan = models.result.data.find((model: any) => model.id === 'opus-plan')
    assert.match(opusPlan.displayName, /Opus.*Sonnet/)
    assert.match(opusPlan.description, /plan/i)
    assert.match(opusPlan.description, /Sonnet/)
    assert.equal(
      ids.some((id: string) => id.startsWith('runtime-')),
      false,
    )
    const opus = models.result.data.find((model: any) => model.id === 'opus')
    assert.equal(opus.isDefault, true)
    assert.equal('serviceTiers' in opus, false)
    assert.equal(models.result.data.filter((model: any) => model.isDefault === true).length, 1)
    assert.deepEqual(
      opus.supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort),
      ['low', 'medium', 'high', 'xhigh'],
    )

    proc.stdin.write(
      json({
        id: 3,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'haiku', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await reader.nextResponse(3)
    proc.stdin.write(json({ id: 4, method: 'config/read', params: {} }))
    const updatedConfig = await reader.nextResponse(4)
    assert.equal(updatedConfig.result.config.model, 'haiku')
    assert.equal(updatedConfig.result.config.model_reasoning_effort, 'low')

    proc.stdin.write(
      json({
        id: 5,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'runtime-agent-http', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await reader.nextResponse(5)
    proc.stdin.write(json({ id: 6, method: 'config/read', params: {} }))
    const repairedConfig = await reader.nextResponse(6)
    assert.equal(repairedConfig.result.config.model, 'haiku')
    assert.equal(repairedConfig.result.config.model_reasoning_effort, 'medium')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('model/list offers each Claude model the efforts Claude Code reported for it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const adapterHome = join(home, 'adapter')
  const all = ['low', 'medium', 'high', 'xhigh', 'max']
  const opusDescription = 'Opus 4.7 · Most capable for complex work'
  // What an earlier Claude session reported (see claude-models.mts).
  await mkdir(adapterHome, { recursive: true })
  await writeFile(
    join(adapterHome, 'claude-models.json'),
    JSON.stringify({
      models: [
        {
          value: 'default',
          resolvedModel: 'claude-opus-4-7',
          displayName: 'Default (recommended)',
          description: opusDescription,
          efforts: all,
        },
        {
          value: 'opus',
          resolvedModel: 'claude-opus-4-7',
          displayName: 'Opus',
          description: opusDescription,
          efforts: all,
        },
        {
          value: 'sonnet',
          resolvedModel: 'claude-sonnet-4-6',
          displayName: 'Sonnet',
          description: 'Sonnet 4.6 · Best for everyday tasks',
          efforts: ['low', 'medium', 'high'],
        },
        {
          value: 'haiku',
          resolvedModel: 'claude-haiku-4-5',
          displayName: 'Haiku',
          description: 'Haiku 4.5 · Fastest for quick answers',
          efforts: [],
        },
        {
          value: 'opusplan',
          resolvedModel: 'claude-opus-4-7',
          displayName: 'Opus Plan Mode',
          description: 'Use Opus in plan mode, Sonnet otherwise',
          efforts: all,
        },
      ],
    }),
  )
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_HOME: adapterHome,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: JSON.stringify([
        'opus',
        'sonnet',
        'sonnet-1m',
        'haiku',
        'opus-plan',
        { id: 'team-opus', sdkModel: 'claude-opus-4-7', displayName: 'Team Opus' },
        'glm-5',
      ]),
      CLAUDE_CODEX_MODEL_ALIASES: '',
      CLAUDE_CODEX_EFFORT_ALIASES: '',
      CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
      CLAUDE_CODEX_DEFAULT_EFFORT: 'max',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(1)
    assert.equal(config.result.config.model_reasoning_effort, 'max')

    proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
    const models = await reader.nextResponse(2)
    // Ids and names stay the adapter's own.
    assert.deepEqual(
      models.result.data.map((model: any) => model.id),
      ['opus', 'sonnet', 'sonnet-1m', 'haiku', 'opus-plan', 'team-opus', 'glm-5'],
    )
    const byId = new Map<string, any>(models.result.data.map((model: any) => [model.id, model]))
    const efforts = (id: string) =>
      byId.get(id).supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort)

    const opus = byId.get('opus')
    assert.deepEqual(efforts('opus'), all)
    assert.equal(opus.defaultReasoningEffort, 'max')
    assert.equal(opus.displayName, 'Claude Opus')
    assert.equal(opus.description, opusDescription)
    assert.equal(opus.isDefault, true)
    assert.deepEqual(opus.supportedReasoningEfforts.at(-1), {
      reasoningEffort: 'max',
      description: 'Maximum reasoning',
    })
    // A model without max defaults to the closest level below.
    assert.deepEqual(efforts('sonnet'), ['low', 'medium', 'high'])
    assert.equal(byId.get('sonnet').defaultReasoningEffort, 'high')
    // Claude Code listed no 1M variant: Sonnet's efforts, the adapter's text.
    assert.deepEqual(efforts('sonnet-1m'), ['low', 'medium', 'high'])
    assert.equal(byId.get('sonnet-1m').description, 'Claude Code runtime model')
    // Haiku takes no effort, which Codex reports as 'none'.
    assert.deepEqual(efforts('haiku'), [])
    assert.equal(byId.get('haiku').defaultReasoningEffort, 'none')
    // Opus Plan keeps the adapter's description of the hybrid mode.
    assert.deepEqual(efforts('opus-plan'), all)
    assert.match(byId.get('opus-plan').description, /does not enable plan mode/)
    // A gateway alias finds its model by the id it passes to Claude Code.
    assert.deepEqual(efforts('team-opus'), all)
    assert.equal(byId.get('team-opus').displayName, 'Team Opus')
    assert.equal(byId.get('team-opus').description, opusDescription)
    // A model Claude Code never reported keeps the static list.
    assert.deepEqual(efforts('glm-5'), ['low', 'medium', 'high', 'xhigh'])
    assert.equal(byId.get('glm-5').defaultReasoningEffort, 'xhigh')

    // Max is a thread effort like the others and reaches Claude Code.
    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'opus',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(3)
    const threadId = start.result.thread.id
    assert.equal(start.result.reasoningEffort, 'max')
    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/start',
        params: {
          threadId,
          model: 'opus',
          effort: 'max',
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(4)
    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=opus effort=max')
    proc.stdin.write(json({ id: 5, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(5)
    assert.equal(resume.result.reasoningEffort, 'max')

    // On Haiku the App sends its defaultReasoningEffort, 'none': the turn
    // reaches Claude Code without an effort, and the thread keeps its own.
    proc.stdin.write(
      json({
        id: 6,
        method: 'turn/start',
        params: {
          threadId,
          model: 'haiku',
          effort: 'none',
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(6)
    text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=haiku effort=default')
    proc.stdin.write(json({ id: 7, method: 'thread/resume', params: { threadId } }))
    const haikuResume = await reader.nextResponse(7)
    assert.equal(haikuResume.result.model, 'haiku')
    assert.equal(haikuResume.result.reasoningEffort, 'max')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/read exposes sanitized provider loop selection over stdio', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_PROVIDER: 'codex',
      CLAUDE_CODEX_AGENT_LOOP: 'codex-jsonl-proxy',
      CLAUDE_CODEX_RUNTIME_TYPE: '',
      CLAUDE_CODEX_RUNTIME: '',
      CLAUDE_CODEX_BACKEND: '',
      CLAUDE_CODEX_MOCK: '',
      CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(1)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult

    assert.deepEqual(
      providerLoopConfig.providers.map((provider) => provider.id),
      ['claude-code', 'codex'],
    )
    assert.deepEqual(providerLoopConfig.selection, {
      providerId: 'codex',
      loopId: 'codex-jsonl-proxy',
      runtimeType: 'codex-proxy',
      source: 'environment',
    })
    assert.deepEqual(providerLoopConfig.issues, [])
    assert.deepEqual(Object.keys(providerLoopConfig.providers[0] ?? {}).sort(), [
      'allowedCredentialSources',
      'approvalFidelity',
      'complianceNotes',
      'displayName',
      'eventFidelity',
      'gatewayPolicy',
      'id',
      'loopId',
      'providerFamily',
      'status',
      'supportsInterrupt',
      'supportsResume',
      'supportsSteer',
    ])
    assert.equal(JSON.stringify(providerLoopConfig).includes('personal-session'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/read resolves saved provider loop selection without projecting raw keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_PROVIDER: '',
      CLAUDE_CODEX_AGENT_LOOP: '',
      CLAUDE_CODEX_RUNTIME_TYPE: '',
      CLAUDE_CODEX_RUNTIME: '',
      CLAUDE_CODEX_BACKEND: '',
      CLAUDE_CODEX_MOCK: '',
      CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'config/value/write',
        params: { keyPath: 'provider_loop_provider', value: 'codex' },
      }),
    )
    await reader.nextResponse(1)

    proc.stdin.write(json({ id: 2, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(2)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult

    assert.deepEqual(providerLoopConfig.selection, {
      providerId: 'codex',
      loopId: 'codex-jsonl-proxy',
      runtimeType: 'codex-proxy',
      source: 'config',
    })
    assert.equal('provider_loop_provider' in config.result.config, false)

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'sonnet' },
      }),
    )
    const started = await reader.nextResponse(3)
    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/resume',
        params: { threadId: started.result.thread.id, model: 'opus' },
      }),
    )
    const resumed = await reader.nextResponse(4)
    assert.equal(resumed.result.model, 'sonnet')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config writes persist across adapter restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const first = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
        CLAUDE_CODEX_DEFAULT_EFFORT: 'high',
        NODE_NO_WARNINGS: '1',
      },
    })
    const firstReader = new JsonLineReader(first)
    first.stdin.write(
      json({
        id: 1,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'haiku', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await firstReader.nextResponse(1)
    first.kill()
    await once(first, 'exit')

    const second = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
        CLAUDE_CODEX_DEFAULT_EFFORT: 'high',
        NODE_NO_WARNINGS: '1',
      },
    })
    const secondReader = new JsonLineReader(second)
    try {
      second.stdin.write(json({ id: 2, method: 'config/read', params: {} }))
      const config = await secondReader.nextResponse(2)
      assert.equal(config.result.config.model, 'haiku')
      assert.equal(config.result.config.model_reasoning_effort, 'low')

      second.stdin.write(json({ id: 3, method: 'model/list', params: {} }))
      const models = await secondReader.nextResponse(3)
      const haiku = models.result.data.find((model: any) => model.id === 'haiku')
      assert.equal(haiku.isDefault, true)
      assert.equal(haiku.defaultReasoningEffort, 'low')
    } finally {
      second.kill()
      await once(second, 'exit')
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('invalid persisted model selections are repaired to a selectable model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const adapterConfigDir = join(home, 'claude-codex-adapter')
    await mkdir(adapterConfigDir, { recursive: true })
    await writeFile(
      join(adapterConfigDir, 'config.json'),
      JSON.stringify(
        { model: 'runtime-agent-sdk-sidecar', model_reasoning_effort: 'high' },
        null,
        2,
      ) + '\n',
    )

    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
        NODE_NO_WARNINGS: '1',
      },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
      const config = await reader.nextResponse(1)
      assert.equal(config.result.config.model, 'opus')
      assert.equal(config.result.config.model_reasoning_effort, 'high')

      proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
      const models = await reader.nextResponse(2)
      assert.equal(
        models.result.data.some((model: any) => model.id.startsWith('runtime-')),
        false,
      )
      assert.deepEqual(
        models.result.data
          .filter((model: any) => model.isDefault === true)
          .map((model: any) => model.id),
        ['opus'],
      )
    } finally {
      proc.kill()
      await once(proc, 'exit')
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Fable and Opus picker aliases reach the runtime without changing plan mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    let id = 2
    for (const [model, expected] of [
      ['fable', 'fable'],
      ['claude-fable', 'fable'],
      ['opus', 'opus'],
      ['opus-plan', 'opusplan'],
    ]) {
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: {
            threadId,
            model,
            effort: 'high',
            input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
          },
        }),
      )
      await reader.nextResponse(id++)
      let text = ''
      for (;;) {
        const message = await reader.next()
        if (message.method === 'item/agentMessage/delta') text += message.params.delta
        if (message.method === 'turn/completed') break
      }
      assert.equal(text, `model=${expected} effort=high`)
    }
    proc.stdin.write(
      json({
        id,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'plan mode check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(id)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'planMode=false')
  } finally {
    proc.kill()
    await once(proc, 'exit')
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

for (const configuredModels of ['sonnet', '["sonnet"]', '[{"id":"sonnet"}]']) {
  test(`explicit model list remains authoritative: ${configuredModels}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_MODELS: configuredModels,
        NODE_NO_WARNINGS: '1',
      },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'model/list', params: {} }))
      const models = await reader.nextResponse(1)
      const ids = models.result.data.map((model: any) => model.id)
      assert.equal(ids.includes('sonnet'), true)
      assert.equal(ids.includes('fable'), false)
      assert.equal(ids.includes('opus-plan'), false)
    } finally {
      proc.kill()
      await once(proc, 'exit')
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  })
}

test('Codex++ model and effort selections map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      CLAUDE_CODEX_EFFORT_ALIASES: JSON.stringify({ xhigh: 'max' }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet-1m',
          effort: 'high',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'sonnet-1m')
    assert.equal(start.result.reasoningEffort, 'high')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'sonnet-1m',
          effort: 'xhigh',
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=sonnet[1m] effort=max')

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(3)
    assert.equal(resume.result.model, 'sonnet-1m')
    assert.equal(resume.result.reasoningEffort, 'xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex app config payload model and effort map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          config: { model: 'opus', model_reasoning_effort: 'high' },
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'opus')
    assert.equal(start.result.reasoningEffort, 'high')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          config: { model: 'haiku', model_reasoning_effort: 'xhigh' },
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=haiku effort=xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex app model ids and outputSchema map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      CLAUDE_CODEX_DEFAULT_MODEL: 'claude-opus-4-6',
      CLAUDE_CODEX_SUMMARY_MODEL: 'haiku',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'gpt-5.4-mini',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'gpt-5.4-mini')

    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'gpt-5.4-mini',
          outputSchema,
          input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.deepEqual(JSON.parse(text), {
      model: 'haiku',
      outputFormat: { type: 'json_schema', schema: outputSchema },
    })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// The thread/start the App sends to title a chat, on its own OpenAI model.
function titleThreadStart(id: number): string {
  return json({
    id,
    method: 'thread/start',
    params: {
      model: 'gpt-5.6-luna',
      modelProvider: null,
      allowProviderModelFallback: true,
      cwd: process.cwd(),
      approvalPolicy: 'never',
      permissions: ':read-only',
      config: { web_search: 'disabled', model_reasoning_effort: 'low' },
      personality: null,
      ephemeral: true,
      threadSource: 'thread_title',
      experimentalRawEvents: false,
      dynamicTools: null,
      serviceTier: null,
    },
  })
}

// No Codex proxy; summary turns run on haiku.
const titleAdapterEnv = {
  CLAUDE_CODEX_PROVIDER: '',
  CLAUDE_CODEX_AGENT_LOOP: '',
  CLAUDE_CODEX_RUNTIME_TYPE: '',
  CLAUDE_CODEX_RUNTIME: '',
  CLAUDE_CODEX_BACKEND: '',
  CLAUDE_CODEX_MODELS: '',
  CLAUDE_CODEX_MODEL_ALIASES: '',
  CLAUDE_CODEX_SUMMARY_MODEL: 'haiku',
}

test('with Codex routing off, the App titles a chat on the Claude summary model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, {
    ...titleAdapterEnv,
    CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
  })
  const reader = new JsonLineReader(proc)
  const runTurn = async (id: number, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method: 'turn/start', params }))
    assert.equal((await reader.nextResponse(id)).error, undefined)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') return { text, turn: message.params.turn }
    }
  }
  try {
    proc.stdin.write(titleThreadStart(1))
    const start = await reader.nextResponse(1)
    assert.equal(start.error, undefined)
    assert.equal(start.result.model, 'haiku')
    assert.equal(start.result.thread.ephemeral, true)
    const threadId = start.result.thread.id

    // The App's title turn: no model, an outputSchema, JSON back. The App's
    // zod schema declares draft 2020-12, which the Claude CLI refuses.
    const outputSchema = {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 36 },
        description: { type: 'string', minLength: 1 },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    }
    const title = await runTurn(2, {
      threadId,
      turnTrigger: 'thread_title',
      input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
      cwd: null,
      approvalPolicy: null,
      permissions: ':read-only',
      model: null,
      effort: null,
      summary: 'none',
      personality: null,
      collaborationMode: null,
      outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...outputSchema },
    })
    assert.equal(title.turn.status, 'completed')
    assert.deepEqual(JSON.parse(title.text), {
      model: 'haiku',
      outputFormat: { type: 'json_schema', schema: outputSchema },
    })

    // A Codex model on a later turn maps the same way.
    const plain = await runTurn(3, {
      threadId,
      model: 'gpt-5.6-luna',
      input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
    })
    assert.equal(plain.turn.status, 'completed')
    assert.equal(JSON.parse(plain.text).model, 'haiku')

    // The App describes a Claude chat in an ephemeral fork, which stays on its model.
    proc.stdin.write(
      json({ id: 4, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const chat = await reader.nextResponse(4)
    proc.stdin.write(
      json({
        id: 5,
        method: 'thread/fork',
        params: {
          threadId: chat.result.thread.id,
          model: 'gpt-5.6-luna',
          ephemeral: true,
          excludeTurns: true,
          threadSource: 'thread_description',
        },
      }),
    )
    const fork = await reader.nextResponse(5)
    assert.equal(fork.error, undefined)
    assert.equal(fork.result.model, 'sonnet')

    // A chat of the user's own on a Codex model has nowhere to run.
    proc.stdin.write(
      json({
        id: 6,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'gpt-5.6-luna' },
      }),
    )
    const refused = await reader.nextResponse(6)
    assert.equal(refused.result, undefined)
    assert.match(
      refused.error?.message ?? '',
      /Codex model routing is disabled, so gpt-5\.6-luna cannot run here; pick a Claude model/,
    )

    // Nor does a first message that names one in a chat started on Claude.
    proc.stdin.write(
      json({
        id: 7,
        method: 'turn/start',
        params: {
          threadId: chat.result.thread.id,
          model: 'gpt-5.6-luna',
          input: [{ type: 'text', text: 'hi', text_elements: [] }],
        },
      }),
    )
    const firstTurn = await reader.nextResponse(7)
    assert.equal(firstTurn.result, undefined)
    assert.match(
      firstTurn.error?.message ?? '',
      /Codex model routing is disabled, so gpt-5\.6-luna cannot run here; pick a Claude model/,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('with Codex routing on, the App title thread keeps its Codex model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { ...titleAdapterEnv, CLAUDE_CODEX_DISABLE_CODEX_PROXY: '' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(titleThreadStart(1))
    const start = await reader.nextResponse(1)
    assert.equal(start.error, undefined)
    assert.equal(start.result.model, 'gpt-5.6-luna')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a thread keeps the runtime backend of its conversation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // The picker lists gpt-5.5, as it lists the Codex models with routing on.
  const proc = spawnMockAdapter(home, {
    ...titleAdapterEnv,
    CLAUDE_CODEX_DISABLE_CODEX_PROXY: '',
    CLAUDE_CODEX_MODELS: 'sonnet,opus,haiku,gpt-5.5',
  })
  const reader = new JsonLineReader(proc)
  let nextId = 1
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId++
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  const waitForTurnCompleted = async () => {
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') return { text, turn: message.params.turn }
    }
  }
  const input = [{ type: 'text', text: 'output schema check', text_elements: [] }]
  const resumed = async (threadId: string) => (await request('thread/resume', { threadId })).result
  const threadModel = async (threadId: string) => (await resumed(threadId)).model
  const crossing =
    /cannot change runtime backend from claude to codex for gpt-5\.5; start a new thread/
  try {
    const chat = await request('thread/start', { cwd: process.cwd(), model: 'sonnet' })
    assert.equal(chat.error, undefined)
    const threadId = chat.result.thread.id
    assert.equal((await request('turn/start', { threadId, input })).error, undefined)
    await waitForTurnCompleted()

    // A Codex model would move the Claude conversation to Codex: refused, by
    // a turn, by the model menu and by a metadata update, and the thread keeps
    // its model and everything else the refused request carried.
    const crossed = await request('turn/start', { threadId, model: 'gpt-5.5', input })
    assert.equal(crossed.result, undefined)
    assert.match(crossed.error?.message ?? '', crossing)
    assert.equal(await threadModel(threadId), 'sonnet')
    const menu = await request('thread/settings/update', {
      threadId,
      model: 'gpt-5.5',
      effort: 'low',
    })
    assert.equal(menu.result, undefined)
    assert.match(menu.error?.message ?? '', crossing)
    const metadata = await request('thread/metadata/update', {
      threadId,
      model: 'gpt-5.5',
      isPinned: true,
    })
    assert.equal(metadata.result, undefined)
    assert.match(metadata.error?.message ?? '', crossing)
    const kept = await resumed(threadId)
    assert.equal(kept.model, 'sonnet')
    assert.notEqual(kept.reasoningEffort, 'low')
    assert.equal(kept.thread.isPinned, false)

    // Another Claude model is fine and becomes the thread's model.
    const opus = await request('turn/start', { threadId, model: 'opus', input })
    assert.equal(opus.error, undefined)
    assert.equal(JSON.parse((await waitForTurnCompleted()).text).model, 'opus')
    assert.equal(await threadModel(threadId), 'opus')

    // A structured summary turn names the App's Codex model: it runs on the
    // summary model for that turn alone.
    const summary = await request('turn/start', {
      threadId,
      model: 'gpt-5.4-mini',
      outputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      input,
    })
    assert.equal(summary.error, undefined)
    const summaryTurn = await waitForTurnCompleted()
    assert.equal(summaryTurn.turn.status, 'completed')
    assert.equal(JSON.parse(summaryTurn.text).model, 'haiku')
    assert.equal(await threadModel(threadId), 'opus')

    // The App starts a new chat's thread before anything is sent, and sends
    // the first message on whatever model was picked meanwhile: until there
    // is a conversation, the model picks the backend.
    const fresh = await request('thread/start', { cwd: process.cwd(), model: 'sonnet' })
    const freshId = fresh.result.thread.id
    const first = await request('turn/start', { threadId: freshId, model: 'gpt-5.5', input })
    assert.equal(first.error, undefined)
    await waitForTurnCompleted()
    assert.equal(await threadModel(freshId), 'gpt-5.5')
    // Its conversation is on Codex now, and does not move to Claude either.
    const back = await request('turn/start', { threadId: freshId, model: 'sonnet', input })
    assert.equal(back.result, undefined)
    assert.match(
      back.error?.message ?? '',
      /cannot change runtime backend from codex to claude for sonnet; start a new thread/,
    )
    assert.equal(await threadModel(freshId), 'gpt-5.5')

    // The same goes for a model picked through the settings of a chat with
    // nothing sent yet.
    const unsent = await request('thread/start', { cwd: process.cwd(), model: 'sonnet' })
    const unsentId = unsent.result.thread.id
    const picked = await request('thread/settings/update', { threadId: unsentId, model: 'gpt-5.5' })
    assert.equal(picked.error, undefined)
    assert.equal(await threadModel(unsentId), 'gpt-5.5')

    // The App sends the chat's current model along with other settings; that
    // is no change, even for a model the picker does not list.
    const unlisted = await request('thread/start', { cwd: process.cwd(), model: 'gpt-5.4' })
    const unlistedId = unlisted.result.thread.id
    assert.equal((await request('turn/start', { threadId: unlistedId, input })).error, undefined)
    await waitForTurnCompleted()
    const effort = await request('thread/settings/update', {
      threadId: unlistedId,
      model: 'gpt-5.4',
      effort: 'low',
    })
    assert.equal(effort.error, undefined)
    const unlistedThread = await resumed(unlistedId)
    assert.equal(unlistedThread.model, 'gpt-5.4')
    assert.equal(unlistedThread.reasoningEffort, 'low')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex title-generation turn runs through the runtime instead of a hardcoded local title', async () => {
  // We used to short-circuit Codex App's title-gen turn with a regex-derived
  // "处理X" string. That was forcing a hardcoded title regardless of what the
  // model would have produced. Now the turn flows through runRuntimeTurn just
  // like any other structured output turn — the model maps to the summary
  // alias (haiku) and the user message is recorded.
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLog = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_DEBUG_LOG: debugLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    const prompt = [
      'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.',
      'Generate a concise UI title (up to 36 characters) for this task.',
      'Fill the structured title field with plain text.',
      '',
      'User prompt:',
      'output schema check',
    ].join('\n')
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'gpt-5.4-mini',
          effort: 'medium',
          outputSchema,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        },
      }),
    )
    const turnStart = await reader.nextResponse(2)
    // The turn/start response envelope is empty/notLoaded like the real
    // app-server; the user message is recorded in turn history (verified via
    // thread/read below), not echoed back in the turn envelope.
    assert.deepEqual(turnStart.result.turn.items, [])
    assert.equal(turnStart.result.turn.itemsView, 'notLoaded')

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }

    // The user message IS recorded now (we no longer skip the items list) — it
    // shows up in the persisted turn history.
    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const read = await reader.nextResponse(3)
    const historyItems = (read.result.thread.turns as any[]).flatMap((t) => t.items)
    assert.equal(
      historyItems.some((item: any) => item.type === 'userMessage'),
      true,
    )
    // The text is whatever the runtime produced (the mock echoes the resolved
    // model + outputFormat). Importantly it must NOT be the old hardcoded
    // "处理X" string the local short-circuit would have produced.
    assert.doesNotMatch(text, /^\{"title":"处理/)
    const parsed = JSON.parse(text)
    assert.equal(
      parsed.model,
      'haiku',
      'gpt-5.4-mini should map to the summary model (haiku) when an outputSchema is set',
    )
    const logText = await readFile(debugLog, 'utf8')
    assert.doesNotMatch(
      logText,
      /turn\.internalTitle\.shortCircuit/,
      'no local title short-circuit should fire',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stateful HTTP bridge runtimes keep Codex title-generation turns local', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLog = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_RUNTIME_TYPE: 'agent-http',
      CLAUDE_CODEX_HTTP_BASE_URL: 'http://127.0.0.1:9',
      CLAUDE_CODEX_HTTP_MANAGE_BRIDGE: '1',
      CLAUDE_CODEX_DEBUG_LOG: debugLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'gpt-5.4-mini',
          outputSchema,
          input: [{ type: 'text', text: 'User prompt:\nhi', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.deepEqual(JSON.parse(text), { title: 'hi' })
    const logText = await readFile(debugLog, 'utf8')
    assert.match(logText, /"selectedType":"local-structured-summary"/)
    assert.doesNotMatch(logText, /"http\.bridge\.ensure\.start"/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('default runtime tool policy leaves Claude Code tools unrestricted unless env overrides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_ALLOWED_TOOLS: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'tool policy check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'allowedTools=default')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('capabilities and config/read report live web search unless CLAUDE_CODEX_WEBSEARCH=0', async () => {
  for (const [setting, webSearch, mode] of [
    ['', true, 'live'],
    ['0', false, 'disabled'],
  ] as const) {
    const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
    const proc = spawnMockAdapter(home, { CLAUDE_CODEX_WEBSEARCH: setting })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'modelProvider/capabilities/read', params: {} }))
      assert.equal((await reader.nextResponse(1)).result.webSearch, webSearch)
      proc.stdin.write(json({ id: 2, method: 'config/read', params: {} }))
      const { config } = (await reader.nextResponse(2)).result
      assert.equal(config.web_search, mode)
      // Codex reports a context window only when config.toml sets one.
      assert.equal(config.model_context_window, null)
      // What the App's settings saved still wins.
      proc.stdin.write(
        json({
          id: 3,
          method: 'config/value/write',
          params: { keyPath: 'web_search', value: 'cached' },
        }),
      )
      await reader.nextResponse(3)
      proc.stdin.write(json({ id: 4, method: 'config/read', params: {} }))
      assert.equal((await reader.nextResponse(4)).result.config.web_search, 'cached')
      // And Claude threads keep WebSearch with it.
      proc.stdin.write(json({ id: 5, method: 'modelProvider/capabilities/read', params: {} }))
      assert.equal((await reader.nextResponse(5)).result.webSearch, true)
    } finally {
      proc.kill()
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  }
})

test('config/value/write persists arbitrary settings keys across restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const env = { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' }
  // Round 1: write a custom key + a known typed key.
  const proc1 = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  let reader = new JsonLineReader(proc1)
  try {
    proc1.stdin.write(
      json({
        id: 1,
        method: 'config/value/write',
        params: { keyPath: 'approval_policy', value: 'never' },
      }),
    )
    await reader.nextResponse(1)
    proc1.stdin.write(
      json({
        id: 2,
        method: 'config/value/write',
        params: { keyPath: 'sandbox_mode', value: 'danger-full-access' },
      }),
    )
    await reader.nextResponse(2)
    proc1.stdin.write(json({ id: 3, method: 'config/read', params: {} }))
    const r = await reader.nextResponse(3)
    assert.equal(
      r.result.config.approval_policy,
      'never',
      'override should appear in config/read on the same process',
    )
    assert.equal(r.result.config.sandbox_mode, 'danger-full-access')
  } finally {
    proc1.kill()
    await once(proc1, 'exit')
  }

  // Round 2: a fresh adapter process re-reads from disk — overrides survive.
  const proc2 = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  reader = new JsonLineReader(proc2)
  try {
    proc2.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const r = await reader.nextResponse(1)
    assert.equal(
      r.result.config.approval_policy,
      'never',
      'override must survive restart via persisted overrides bag',
    )
    assert.equal(r.result.config.sandbox_mode, 'danger-full-access')
  } finally {
    proc2.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
