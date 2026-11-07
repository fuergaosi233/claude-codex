import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const shim = resolve('scripts/codex-shim')

test('the shim never takes itself or another copy of it for the real codex', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-'))
  const dir = (name: string) => join(home, name)
  // Only the tools the shim needs, so no codex the host has installed (CI
  // installs one) can stand in for the real one.
  await mkdir(dir('tools'))
  for (const tool of ['bash', 'awk', 'dirname', 'basename', 'cmp']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
    assert.equal(found.status, 0, `${tool} not found`)
    await symlink(found.stdout.trim(), join(dir('tools'), tool))
  }
  for (const name of ['bin', 'a', 'b', 'real']) await mkdir(dir(name))
  for (const name of ['bin', 'a', 'b']) {
    await copyFile(shim, join(dir(name), 'codex'))
    await chmod(join(dir(name), 'codex'), 0o755)
  }
  await symlink('bin', dir('link'))
  const realCodex = join(dir('real'), 'codex')
  await writeFile(realCodex, '#!/bin/sh\nprintf "real codex: %s\\n" "$*"\n')
  await chmod(realCodex, 0o755)
  const run = (path: string[], args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync('codex', args, {
      env: { HOME: home, PATH: [...path, 'tools'].map(dir).join(':'), ...env },
      encoding: 'utf8',
      // A shim that execs itself never exits.
      timeout: 5_000,
      killSignal: 'SIGKILL',
    })
    const label = `PATH=${path.join(':')} codex ${args.join(' ')}`
    return { ...result, label: `${label}: ${result.error ?? result.stderr}` }
  }
  try {
    // Behind a symlinked dir, as two copies, and as the same dir twice.
    for (const path of [['link'], ['a', 'b'], ['bin', 'link']]) {
      const missing = run(path, ['exec', 'hi'])
      assert.equal(missing.status, 127, missing.label)
      assert.equal(
        missing.stderr,
        'codex shim supports --version and app-server; set CODEX_REAL for fallback\n',
      )
      const native = run(path, ['app-server'], { CLAUDE_CODEX_ROUTE: 'native' })
      assert.equal(native.status, 127, native.label)
      assert.match(native.stderr, /no real codex binary was found; set CODEX_REAL\n$/)

      const later = run([...path, 'real'], ['exec', 'hi'])
      assert.equal(later.status, 0, later.label)
      assert.equal(later.stdout, 'real codex: exec hi\n')
      const version = run([...path, 'real'], ['--version'], { CLAUDE_CODEX_ROUTE: 'native' })
      assert.equal(version.status, 0, version.label)
      assert.equal(version.stdout, 'real codex: --version\n')

      const explicit = run(path, ['exec', 'hi'], { CODEX_REAL: realCodex })
      assert.equal(explicit.status, 0, explicit.label)
      assert.equal(explicit.stdout, 'real codex: exec hi\n')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
