import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const modeScript = resolve('scripts/claude-codex-mode')
const shim = resolve('scripts/codex-shim')
const printVars =
  'printf "%s\\n" "$CLAUDE_CODEX_DEFAULT_MODEL" "$CLAUDE_CODEX_BRIDGE_CWD" "$CLAUDE_CODEX_NODE"'

async function modeHost() {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-mode-env-'))
  const home = join(root, 'home')
  const bin = join(home, '.local', 'bin')
  // `set` and `model` stop every app-server on the host; an empty `ps` keeps
  // them off the ones the rest of the suite runs.
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'ps'), '#!/bin/sh\nexit 0\n')
  await chmod(join(bin, 'ps'), 0o755)
  const realCodex = join(root, 'real-codex')
  await writeFile(realCodex, `#!/bin/sh\n${printVars}\n`)
  await chmod(realCodex, 0o755)
  const envFile = join(root, 'state', 'runtime.env')
  await mkdir(join(root, 'state'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CODEX_STATE_DIR: join(root, 'state'),
    CLAUDE_CODEX_RUNTIME_ENV: envFile,
    CODEX_REAL: realCodex,
  }
  const run = (file: string, ...args: string[]) =>
    spawnSync(file, args, { cwd: root, env, encoding: 'utf8', timeout: 20_000 })
  return { root, envFile, run }
}

test('runtime.env gives every reader back the exact model and cwd, and runs nothing in them', async () => {
  const { root, envFile, run } = await modeHost()
  try {
    const marker = join(root, 'pwned')
    const model = `opus $HOME "dq" 'sq' \`touch ${marker}\` $(touch ${marker}) back\\slash`
    // The command substitution is relative to `root`, where every reader runs.
    const cwd = join(root, `proj $HOME "dq" 'sq' \`touch pwned\``)
    await mkdir(cwd)
    // Lines written before values were shell-quoted.
    await writeFile(
      envFile,
      'export CLAUDE_CODEX_RUNTIME_TYPE="agentapi"\nexport CLAUDE_CODEX_NODE="/opt/node bin/node"\n',
    )

    const set = run('bash', modeScript, 'set', 'claude-p', model, cwd)
    assert.equal(set.status, 0, set.stderr)

    const text = await readFile(envFile, 'utf8')
    assert.equal(text.match(/CLAUDE_CODEX_RUNTIME_TYPE=/g)?.length, 1, text)
    assert.match(text, /^export CLAUDE_CODEX_NODE="\/opt\/node bin\/node"$/m)

    const expected = `${model}\n${cwd}\n/opt/node bin/node\n`
    for (const shell of ['bash', 'sh']) {
      const sourced = run(shell, '-c', `. "$1"; ${printVars}`, shell, envFile)
      assert.equal(sourced.stdout, expected, `${shell}: ${sourced.stderr}`)
    }
    const shimmed = run(shim, 'exec')
    assert.equal(shimmed.stdout, expected, shimmed.stderr)
    const status = run('bash', modeScript, 'status')
    assert.equal(status.status, 0, status.stderr)
    const lines = status.stdout.split('\n')
    assert.ok(lines.includes(`model: ${model}`), status.stdout)
    assert.ok(lines.includes(`bridge cwd: ${cwd}`), status.stdout)

    assert.equal(existsSync(marker), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('claude-codex-mode refuses a value with a line break and leaves runtime.env as it was', async () => {
  const { root, envFile, run } = await modeHost()
  try {
    assert.equal(run('bash', modeScript, 'set', 'claude-p', 'sonnet').status, 0)
    const before = await readFile(envFile, 'utf8')

    const result = run('bash', modeScript, 'model', 'opus\nexport CLAUDE_CODEX_RUNTIME_TYPE=codex')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /CLAUDE_CODEX_DEFAULT_MODEL cannot contain a line break/)
    assert.equal(await readFile(envFile, 'utf8'), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
