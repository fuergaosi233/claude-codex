import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function fakeCodex(
  dir: string,
  name = 'real codex',
  body = 'echo "codex-cli 9.9.9"',
): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
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

test('doctor checks the native route before mock and the runtime type', async () => {
  await withTempDir(async (dir) => {
    const codex = await fakeCodex(dir)
    const result = await runDoctor(dir, {
      CLAUDE_CODEX_ROUTE: 'codex',
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_RUNTIME_TYPE: 'bogus',
      CODEX_REAL: codex,
    })
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^ok - runtime type: codex \(from environment\)$/m)
    assert.match(result.stdout, /^ok - real Codex passthrough: codex-cli 9\.9\.9$/m)
  })
})

test('doctor looks for the real Codex as the shim does in the native route', async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, 'bin')
    await mkdir(bin)
    await fakeCodex(bin, 'codex')
    // Not executable: the shim skips it for the native route and walks PATH;
    // the adapter runs CODEX_REAL as it is for codex-proxy.
    const plain = join(dir, 'plain-codex')
    await writeFile(plain, '')
    const env = { CODEX_REAL: plain, PATH: `${bin}:${process.env.PATH}` }
    const native = await runDoctor(dir, { ...env, CLAUDE_CODEX_ROUTE: 'codex' })
    assert.match(native.stdout, /^ok - real Codex passthrough: codex-cli 9\.9\.9$/m)
    const proxy = await runDoctor(dir, { ...env, CLAUDE_CODEX_RUNTIME_TYPE: 'codex-proxy' })
    assert.ok(
      proxy.stdout.includes(`fail - real Codex CLI for codex-proxy: ${plain}: EACCES`),
      proxy.stdout,
    )
  })
})

test('doctor names the signal that killed a command', async () => {
  await withTempDir(async (dir) => {
    const codex = await fakeCodex(dir, 'killed codex', 'kill -KILL $$')
    const result = await runDoctor(dir, {
      CLAUDE_CODEX_RUNTIME_TYPE: 'codex-proxy',
      CODEX_REAL: codex,
    })
    assert.equal(result.code, 1)
    assert.ok(
      result.stdout.includes(`fail - real Codex CLI for codex-proxy: ${codex} killed by SIGKILL`),
      result.stdout,
    )
  })
})

test('doctor reads quoted, commented and ~ values in the runtime env file', async () => {
  await withTempDir(async (dir) => {
    const runtimeEnv = join(dir, 'runtime.env')
    await writeFile(
      runtimeEnv,
      [
        '# written by hand',
        "CLAUDE_CODEX_RUNTIME_TYPE='codex-proxy' # a comment",
        'export CODEX_REAL="~/a\\"b\\$c\\`d\\\\e"',
        'export CLAUDE_CODEX_ADAPTER=~/missing/adapter.mjs',
        'export CLAUDE_CODEX_NODE=node; echo',
        '',
      ].join('\n'),
    )
    const result = await runDoctor(dir, { CLAUDE_CODEX_RUNTIME_ENV: runtimeEnv })
    assert.ok(
      result.stdout.includes(`ok - runtime type: codex-proxy (from ${runtimeEnv})`),
      result.stdout,
    )
    // Double quotes keep `~` and unescape the rest; a leading unquoted `~/`
    // is HOME, as the shell reads them.
    assert.ok(
      result.stdout.includes('fail - real Codex CLI for codex-proxy: ~/a"b$c`d\\e: ENOENT'),
      result.stdout,
    )
    assert.ok(
      result.stdout.includes(`fail - built adapter starts: ${join(dir, 'missing/adapter.mjs')}`),
      result.stdout,
    )
    assert.match(
      result.stdout,
      /^ok - runtime env file: skipped lines the doctor cannot evaluate: CLAUDE_CODEX_NODE \(line 5\)$/m,
    )
  })
})

test('doctor fails the runtime type when the file sets it in a way it cannot read', async () => {
  await withTempDir(async (dir) => {
    const runtimeEnv = join(dir, 'runtime.env')
    await writeFile(runtimeEnv, 'export CLAUDE_CODEX_RUNTIME_TYPE=codex-proxy;\n')
    const result = await runDoctor(dir, { CLAUDE_CODEX_RUNTIME_ENV: runtimeEnv })
    assert.equal(result.code, 1)
    assert.ok(
      result.stdout.includes(
        `fail - runtime type: cannot read CLAUDE_CODEX_RUNTIME_TYPE (line 1) in ${runtimeEnv}`,
      ),
      result.stdout,
    )
  })
})

test('doctor names where the runtime type came from, not just that the file exists', async () => {
  await withTempDir(async (dir) => {
    const codex = await fakeCodex(dir)
    const runtimeEnv = join(dir, 'runtime.env')
    await writeFile(runtimeEnv, 'export CLAUDE_CODEX_DEFAULT_MODEL="opus"\n')
    const fromEnv = await runDoctor(dir, {
      CLAUDE_CODEX_RUNTIME_ENV: runtimeEnv,
      CLAUDE_CODEX_RUNTIME_TYPE: 'codex-proxy',
      CODEX_REAL: codex,
    })
    assert.match(fromEnv.stdout, /^ok - runtime type: codex-proxy \(from environment\)$/m)
    const byDefault = await runDoctor(dir, { CLAUDE_CODEX_RUNTIME_ENV: runtimeEnv })
    assert.match(byDefault.stdout, /^ok - runtime type: agent-sdk-sidecar \(default\)$/m)
  })
})
