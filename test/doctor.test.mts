import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { normalizeRuntimeType } from '../src/runtime-config.mjs'

const execFileAsync = promisify(execFile)
// This file runs from dist/test; the doctor lives in the source tree.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const doctor = join(repoRoot, 'scripts', 'doctor.mjs')

interface DoctorRun {
  code: number
  stdout: string
  stderr: string
}

// Runs the doctor from a temp directory with a clean CLAUDE_CODEX_* / CODEX_*
// environment, a temp HOME, and `env` on top.
async function runDoctor(dir: string, env: Record<string, string>): Promise<DoctorRun> {
  const base: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CLAUDE_CODEX_') && !key.startsWith('CODEX_')) base[key] = value
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [doctor], {
      cwd: dir,
      env: {
        ...base,
        HOME: dir,
        CLAUDE_CODEX_RUNTIME_ENV: join(dir, 'missing-runtime.env'),
        ...env,
      },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-doctor-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function fakeCodex(dir: string): Promise<string> {
  const path = join(dir, 'real codex')
  await writeFile(path, '#!/bin/sh\necho "codex-cli 9.9.9"\n')
  await chmod(path, 0o755)
  return path
}

test('doctor checks codex-proxy from any directory, with paths from the checkout', async () => {
  await withTempDir(async (dir) => {
    const codex = await fakeCodex(dir)
    const result = await runDoctor(dir, {
      CLAUDE_CODEX_RUNTIME_TYPE: 'codex-proxy',
      CODEX_REAL: codex,
    })
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^ok - runtime type: codex-proxy \(from environment\)$/m)
    assert.match(result.stdout, /^ok - built adapter starts: appServerVersion \S+$/m)
    assert.match(result.stdout, /^ok - shim version probe$/m)
    assert.match(result.stdout, /^ok - real Codex CLI for codex-proxy: codex-cli 9\.9\.9$/m)
    assert.doesNotMatch(result.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

test('doctor reports an unknown runtime type as a failed check, not a crash', async () => {
  await withTempDir(async (dir) => {
    const result = await runDoctor(dir, { CLAUDE_CODEX_RUNTIME_TYPE: 'bogus' })
    assert.equal(result.code, 1)
    assert.match(result.stdout, /^fail - runtime type: unknown CLAUDE_CODEX_RUNTIME_TYPE: bogus$/m)
    assert.match(result.stdout, /^ok - node >= 24/m)
    assert.equal(result.stderr, '')
  })
})

test('doctor names the error when a command cannot be spawned', async () => {
  await withTempDir(async (dir) => {
    const missing = join(dir, 'no-such-codex')
    const result = await runDoctor(dir, {
      CLAUDE_CODEX_RUNTIME_TYPE: 'codex-proxy',
      CODEX_REAL: missing,
    })
    assert.equal(result.code, 1)
    assert.ok(
      result.stdout.includes(`fail - real Codex CLI for codex-proxy: ${missing}: ENOENT`),
      result.stdout,
    )
  })
})

test('doctor reads the runtime env file the shim sources, over the environment', async () => {
  await withTempDir(async (dir) => {
    const codex = await fakeCodex(dir)
    const runtimeEnv = join(dir, 'runtime.env')
    // What `claude-codex-mode set` writes, plus a line the doctor cannot
    // evaluate and has to skip.
    await writeFile(
      runtimeEnv,
      [
        'export CLAUDE_CODEX_RUNTIME_TYPE="codex-proxy"',
        `export CODEX_REAL="${codex}"`,
        'export CLAUDE_CODEX_ADAPTER="$(pwd)/adapter.mjs"',
        '',
      ].join('\n'),
    )
    const result = await runDoctor(dir, {
      CLAUDE_CODEX_RUNTIME_ENV: runtimeEnv,
      CLAUDE_CODEX_RUNTIME_TYPE: 'agentapi',
    })
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.ok(
      result.stdout.includes(`ok - runtime type: codex-proxy (from ${runtimeEnv})`),
      result.stdout,
    )
    assert.match(result.stdout, /^ok - real Codex CLI for codex-proxy: codex-cli 9\.9\.9$/m)
    assert.doesNotMatch(result.stdout, /agentapi/)
  })
})

test('doctor accepts every runtime type alias the adapter accepts', async () => {
  const source = await readFile(join(repoRoot, 'src', 'runtime-config.mts'), 'utf8')
  const body = source.slice(source.indexOf('export function normalizeRuntimeType'))
  const aliases = [...body.slice(0, body.indexOf('default:')).matchAll(/case '([^']+)':/g)].map(
    (match) => match[1] as string,
  )
  assert.ok(aliases.includes('codex-proxy'), aliases.join(', '))
  await withTempDir(async (dir) => {
    const codex = await fakeCodex(dir)
    const results = await Promise.all(
      aliases.map((alias) =>
        runDoctor(dir, {
          CLAUDE_CODEX_RUNTIME_TYPE: alias,
          CODEX_REAL: codex,
          CLAUDE_CODEX_HTTP_BASE_URL: 'http://127.0.0.1:9',
        }),
      ),
    )
    aliases.forEach((alias, index) => {
      const stdout = results[index]?.stdout ?? ''
      const line = /^(ok|fail) - runtime type: (\S+)/m.exec(stdout)
      assert.equal(line?.[1], 'ok', `${alias}: ${stdout}`)
      assert.equal(line?.[2], normalizeRuntimeType(alias), alias)
    })
  })
})
