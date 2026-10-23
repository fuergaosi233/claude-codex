import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { INVALID_REQUEST } from '../src/host-methods.mjs'
import {
  assertModelProfileTransition,
  loadClaudeModelProfiles,
  modelProfileFingerprint,
  resolveClaudeModelProcess,
} from '../src/model-profiles.mjs'
import { NativeClaudeRuntime, sdkResumeSessionId } from '../src/native-runtime.mjs'
import { createRuntime } from '../src/runtime-factory.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type {
  ClaudeRuntime,
  RpcPeer,
  RuntimeHandlers,
  RuntimeTurnContext,
  RuntimeTurnSettings,
} from '../src/types.mjs'
import {
  claudeModelOptions,
  resolveClaudeModel,
  resolveClaudeSummaryModelIdentity,
} from '../src/util.mjs'

const baseContext: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn',
  prompt: 'hello',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  modelProfileId: null,
  modelProfileFingerprint: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  enableFileCheckpointing: false,
  outputFormat: null,
  approvalPolicy: null,
  sandboxMode: null,
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

const PROFILE_ENV = [
  'HOME',
  'CLAUDE_CODEX_HOME',
  'CLAUDE_CODEX_MODEL_PROFILES_FILE',
  'CLAUDE_CODEX_MODEL_PROFILES',
  'CLAUDE_CODEX_MODELS',
  'CLAUDE_CODEX_DEFAULT_MODEL',
  'CLAUDE_CODEX_MODEL_ALIASES',
  'CLAUDE_CODEX_SUMMARY_MODEL',
  'CLAUDE_CODEX_TITLE_MODEL',
  'CLAUDE_CODEX_DISABLE_CODEX_PROXY',
  'CLAUDE_CODEX_CLI',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIRS',
  'CLAUDE_ROUTER_DIR',
  'ANTHROPIC_API_KEY',
]

const TWO_PROFILES = {
  defaultModel: 'main-model',
  models: [
    { id: 'main-model', sdkModel: 'vendor/main-1' },
    { id: 'second-model', sdkModel: 'vendor/second-1' },
  ],
}

