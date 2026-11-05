import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

// `npm test` runs from the repository root.
const shim = resolve('scripts/codex-shim')

// A PATH with only the tools the shim itself needs, so no `codex` on the
// developer's PATH can stand in for the real one.
async function minimalPath(dir: string): Promise<string> {
  await mkdir(dir)
  for (const tool of ['bash', 'awk', 'dirname', 'basename']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
    assert.equal(found.status, 0, `${tool} not found`)
    await symlink(found.stdout.trim(), join(dir, tool))
  }
  return dir
}

test('the shim hands schema generation to the real codex, never to the adapter', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-shim-'))
  const argvLog = join(home, 'argv.log')
  const realCodex = join(home, 'real-codex')
  await writeFile(
    realCodex,
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > '${argvLog}'\n`,
  )
  await chmod(realCodex, 0o755)
  // Stands in for node: if the shim starts the adapter, this records it.
  const fakeNode = join(home, 'fake-node')
  const nodeLog = join(home, 'node.log')
  await writeFile(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$*" > '${nodeLog}'\n`)
  await chmod(fakeNode, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, 'codex'),
    // The shim sources a runtime env; keep the developer's own out of it.
    CLAUDE_CODEX_RUNTIME_ENV: join(home, 'runtime.env'),
    CLAUDE_CODEX_ADAPTER: join(home, 'missing-adapter.mjs'),
    CLAUDE_CODEX_NODE: fakeNode,
    PATH: await minimalPath(join(home, 'bin')),
  }
  for (const key of ['CLAUDE_CODEX_ROUTE', 'CLAUDE_CODEX_RUNTIME_TYPE', 'CODEX_REAL']) {
    delete env[key]
  }
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(shim, ['app-server', ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 15_000,
    })
  try {
    for (const args of [
      ['generate-ts', '--experimental', '--out', join(home, 'ts out')],
      ['generate-json-schema', '--out', join(home, 'schema')],
      // Global options may come before the subcommand.
      ['-c', 'model="o3"', 'generate-ts', '--out', join(home, 'ts')],
    ]) {
      const forwarded = run(args, { CODEX_REAL: realCodex })
      assert.equal(forwarded.status, 0, forwarded.stderr)
      assert.deepEqual((await readFile(argvLog, 'utf8')).split('\n'), ['app-server', ...args, ''])
      await rm(argvLog)
    }

    const missing = run(['generate-ts', '--experimental', '--out', join(home, 'ts')])
    assert.equal(missing.status, 127)
    assert.equal(missing.stdout, '')
    assert.match(missing.stderr, /set CODEX_REAL/)
    assert.equal(existsSync(nodeLog), false, 'the adapter must not start')

    // Other app-server calls still go to the adapter.
    const served = run(['--listen', 'stdio://'], { CODEX_REAL: realCodex })
    assert.equal(served.status, 0, served.stderr)
    assert.equal(
      (await readFile(nodeLog, 'utf8')).trim(),
      `${join(home, 'missing-adapter.mjs')} app-server --listen stdio://`,
    )
    assert.equal(existsSync(argvLog), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