test('model profiles expose models and build isolated child environments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const envFile = join(root, 'provider.env')
  const configFile = join(root, 'models.json')
  await writeFile(
    envFile,
    ['ANTHROPIC_BASE_URL=${PROVIDER_BASE_URL}', 'ANTHROPIC_AUTH_TOKEN=${PROVIDER_TOKEN}', ''].join(
      '\n',
    ),
    { mode: 0o600 },
  )
  await writeFile(
    configFile,
    JSON.stringify({
      defaultModel: 'main-model',
      models: [
        {
          id: 'main-model',
          sdkModel: 'vendor/main-1',
          displayName: 'Main Model',
          executable: '${HOME}/bin/claude-wrapper',
          env: { CLAUDE_CONFIG_DIR: '${HOME}/profiles/main-model' },
        },
        {
          id: 'second-model',
          sdkModel: 'vendor/second-1',
          displayName: 'Second Model',
          envFile: 'provider.env',
          env: { CLAUDE_CONFIG_DIR: '${HOME}/profiles/second-model' },
        },
      ],
    }),
    { mode: 0o600 },
  )
  const env = {
    HOME: root,
    PATH: '/usr/bin',
    PROVIDER_BASE_URL: 'http://127.0.0.1:8080',
    PROVIDER_TOKEN: 'test-token',
    ANTHROPIC_API_KEY: 'must-not-leak',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak-either',
    UNRELATED_TOKEN: 'must-not-leak-either',
    CLAUDE_CODEX_MODEL_PROFILES_FILE: configFile,
  }
  try {
    const profiles = loadClaudeModelProfiles(env)
    assert.deepEqual(
      profiles.map((profile) => [profile.id, profile.sdkModel, profile.isDefault]),
      [
        ['main-model', 'vendor/main-1', true],
        ['second-model', 'vendor/second-1', false],
      ],
    )

    const main = resolveClaudeModelProcess('main-model', env)
    assert.ok(main)
    assert.equal(main.executable, join(root, 'bin/claude-wrapper'))
    assert.equal(main.env.PATH, '/usr/bin')
    assert.equal(main.env.ANTHROPIC_API_KEY, undefined)
    assert.equal(main.env.AWS_SECRET_ACCESS_KEY, undefined)
    assert.equal(main.env.UNRELATED_TOKEN, undefined)
    assert.equal(main.env.CLAUDE_CONFIG_DIR, join(root, 'profiles/main-model'))

    const second = resolveClaudeModelProcess('second-model', env)
    assert.ok(second)
    assert.equal(second.sdkModel, 'vendor/second-1')
    assert.equal(second.executable, null)
    assert.equal(second.env.ANTHROPIC_API_KEY, undefined)
    assert.equal(second.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8080')
    assert.equal(second.env.ANTHROPIC_AUTH_TOKEN, 'test-token')
    // The variable a secret is read from stays in the adapter.
    assert.equal(second.env.PROVIDER_TOKEN, undefined)
    assert.equal(second.env.CLAUDE_CONFIG_DIR, join(root, 'profiles/second-model'))

    assert.throws(
      () => resolveClaudeModelProcess('unknown-profile', env),
      /unknown configured Claude model profile/,
    )
    // No profiles, no process: the turn runs as configured without them.
    assert.equal(resolveClaudeModelProcess('main-model', { HOME: root }), null)
    assert.equal(modelProfileFingerprint('main-model', { HOME: root }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('model profiles validate their schema', async () => {
  const load = (value: unknown, extra: Record<string, string> = {}) =>
    loadClaudeModelProfiles({
      HOME: tmpdir(),
      CLAUDE_CODEX_MODEL_PROFILES: JSON.stringify(value),
      ...extra,
    })

  // A bare array works too; without a marked default the first profile is it.
  const bare = load([{ id: 'main-model' }, { id: 'second-model', sdkModel: 'vendor/second-1' }])
  assert.deepEqual(
    bare.map((profile) => [profile.id, profile.sdkModel, profile.displayName, profile.isDefault]),
    [
      ['main-model', 'main-model', 'main-model', true],
      ['second-model', 'vendor/second-1', 'second-model', false],
    ],
  )
  assert.ok(bare[0]?.inheritEnv.includes('PATH'))
  assert.equal(load([{ id: 'a' }, { id: 'b', isDefault: true }])[1]?.isDefault, true)
  assert.deepEqual(load([{ id: 'a', inheritEnv: ['*'] }])[0]?.inheritEnv, ['*'])

  assert.throws(() => load({ models: [] }), /non-empty models array/)
  assert.throws(() => load([{ id: '../escape' }]), /invalid Claude model profile id/)
  assert.throws(() => load([{ id: 'a' }, { id: 'a' }]), /duplicate Claude model profile id/)
  assert.throws(() => load({ defaultModel: 'b', models: [{ id: 'a' }] }), /defaultModel is unknown/)
  assert.throws(
    () =>
      load([
        { id: 'a', isDefault: true },
        { id: 'b', isDefault: true },
      ]),
    /exactly one default/,
  )
  assert.throws(
    () => load([{ id: 'a', inheritEnv: ['*', 'PATH'] }]),
    /cannot be combined with named variables/,
  )
  assert.throws(() => load([{ id: 'a', env: { CLAUDE_CONFIG_DIR: 1 } }]), /string environment/)
  assert.throws(() => load([{ id: 'a', executable: '${MISSING_DIR}/claude' }]), /MISSING_DIR/)
  assert.throws(
    () =>
      loadClaudeModelProfiles({
        CLAUDE_CODEX_MODEL_PROFILES: '[{"id":"a"}]',
        CLAUDE_CODEX_MODEL_PROFILES_FILE: '/nonexistent/models.json',
      }),
    /set only one of/,
  )
  assert.throws(
    () => loadClaudeModelProfiles({ CLAUDE_CODEX_MODEL_PROFILES: '{' }),
    /invalid Claude model profiles JSON/,
  )
})

test('profile fingerprints reject configuration drift without hashing secret values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const envFile = join(root, 'provider.env')
  const configFile = join(root, 'models.json')
  await writeFile(
    envFile,
    ['ANTHROPIC_BASE_URL=http://127.0.0.1:8080', 'ANTHROPIC_AUTH_TOKEN=${PROVIDER_TOKEN}', ''].join(
      '\n',
    ),
    { mode: 0o600 },
  )
  await writeFile(
    configFile,
    JSON.stringify({
      models: [{ id: 'main-model', sdkModel: 'vendor/main-1', executable: '/bin/true', envFile }],
    }),
    { mode: 0o600 },
  )
  const env = {
    HOME: root,
    PATH: '/usr/bin',
    PROVIDER_TOKEN: 'first-secret',
    CLAUDE_CODEX_MODEL_PROFILES_FILE: configFile,
  }
  try {
    const fingerprint = modelProfileFingerprint('main-model', env)
    assert.ok(fingerprint)
    assert.match(fingerprint, /^[a-f0-9]{64}$/)
    // Rotating a credential is no configuration change.
    assert.equal(
      modelProfileFingerprint('main-model', { ...env, PROVIDER_TOKEN: 'rotated-secret' }),
      fingerprint,
    )
    assert.equal(
      resolveClaudeModelProcess('main-model', env, fingerprint)?.sdkModel,
      'vendor/main-1',
    )

    await writeFile(
      envFile,
      [
        'ANTHROPIC_BASE_URL=http://127.0.0.1:9090',
        'ANTHROPIC_AUTH_TOKEN=${PROVIDER_TOKEN}',
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    assert.notEqual(modelProfileFingerprint('main-model', env), fingerprint)
    assert.throws(
      () => resolveClaudeModelProcess('main-model', env, fingerprint),
      /model process profile main-model changed since this chat started, so this chat cannot continue; start a new chat/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('model profiles reject literal inline secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const configFile = join(root, 'models.json')
  try {
    for (const token of ['literal-secret', 'literal-prefix-${PARENT_TOKEN}']) {
      await writeFile(
        configFile,
        JSON.stringify({
          models: [
            { id: 'unsafe', sdkModel: 'vendor/unsafe-1', env: { ANTHROPIC_AUTH_TOKEN: token } },
          ],
        }),
        { mode: 0o600 },
      )
      assert.throws(
        () =>
          loadClaudeModelProfiles({
            HOME: root,
            PARENT_TOKEN: 'test-token',
            CLAUDE_CODEX_MODEL_PROFILES_FILE: configFile,
          }),
        /secret-like environment key must reference a parent environment variable/,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('model profile config must be owner-controlled and cannot be a symbolic link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const configFile = join(root, 'models.json')
  const linkFile = join(root, 'models-link.json')
  await writeFile(configFile, JSON.stringify({ models: [{ id: 'main-model' }] }), { mode: 0o600 })
  const env = { HOME: root, CLAUDE_CODEX_MODEL_PROFILES_FILE: configFile }
  try {
    await chmod(configFile, 0o666)
    assert.throws(() => loadClaudeModelProfiles(env), /must not be group or world writable/)
    await chmod(configFile, 0o644)
    assert.equal(loadClaudeModelProfiles(env).length, 1)
    await symlink(configFile, linkFile)
    assert.throws(
      () => loadClaudeModelProfiles({ ...env, CLAUDE_CODEX_MODEL_PROFILES_FILE: linkFile }),
      /must not be a symbolic link/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('profiles that fail to load say where and why in one short line, quoting none of them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const configFile = join(root, 'models.json')
  const failure = (env: Record<string, string>): string => {
    try {
      loadClaudeModelProfiles({ HOME: root, ...env })
    } catch (error) {
      const message = (error as Error).message
      assert.ok(message.length <= 300, message)
      assert.doesNotMatch(message, /\n/)
      return message
    }
    assert.fail('the profiles loaded')
  }
  const inline = (value: unknown) =>
    failure({
      CLAUDE_CODEX_MODEL_PROFILES: typeof value === 'string' ? value : JSON.stringify(value),
    })
  try {
    // A credential pasted without quotes: JSON.parse quotes the text around it.
    const pasted = inline(
      '[{"id": "main-model", "env": {"ANTHROPIC_AUTH_TOKEN": sk-pasted-credential}}]',
    )
    assert.match(
      pasted,
      /^cannot load Claude model profiles from CLAUDE_CODEX_MODEL_PROFILES: invalid Claude model profiles JSON: Unexpected token 's'$/,
    )

    const fromFile = { CLAUDE_CODEX_MODEL_PROFILES_FILE: configFile }
    const fileSource = `cannot load Claude model profiles from ${configFile} (CLAUDE_CODEX_MODEL_PROFILES_FILE): `
    await writeFile(
      configFile,
      '{\n  "models": [\n    { "id": "main-model",\n      "env": { "API_KEY": sk-file-credential } }\n  ]\n}\n',
      { mode: 0o600 },
    )
    const quoted = failure(fromFile)
    assert.ok(quoted.startsWith(`${fileSource}invalid Claude model profiles JSON: `), quoted)
    assert.doesNotMatch(quoted, /file-credential|API_KEY|"/)
    // A message that quotes nothing stays whole, with where the error is.
    await writeFile(configFile, '{\n  "models": [{ "id": "main-model" }],\n}\n', { mode: 0o600 })
    assert.match(
      failure(fromFile),
      /: invalid Claude model profiles JSON: Expected double-quoted property name in JSON at position \d+ \(line 3 column 1\)$/,
    )
    assert.equal(
      failure({ CLAUDE_CODEX_MODEL_PROFILES_FILE: join(root, 'missing.json') }),
      `cannot load Claude model profiles from ${join(root, 'missing.json')} (CLAUDE_CODEX_MODEL_PROFILES_FILE): the file does not exist`,
    )
    // A long path keeps its end, where the file name is.
    const deep = join(root, 'a'.repeat(100), 'b'.repeat(100))
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'models.json'), '{', { mode: 0o600 })
    assert.match(
      failure({ CLAUDE_CODEX_MODEL_PROFILES_FILE: join(deep, 'models.json') }),
      /^cannot load Claude model profiles from …b{67}\/models\.json \(CLAUDE_CODEX_MODEL_PROFILES_FILE\): invalid Claude model profiles JSON: Expected property name or '}' in JSON at position 1 \(line 1 column 2\)$/,
    )
    assert.equal(
      failure({ CLAUDE_CODEX_MODEL_PROFILES: '[{"id":"a"}]', ...fromFile }),
      'cannot load Claude model profiles: set only one of CLAUDE_CODEX_MODEL_PROFILES_FILE or CLAUDE_CODEX_MODEL_PROFILES',
    )

    // What was put where an id belongs is no id, so it is not quoted.
    assert.equal(
      inline([{ id: 'main-model' }, { id: 'sk-pasted credential' }]),
      "cannot load Claude model profiles from CLAUDE_CODEX_MODEL_PROFILES: invalid Claude model profile id at index 1: use letters, digits, '.', '_' and '-', at most 128 characters",
    )
    assert.equal(
      inline({ defaultModel: 'sk-pasted credential', models: [{ id: 'main-model' }] }),
      'cannot load Claude model profiles from CLAUDE_CODEX_MODEL_PROFILES: Claude model profiles defaultModel is unknown',
    )
    assert.match(
      inline({ defaultModel: 'other-model', models: [{ id: 'main-model' }] }),
      /: Claude model profiles defaultModel is unknown: other-model$/,
    )
    // A longer reason is cut short.
    const clipped = inline([{ id: 'a', env: { [`PROVIDER_TOKEN_${'X'.repeat(400)}`]: 'literal' } }])
    assert.equal(clipped.length, 300)
    assert.match(clipped, /must reference a parent environment variable: PROVIDER_TOKEN_X+…$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('model profile env files must be private regular files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const envFile = join(root, 'provider.env')
  const linkFile = join(root, 'provider-link.env')
  const configFile = join(root, 'models.json')
  await writeFile(envFile, 'ANTHROPIC_AUTH_TOKEN=${PROVIDER_TOKEN}\n', { mode: 0o600 })
  await symlink(envFile, linkFile)
  await writeFile(
    configFile,
    JSON.stringify({ models: [{ id: 'main-model', envFile: 'provider.env' }] }),
    { mode: 0o600 },
  )
  const env = {
    HOME: root,
    PROVIDER_TOKEN: 'test-token',
    CLAUDE_CODEX_MODEL_PROFILES_FILE: configFile,
  }
  try {
    await chmod(envFile, 0o644)
    assert.throws(() => resolveClaudeModelProcess('main-model', env), /mode 0600/)
    await chmod(envFile, 0o600)
    assert.equal(
      resolveClaudeModelProcess('main-model', env)?.env.ANTHROPIC_AUTH_TOKEN,
      'test-token',
    )
    await writeFile(
      configFile,
      JSON.stringify({ models: [{ id: 'main-model', envFile: 'provider-link.env' }] }),
      { mode: 0o600 },
    )
    assert.throws(() => resolveClaudeModelProcess('main-model', env), /symbolic link/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('model process profiles cannot change inside one Claude session', () => {
  const env = { HOME: tmpdir(), CLAUDE_CODEX_MODEL_PROFILES: JSON.stringify(TWO_PROFILES) }
  assert.doesNotThrow(() => assertModelProfileTransition('main-model', 'main-model', env))
  assert.throws(
    () => assertModelProfileTransition('main-model', 'second-model', env),
    /cannot change model process profile from main-model to second-model; start a new thread/,
  )
  assert.throws(
    () => assertModelProfileTransition('main-model', 'sonnet', env),
    /unknown configured Claude model profile: sonnet/,
  )
  // Without profiles any model goes.
  assert.doesNotThrow(() => assertModelProfileTransition('main-model', 'sonnet', {}))
})

test('the App describes a profile thread in a fork on the same profile', async () => {
  const harness = await profileServer(TWO_PROFILES)
  const { call, runTurn } = harness
  try {
    const { result: started } = await call('thread/start', {
      cwd: harness.root,
      model: 'main-model',
    })
    const parent = started.thread.id
    await runTurn(parent)

    // What the App sends to describe a thread. Codex routing is on, yet the
    // fork cannot leave the profile its conversation lives in.
    const { result: forked, error } = await call('thread/fork', {
      threadId: parent,
      model: 'gpt-5.6-luna',
      approvalPolicy: 'never',
      permissions: ':read-only',
      ephemeral: true,
      excludeTurns: true,
      threadSource: 'thread_description',
    })
    assert.equal(error, undefined)
    assert.equal(forked.model, 'main-model')
    assert.equal(forked.thread.ephemeral, true)
    const summary = await runTurn(forked.thread.id, {
      model: 'gpt-5.6-luna',
      outputSchema: { type: 'object', properties: { description: { type: 'string' } } },
    })
    assert.equal(summary?.modelProfileId, 'main-model')
    assert.equal(summary?.model, 'vendor/main-1')
    assert.equal(summary?.modelProfileFingerprint, modelProfileFingerprint('main-model'))

    // The user's own fork still cannot leave the profile.
    const userFork = await call('thread/fork', { threadId: parent, model: 'gpt-5.6-luna' })
    assert.match(userFork.error?.message ?? '', /unknown configured Claude model profile/)
    const otherProfile = await call('thread/fork', { threadId: parent, model: 'second-model' })
    assert.match(otherProfile.error?.message ?? '', /cannot change model process profile/)
    const sameProfile = await call('thread/fork', { threadId: parent })
    assert.equal(sameProfile.result.model, 'main-model')
  } finally {
    await harness.close()
  }
})

test('with Codex routing off, the App titles a chat on the summary profile', async () => {
  const harness = await profileServer(
    {
      defaultModel: 'main-model',
      models: [
        { id: 'main-model', sdkModel: 'vendor/main-1' },
        { id: 'quick-model', sdkModel: 'vendor/quick-1' },
      ],
    },
    { CLAUDE_CODEX_SUMMARY_MODEL: 'quick-model', CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1' },
  )
  const { call, runTurn } = harness
  // What the App sends to title a chat.
  const titleThread = () =>
    call('thread/start', {
      cwd: harness.root,
      model: 'gpt-5.6-luna',
      allowProviderModelFallback: true,
      approvalPolicy: 'never',
      permissions: ':read-only',
      ephemeral: true,
      threadSource: 'thread_title',
    })
  try {
    const { result: started, error } = await titleThread()
    assert.equal(error, undefined)
    assert.equal(started.model, 'quick-model')
    const title = await runTurn(started.thread.id, {
      model: null,
      outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    })
    assert.equal(title?.model, 'vendor/quick-1')
    assert.equal(title?.modelProfileId, 'quick-model')
    assert.equal(title?.modelProfileFingerprint, modelProfileFingerprint('quick-model'))
    const plain = await runTurn(started.thread.id, { model: 'gpt-5.6-luna' })
    assert.equal(plain?.model, 'vendor/quick-1')
    assert.equal(plain?.modelProfileId, 'quick-model')

    // Without a summary model, the default profile answers.
    delete process.env.CLAUDE_CODEX_SUMMARY_MODEL
    const { result: fallback } = await titleThread()
    assert.equal(fallback.model, 'main-model')

    const refused = await call('thread/start', { cwd: harness.root, model: 'gpt-5.6-luna' })
    assert.match(refused.error?.message ?? '', /Codex model routing is disabled/)
  } finally {
    await harness.close()
  }
})

test('a running profile turn switches model only within its profile', async () => {
  const updates: RuntimeTurnSettings[] = []
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let running = false
  const harness = await profileServer(
    TWO_PROFILES,
    {},
    {
      runTurn: async (_context, handlers) => {
        running = true
        await released
        await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
      },
      updateTurnSettings: async (_threadId, _turnId, settings) => {
        updates.push(settings)
        return true
      },
    },
  )
  const { call } = harness
  try {
    const { result: started } = await call('thread/start', {
      cwd: harness.root,
      model: 'main-model',
    })
    const threadId = started.thread.id
    const { result } = await call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Hold this turn.' }],
    })
    for (let waited = 0; !running; waited += 10) {
      assert.ok(waited < 5_000, 'turn did not start')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const update = (settings: Record<string, unknown>) =>
      call('turn/settings/update', { threadId, turnId: result.turn.id, ...settings })

    // Another profile is another process: launcher, provider and config dir.
    const across = await update({ model: 'second-model' })
    assert.match(across.error?.message ?? '', /cannot change model process profile/)
    assert.equal(across.error?.code, INVALID_REQUEST)
    const same = await update({ model: 'main-model', effort: 'high' })
    assert.deepEqual(same.result, { status: 'applied' })
    assert.deepEqual(updates, [{ model: 'vendor/main-1', effort: 'high' }])
  } finally {
    release()
    await harness.close()
  }
})

test('a model change refuses profiles that fail to load as an invalid request, quoting none of them', async () => {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let running = false
  const harness = await profileServer(
    TWO_PROFILES,
    {},
    {
      runTurn: async (_context, handlers) => {
        running = true
        await released
        await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
      },
      updateTurnSettings: async () => true,
    },
  )
  const { call } = harness
  try {
    const { result: held } = await call('thread/start', { cwd: harness.root, model: 'main-model' })
    const { result: fresh } = await call('thread/start', { cwd: harness.root, model: 'main-model' })
    const { result: turn } = await call('turn/start', {
      threadId: held.thread.id,
      input: [{ type: 'text', text: 'Hold this turn.' }],
    })
    for (let waited = 0; !running; waited += 10) {
      assert.ok(waited < 5_000, 'turn did not start')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // A credential pasted without quotes: JSON.parse quotes the text around it.
    await writeFile(
      harness.configFile,
      '{"models": [{"id": "main-model", "env": {"API_KEY": sk-pasted-credential}}]}',
      { mode: 0o600 },
    )
    const reason = `cannot load Claude model profiles from ${harness.configFile} (CLAUDE_CODEX_MODEL_PROFILES_FILE): invalid Claude model profiles JSON: Unexpected token 's'`
    // The model menu, a running turn's settings, and a turn on another model.
    // App rule: model-menu-settings
    const refusals = [
      await call('thread/settings/update', { threadId: fresh.thread.id, model: 'second-model' }),
      await call('turn/settings/update', {
        threadId: held.thread.id,
        turnId: turn.turn.id,
        model: 'second-model',
      }),
      await call('turn/start', {
        threadId: fresh.thread.id,
        model: 'second-model',
        input: [{ type: 'text', text: 'Switch.' }],
      }),
    ]
    for (const refused of refusals) {
      assert.deepEqual(refused.error, { code: INVALID_REQUEST, message: reason })
    }
    assert.equal(harness.store.getThread(fresh.thread.id)?.model, 'main-model')
  } finally {
    release()
    await harness.close()
  }
})

test('a chat keeps its profile once it has a conversation; a new chat takes any', async () => {
  const harness = await profileServer(TWO_PROFILES)
  const { call, runTurn } = harness
  try {
    const { result: started } = await call('thread/start', {
      cwd: harness.root,
      model: 'main-model',
    })
    const threadId = started.thread.id
    assert.equal(
      harness.store.getThread(threadId)?.modelProfileFingerprint,
      fingerprint('main-model'),
    )

    // The App starts a new chat's thread before the user picks a model.
    // App rule: prewarmed-threads
    const picked = await call('thread/settings/update', { threadId, model: 'second-model' })
    assert.equal(picked.error, undefined)
    assert.equal(
      harness.store.getThread(threadId)?.modelProfileFingerprint,
      fingerprint('second-model'),
    )
    const first = await runTurn(threadId)
    assert.equal(first?.model, 'vendor/second-1')
    assert.equal(first?.modelProfileId, 'second-model')
    assert.equal(first?.modelProfileFingerprint, fingerprint('second-model'))

    // From here on its session lives in that profile's process.
    // App rule: model-menu-settings
    const menu = await call('thread/settings/update', { threadId, model: 'main-model' })
    assert.match(menu.error?.message ?? '', /cannot change model process profile/)
    // The code the App's model menu shows the reason for.
    assert.equal(menu.error?.code, INVALID_REQUEST)
    const metadata = await call('thread/metadata/update', { threadId, model: 'main-model' })
    assert.match(metadata.error?.message ?? '', /cannot change model process profile/)
    assert.equal(metadata.error?.code, INVALID_REQUEST)
    const turn = await call('turn/start', {
      threadId,
      model: 'main-model',
      input: [{ type: 'text', text: 'Switch.' }],
    })
    assert.match(turn.error?.message ?? '', /cannot change model process profile/)
    assert.equal(turn.error?.code, INVALID_REQUEST)
    assert.equal(harness.store.getThread(threadId)?.model, 'second-model')

    // A resume ignores the picker rather than failing.
    const resumed = await call('thread/resume', { threadId, model: 'main-model' })
    assert.equal(resumed.error, undefined)
    assert.equal(resumed.result.model, 'second-model')
    const again = await runTurn(threadId)
    assert.equal(again?.modelProfileId, 'second-model')
  } finally {
    await harness.close()
  }
})

test('a chat whose profile changed or went away still opens, but nothing starts Claude for it', async () => {
  const harness = await profileServer(TWO_PROFILES)
  const { call, runTurn } = harness
  try {
    const { result: talked } = await call('thread/start', {
      cwd: harness.root,
      model: 'main-model',
    })
    await runTurn(talked.thread.id)
    const { result: unsent } = await call('thread/start', {
      cwd: harness.root,
      model: 'main-model',
    })

    // The profile now points at another model: its sessions belong to the old one.
    await harness.writeProfiles({
      defaultModel: 'main-model',
      models: [
        { id: 'main-model', sdkModel: 'vendor/main-2' },
        { id: 'second-model', sdkModel: 'vendor/second-1' },
      ],
    })
    await assertOpensButStartsNothing(
      harness,
      talked.thread.id,
      /model process profile main-model changed since this chat started, so this chat cannot continue; start a new chat$/,
    )
    // A chat with nothing said yet just takes the new configuration.
    const fresh = await runTurn(unsent.thread.id)
    assert.equal(fresh?.model, 'vendor/main-2')
    assert.equal(fresh?.modelProfileFingerprint, fingerprint('main-model'))

    // Its profile deleted: the chat cannot go on in another one.
    await harness.writeProfiles({
      defaultModel: 'second-model',
      models: [{ id: 'second-model', sdkModel: 'vendor/second-1' }],
    })
    await assertOpensButStartsNothing(
      harness,
      unsent.thread.id,
      /model process profile main-model is no longer configured, so this chat cannot continue; start a new chat$/,
    )

    // Profiles removed: a chat pinned to one cannot go on without one either.
    delete process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE
    await assertOpensButStartsNothing(
      harness,
      unsent.thread.id,
      /model process profiles are no longer configured, so this chat on main-model cannot continue; start a new chat$/,
    )
    // Not even by picking a model, which would drop the pin.
    const picked = await call('thread/settings/update', {
      threadId: unsent.thread.id,
      model: 'claude-sonnet-4-5',
    })
    assert.match(picked.error?.message ?? '', /model process profiles are no longer configured/)
    assert.equal(picked.error?.code, INVALID_REQUEST)
    assert.equal(harness.store.getThread(unsent.thread.id)?.model, 'main-model')
  } finally {
    await harness.close()
  }
})

test('a chat from before model profiles still opens, but nothing starts Claude for it', async () => {
  const harness = await profileServer(TWO_PROFILES)
  const { call, runTurn } = harness
  try {
    delete process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE
    const { result: onProfileId } = await call('thread/start', {
      cwd: harness.root,
      model: 'main-model',
    })
    await runTurn(onProfileId.thread.id)
    const { result: onOther } = await call('thread/start', {
      cwd: harness.root,
      model: 'claude-sonnet-4-5',
    })
    await runTurn(onOther.thread.id)
    assert.equal(harness.store.getThread(onProfileId.thread.id)?.modelProfileFingerprint, null)
    assert.equal(harness.store.getThread(onOther.thread.id)?.modelProfileFingerprint, null)

    // Profiles turned on: neither session lives in a profile's process.
    process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE = harness.configFile
    const preProfile =
      /this chat started before model process profiles were configured, so it cannot continue on one; start a new chat$/
    await assertOpensButStartsNothing(harness, onProfileId.thread.id, preProfile)
    await assertOpensButStartsNothing(harness, onOther.thread.id, preProfile)
    // Picking a profile does not move it onto one.
    const picked = await call('thread/settings/update', {
      threadId: onOther.thread.id,
      model: 'second-model',
    })
    assert.match(picked.error?.message ?? '', preProfile)
    assert.equal(harness.store.getThread(onOther.thread.id)?.modelProfileFingerprint, null)
  } finally {
    await harness.close()
  }
})

test('a subagent runs on the profile of the thread that spawned it', async () => {
  const harness = await profileServer(
    TWO_PROFILES,
    {},
    {
      runTurn: async (_context, handlers) => {
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId: 'agent-call',
          toolName: 'Agent',
          input: { subagent_type: 'Explore', model: 'haiku', prompt: 'Look around.' },
        })
        await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-call', content: 'Done.' })
        await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
      },
    },
  )
  const { call, runTurn } = harness
  try {
    const { result: started } = await call('thread/start', {
      cwd: harness.root,
      model: 'second-model',
    })
    await runTurn(started.thread.id)
    const child = harness.startedThreads
      .map((id) => harness.store.getThread(id))
      .find((thread) => thread?.threadSource === 'subagent')
    assert.ok(child)
    assert.equal(child.forkedFromId, started.thread.id)
    // The Agent call's own model names no profile: the subagent runs in the
    // parent's Claude Code process.
    assert.equal(child.model, 'second-model')
    assert.equal(child.modelProfileFingerprint, fingerprint('second-model'))
  } finally {
    await harness.close()
  }
})

test('configured model profiles drive the model picker and native SDK process options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const configFile = join(root, 'models.json')
  await writeFile(
    configFile,
    JSON.stringify({
      defaultModel: 'main-model',
      models: [
        {
          id: 'main-model',
          sdkModel: 'vendor/main-1',
          displayName: 'Main Model',
          executable: '${HOME}/bin/claude-wrapper',
          env: { CLAUDE_CONFIG_DIR: '${HOME}/profiles/main-model' },
        },
        { id: 'second-model', sdkModel: 'vendor/second-1', displayName: 'Second Model' },
      ],
    }),
    { mode: 0o600 },
  )
  const restore = saveEnv(PROFILE_ENV)
  process.env.HOME = root
  process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE = configFile
  // Ignored while profiles are configured.
  process.env.CLAUDE_CODEX_MODELS = 'sonnet,opus'
  process.env.CLAUDE_CODEX_CLI = '/usr/local/bin/claude'
  process.env.ANTHROPIC_API_KEY = 'adapter-key'
  delete process.env.CLAUDE_CODEX_MODEL_PROFILES
  delete process.env.CLAUDE_CODEX_SUMMARY_MODEL
  delete process.env.CLAUDE_CODEX_TITLE_MODEL
  try {
    assert.deepEqual(
      claudeModelOptions().map((option) => [option.id, option.sdkModel, option.isDefault]),
      [
        ['main-model', 'vendor/main-1', true],
        ['second-model', 'vendor/second-1', false],
      ],
    )
    assert.equal(resolveClaudeModel('main-model'), 'vendor/main-1')
    assert.equal(resolveClaudeModel('default'), 'vendor/main-1')
    assert.equal(resolveClaudeModel('gpt-5.4', 'normal'), 'gpt-5.4')
    assert.equal(resolveClaudeModel('gpt-5.4', 'summary'), 'vendor/main-1')

    const defaultSummary = resolveClaudeSummaryModelIdentity('gpt-5.4')
    assert.equal(defaultSummary.model, 'vendor/main-1')
    assert.equal(defaultSummary.modelProfileId, 'main-model')
    assert.match(defaultSummary.modelProfileFingerprint ?? '', /^[a-f0-9]{64}$/)

    process.env.CLAUDE_CODEX_SUMMARY_MODEL = 'second-model'
    assert.equal(resolveClaudeModel('gpt-5.4', 'summary'), 'vendor/second-1')
    assert.equal(resolveClaudeSummaryModelIdentity('gpt-5.4').modelProfileId, 'second-model')

    process.env.CLAUDE_CODEX_SUMMARY_MODEL = 'haiku'
    assert.throws(
      () => resolveClaudeModel('gpt-5.4', 'summary'),
      /unknown configured Claude summary model profile/,
    )
    assert.throws(() => resolveClaudeModel('sonnet'), /unknown configured Claude model profile/)

    process.env.CLAUDE_CODEX_SUMMARY_MODEL = 'main-model'
    const identity = resolveClaudeSummaryModelIdentity('gpt-5.4')
    const options = buildOptions({ ...baseContext, cwd: root, ...identity })
    assert.equal(options.model, 'vendor/main-1')
    assert.equal(options.pathToClaudeCodeExecutable, join(root, 'bin/claude-wrapper'))
    const env = options.env as Record<string, string>
    assert.equal(env.CLAUDE_CONFIG_DIR, join(root, 'profiles/main-model'))
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    // Session state reporting rides on the profile's env, not in place of it.
    assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1')

    // A profile without an executable runs the SDK's own Claude Code.
    const second = buildOptions({
      ...baseContext,
      cwd: root,
      model: 'vendor/second-1',
      modelProfileId: 'second-model',
      modelProfileFingerprint: modelProfileFingerprint('second-model'),
    })
    assert.equal(second.pathToClaudeCodeExecutable, undefined)
    assert.throws(
      () =>
        buildOptions({
          ...baseContext,
          modelProfileId: 'second-model',
          modelProfileFingerprint: 'stale',
        }),
      /model process profile second-model changed since this chat started/,
    )
  } finally {
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('without model profiles nothing changes', async () => {
  const restore = saveEnv(PROFILE_ENV)
  delete process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE
  delete process.env.CLAUDE_CODEX_MODEL_PROFILES
  delete process.env.CLAUDE_CODEX_SUMMARY_MODEL
  delete process.env.CLAUDE_CODEX_TITLE_MODEL
  delete process.env.CLAUDE_CODEX_DEFAULT_MODEL
  delete process.env.CLAUDE_CODEX_MODEL_ALIASES
  process.env.CLAUDE_CODEX_MODELS = 'sonnet,opus'
  process.env.CLAUDE_CODEX_CLI = '/usr/local/bin/claude'
  process.env.ANTHROPIC_API_KEY = 'adapter-key'
  try {
    assert.deepEqual(
      claudeModelOptions().map((option) => option.id),
      ['sonnet', 'opus'],
    )
    assert.equal(resolveClaudeModel('sonnet'), 'sonnet')
    assert.deepEqual(resolveClaudeSummaryModelIdentity('gpt-5.4'), {
      model: 'haiku',
      modelProfileId: null,
      modelProfileFingerprint: null,
    })
    const options = buildOptions({ ...baseContext, model: 'sonnet' })
    assert.equal(options.model, 'sonnet')
    assert.equal(options.pathToClaudeCodeExecutable, '/usr/local/bin/claude')
    assert.equal((options.env as Record<string, string>).ANTHROPIC_API_KEY, 'adapter-key')
  } finally {
    restore()
  }
})

test('a profile reads what its env file sets, and token budgets are no secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const envFile = join(root, 'provider.env')
  const configFile = join(root, 'models.json')
  const writeEnvFile = (host: string) =>
    writeFile(
      envFile,
      [
        `PROVIDER_HOST=${host}`,
        'PROVIDER_URL=https://${PROVIDER_HOST}/v1',
        'ANTHROPIC_AUTH_TOKEN=${PROVIDER_TOKEN}',
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
  await writeEnvFile('gateway.example')
  await writeFile(
    configFile,
    JSON.stringify({
      models: [
        {
          id: 'main-model',
          envFile,
          env: { ANTHROPIC_BASE_URL: '${PROVIDER_URL}', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
        },
      ],
    }),
    { mode: 0o600 },
  )
  const env = {
    HOME: root,
    PATH: '/usr/bin',
    PROVIDER_TOKEN: 'first-secret',
    CLAUDE_CODEX_MODEL_PROFILES_FILE: configFile,
  }
  try {
    const pinned = modelProfileFingerprint('main-model', env)
    assert.match(pinned ?? '', /^[a-f0-9]{64}$/)
    const main = resolveClaudeModelProcess('main-model', env, pinned)
    assert.equal(main?.env.ANTHROPIC_BASE_URL, 'https://gateway.example/v1')
    assert.equal(main?.env.ANTHROPIC_AUTH_TOKEN, 'first-secret')
    assert.equal(main?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '64000')
    // The endpoint counts however the file spells it.
    await writeEnvFile('other.example')
    assert.notEqual(modelProfileFingerprint('main-model', env), pinned)
    // A key that names a credential still cannot hold one.
    assert.throws(
      () =>
        loadClaudeModelProfiles({
          HOME: root,
          CLAUDE_CODEX_MODEL_PROFILES: JSON.stringify([
            { id: 'a', env: { PROXY_AUTH_TOKENS: 'literal' } },
          ]),
        }),
      /secret-like environment key must reference a parent environment variable: PROXY_AUTH_TOKENS/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a profile that inherits everything gets no provider setting or other credential', () => {
  const env = {
    HOME: tmpdir(),
    PATH: '/usr/bin',
    UNRELATED_SETTING: 'kept',
    MAIN_PROVIDER_TOKEN: 'main-secret',
    SECOND_PROVIDER_TOKEN: 'second-secret',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_BEARER_TOKEN_BEDROCK: 'adapter-bedrock-secret',
    ANTHROPIC_CUSTOM_HEADERS: 'x-gateway-key: adapter-secret',
    CLAUDE_CODEX_MODEL_PROFILES: JSON.stringify([
      {
        id: 'main-model',
        inheritEnv: ['*'],
        env: { ANTHROPIC_AUTH_TOKEN: '${MAIN_PROVIDER_TOKEN}' },
      },
      { id: 'second-model', env: { ANTHROPIC_AUTH_TOKEN: '${SECOND_PROVIDER_TOKEN}' } },
    ]),
  }
  const main = resolveClaudeModelProcess('main-model', env)
  assert.equal(main?.env.UNRELATED_SETTING, 'kept')
  assert.equal(main?.env.ANTHROPIC_AUTH_TOKEN, 'main-secret')
  for (const key of [
    'MAIN_PROVIDER_TOKEN',
    'SECOND_PROVIDER_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]) {
    assert.equal(main?.env[key], undefined, key)
  }
})

test("a profile passes the adapter's Claude Code switches on only when it inherits or sets them", () => {
  const env = (profile: Record<string, unknown>) => ({
    HOME: tmpdir(),
    PATH: '/usr/bin',
    CLAUDE_CODE_FORK_SUBAGENT: '0',
    CLAUDE_CODEX_MODEL_PROFILES: JSON.stringify([{ id: 'main-model', ...profile }]),
  })
  const fork = (profile: Record<string, unknown>) =>
    resolveClaudeModelProcess('main-model', env(profile))?.env.CLAUDE_CODE_FORK_SUBAGENT
  assert.equal(fork({}), undefined)
  assert.equal(fork({ inheritEnv: ['PATH', 'CLAUDE_CODE_FORK_SUBAGENT'] }), '0')
  assert.equal(fork({ inheritEnv: ['*'] }), '0')
  assert.equal(fork({ env: { CLAUDE_CODE_FORK_SUBAGENT: '1' } }), '1')
})

test('the fork of a Codex thread may take a profile', async () => {
  const harness = await profileServer(TWO_PROFILES)
  const { call } = harness
  try {
    const { result: started } = await call('thread/start', {
      cwd: harness.root,
      model: 'gpt-5.6-luna',
    })
    const forked = await call('thread/fork', {
      threadId: started.thread.id,
      model: 'second-model',
    })
    assert.equal(forked.error, undefined, forked.error?.message)
    assert.equal(forked.result.model, 'second-model')
    assert.equal(
      harness.store.getThread(forked.result.thread.id)?.modelProfileFingerprint,
      fingerprint('second-model'),
    )
  } finally {
    await harness.close()
  }
})

test('a runtime other than the native one refuses a profile turn', async () => {
  const restore = saveEnv(['CLAUDE_CODEX_RUNTIME_TYPE', 'CLAUDE_CODEX_RUNTIME'])
  process.env.CLAUDE_CODEX_RUNTIME_TYPE = 'claude-p'
  delete process.env.CLAUDE_CODEX_RUNTIME
  const runtime = createRuntime()
  try {
    await assert.rejects(
      runtime.runTurn(
        { ...baseContext, model: 'vendor/main-1', modelProfileId: 'main-model' },
        runtimeHandlers(),
      ),
      /model process profile main-model needs the native Claude runtime, not claude-p/,
    )
  } finally {
    await runtime.stop()
    restore()
  }
})

test('the native runtime starts each profile turn in its own process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const configFile = join(root, 'models.json')
  await writeFile(
    configFile,
    JSON.stringify({
      models: [
        {
          id: 'main-model',
          sdkModel: 'vendor/main-1',
          executable: '${HOME}/bin/claude-wrapper',
          env: { CLAUDE_CONFIG_DIR: '${HOME}/profiles/main-model' },
        },
      ],
    }),
    { mode: 0o600 },
  )
  const restore = saveEnv(PROFILE_ENV)
  process.env.HOME = root
  process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE = configFile
  process.env.ANTHROPIC_API_KEY = 'adapter-key'
  // Ignored for a profile turn, which runs the profile's executable.
  process.env.CLAUDE_CODEX_CLI = '/usr/local/bin/claude'
  delete process.env.CLAUDE_CODEX_MODEL_PROFILES
  const runtime = new NativeClaudeRuntime()
  const launches: Record<string, unknown>[] = []
  const transcriptRoots: unknown[] = []
  Reflect.set(runtime, 'sdk', {
    query: ({ options }: { options: Record<string, unknown> }) => {
      launches.push(options)
      return {
        interrupt: async () => undefined,
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'session' }
          // Where the turn looks for the transcripts of workflows it starts.
          const turns = Reflect.get(runtime, 'turns') as Map<string, Record<string, unknown>>
          for (const pending of turns.values())
            transcriptRoots.push(pending.workflowTranscriptRoots)
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }
        },
      }
    },
  })
  const context: RuntimeTurnContext = {
    ...baseContext,
    cwd: root,
    model: 'vendor/main-1',
    modelProfileId: 'main-model',
    modelProfileFingerprint: modelProfileFingerprint('main-model'),
  }
  try {
    await runtime.runTurn(context, runtimeHandlers())
    assert.equal(launches.length, 1)
    assert.equal(launches[0]?.model, 'vendor/main-1')
    assert.equal(launches[0]?.pathToClaudeCodeExecutable, join(root, 'bin/claude-wrapper'))
    const env = launches[0]?.env as Record<string, string>
    assert.equal(env.CLAUDE_CONFIG_DIR, join(root, 'profiles/main-model'))
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.deepEqual(transcriptRoots, [[join(root, 'profiles/main-model')]])

    // A turn pinned to an older configuration never starts.
    await assert.rejects(
      runtime.runTurn(
        { ...context, turnId: 'turn-2', modelProfileFingerprint: 'stale' },
        runtimeHandlers(),
      ),
      /model process profile main-model changed since this chat started/,
    )
    assert.equal(launches.length, 1)
  } finally {
    await runtime.stop()
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('profile sessions resume only from the profile config dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const cwd = join(root, 'work')
  const slug = cwd.replace(/[^a-zA-Z0-9-]/g, '-')
  const profileRoot = join(root, 'profiles/main-model')
  const defaultRoot = join(root, '.claude')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(profileRoot, 'projects', slug), { recursive: true })
  await mkdir(join(defaultRoot, 'projects', slug), { recursive: true })
  await writeFile(join(profileRoot, 'projects', slug, 'profile-session.jsonl'), '{}\n')
  await writeFile(join(defaultRoot, 'projects', slug, 'default-session.jsonl'), '{}\n')
  const restore = saveEnv(PROFILE_ENV)
  process.env.HOME = root
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIRS
  delete process.env.CLAUDE_ROUTER_DIR
  try {
    assert.equal(sdkResumeSessionId('profile-session', cwd, profileRoot), 'profile-session')
    assert.equal(sdkResumeSessionId('default-session', cwd, profileRoot), null)
    // Nothing is mirrored into or out of the profile's config dir.
    assert.equal(existsSync(join(defaultRoot, 'projects', slug, 'profile-session.jsonl')), false)
    assert.equal(existsSync(join(profileRoot, 'projects', slug, 'default-session.jsonl')), false)
    // Without a profile the default config dir still resumes.
    assert.equal(sdkResumeSessionId('default-session', cwd), 'default-session')
  } finally {
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

function fingerprint(modelId: string): string | null {
  return modelProfileFingerprint(modelId)
}

function buildOptions(context: RuntimeTurnContext): Record<string, unknown> {
  const runtime = new NativeClaudeRuntime()
  const build = Reflect.get(runtime, 'buildOptions') as (
    sdk: unknown,
    context: RuntimeTurnContext,
    abort: AbortController,
    sessionRef: () => null,
  ) => Record<string, unknown>
  return build.call(runtime, {}, context, new AbortController(), () => null)
}

function runtimeHandlers(): RuntimeHandlers {
  return {
    onEvent: async () => undefined,
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onUserInputRequest: async () => ({ answers: {} }),
  }
}

// A server on a fake runtime that records each turn's context, with model
// profiles from a models.json in a fresh home.
async function profileServer(
  profiles: unknown,
  env: Record<string, string> = {},
  overrides: Partial<ClaudeRuntime> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-model-profiles-'))
  const configFile = join(root, 'models.json')
  const writeProfiles = (value: unknown) =>
    writeFile(configFile, JSON.stringify(value), { mode: 0o600 })
  await writeProfiles(profiles)
  const restore = saveEnv(PROFILE_ENV)
  for (const key of PROFILE_ENV) delete process.env[key]
  process.env.HOME = root
  process.env.CLAUDE_CODEX_HOME = root
  process.env.CLAUDE_CODEX_MODEL_PROFILES_FILE = configFile
  Object.assign(process.env, env)
  const contexts: RuntimeTurnContext[] = []
  const completed = new Set<string>()
  const runtime: ClaudeRuntime = {
    runTurn: async (context, handlers) => {
      contexts.push(context)
      await handlers.onEvent({ type: 'completed', success: true, result: '{}' })
    },
    steer: async () => {},
    interrupt: async () => {},
    stop: async () => {},
    ...overrides,
  }
  const store = new SessionStore(join(root, 'state.sqlite'))
  const server = new CodexClaudeAppServer(store, runtime)
  const responses = new Map<unknown, any>()
  const startedThreads: string[] = []
  const notifications: Array<{ method: string; params: any }> = []
  const peer: RpcPeer = {
    id: 'model-profiles-test',
    close: () => {},
    send: (message) => {
      if ('id' in message) responses.set(message.id, message)
      else if ('method' in message) notifications.push(message as { method: string; params: any })
      if ('method' in message && message.method === 'turn/completed') {
        completed.add((message.params as { turn: { id: string } }).turn.id)
      }
      if ('method' in message && message.method === 'thread/started') {
        startedThreads.push((message.params as { thread: { id: string } }).thread.id)
      }
    },
  }
  let nextId = 0
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId
    await server.handle(peer, { id, method, params })
    return responses.get(id)
  }
  const runTurn = async (threadId: string, params: Record<string, unknown> = {}) => {
    const response = await call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Hello.' }],
      ...params,
    })
    assert.equal(response.error, undefined, response.error?.message)
    for (let waited = 0; !completed.has(response.result.turn.id); waited += 10) {
      assert.ok(waited < 5_000, 'turn did not complete')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return contexts.at(-1)
  }
  const close = async () => {
    await server.stop()
    restore()
    await rm(root, { recursive: true, force: true })
  }
  return {
    root,
    configFile,
    store,
    contexts,
    notifications,
    startedThreads,
    call,
    runTurn,
    writeProfiles,
    close,
  }
}

// The App can still open and read the chat, while every request that would
// start Claude for it, and every turn the adapter would start on its own, is
// refused with `refusal` and launches nothing. Its profile pin stays put.
async function assertOpensButStartsNothing(
  harness: Awaited<ReturnType<typeof profileServer>>,
  threadId: string,
  refusal: RegExp,
): Promise<void> {
  const { call, contexts, notifications, store } = harness
  const launched = contexts.length
  const pinned = store.getThread(threadId)?.modelProfileFingerprint ?? null
  const model = store.getThread(threadId)?.model
  const turns = store.listTurns(threadId).length
  assert.ok(turns > 0)

  const resumed = await call('thread/resume', { threadId })
  assert.equal(resumed.error, undefined, resumed.error?.message)
  assert.equal(resumed.result.thread.id, threadId)
  assert.equal(resumed.result.thread.turns.length, turns)
  // A model the resume names, its own or another, does not re-pin the chat either.
  for (const named of [model, 'second-model']) {
    const renamed = await call('thread/resume', { threadId, model: named })
    assert.equal(renamed.error, undefined, renamed.error?.message)
    assert.equal(renamed.result.model, model)
  }
  const read = await call('thread/read', { threadId, includeTurns: true })
  assert.equal(read.error, undefined, read.error?.message)
  assert.equal(read.result.thread.turns.length, turns)

  const turn = await call('turn/start', { threadId, input: [{ type: 'text', text: 'Continue.' }] })
  assert.match(turn.error?.message ?? '', refusal)
  const review = await call('review/start', {
    threadId,
    delivery: 'inline',
    target: { type: 'custom', instructions: 'Review.' },
  })
  assert.match(review.error?.message ?? '', refusal)
  const compact = await call('thread/compact/start', { threadId })
  assert.match(compact.error?.message ?? '', refusal)
  const fork = await call('thread/fork', { threadId })
  assert.match(fork.error?.message ?? '', refusal)
  const moved = await call('thread/metadata/update', { threadId, model: 'second-model' })
  assert.match(moved.error?.message ?? '', refusal)
  // The user puts it right by starting a new chat: an invalid request.
  for (const refused of [turn, review, compact, fork, moved])
    assert.equal(refused.error?.code, INVALID_REQUEST)

  // Turns the adapter starts by itself say why they did not, in words the App
  // shows as they are.
  const refused = async (method: string, params: Record<string, unknown>) => {
    const before = notifications.filter((entry) => entry.method === 'error').length
    const response = await call(method, { threadId, ...params })
    assert.equal(response.error, undefined, response.error?.message)
    for (let waited = 0; ; waited += 10) {
      const errors = notifications.filter((entry) => entry.method === 'error')
      if (errors.length > before) {
        const message = errors.at(-1)?.params.error.message ?? ''
        assert.match(message, refusal)
        assert.doesNotMatch(message, /^Error\b/)
        return response.result
      }
      assert.ok(waited < 5_000, `${method} reported no refusal`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  await refused('thread/goal/set', { objective: 'Keep going.', status: 'active' })
  await call('thread/goal/clear', { threadId })
  const queued = await refused('thread/queue/add', { input: [{ type: 'text', text: 'Later.' }] })
  // The queued message stays queued.
  assert.deepEqual(
    store.listQueue(threadId).map((entry) => entry.id),
    [queued.queuedSubmission.id],
  )
  await call('thread/queue/delete', { threadId, queuedSubmissionId: queued.queuedSubmission.id })

  assert.equal(contexts.length, launched)
  assert.equal(store.listTurns(threadId).length, turns)
  assert.equal(store.getThread(threadId)?.model, model)
  assert.equal(store.getThread(threadId)?.modelProfileFingerprint ?? null, pinned)
}

function saveEnv(keys: string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const)
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
