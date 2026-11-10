import assert from 'node:assert/strict'
import { lstat, mkdir, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

test('fs/getMetadata retains target metadata and reports a file or directory symlink', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const file = join(app.home, 'file.txt')
      const directory = join(app.home, 'directory')
      await writeFile(file, 'example')
      await mkdir(directory)
      await utimes(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))
      await symlink('file.txt', join(app.home, 'file-link'), 'file')
      await symlink('directory', join(app.home, 'directory-link'), 'dir')

      for (const [path, target, isSymlink] of [
        [file, file, false],
        [directory, directory, false],
        [join(app.home, 'file-link'), file, true],
        [join(app.home, 'directory-link'), directory, true],
      ] as const) {
        const expected = await stat(target)
        assert.deepEqual(await app.request('fs/getMetadata', { path }), {
          isDirectory: expected.isDirectory(),
          isFile: expected.isFile(),
          isSymlink,
          createdAtMs: expected.birthtimeMs,
          modifiedAtMs: expected.mtimeMs,
        })
      }
    },
  )
})

test('fs/getMetadata reads dangling links but preserves missing-path and target-loop errors', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const dangling = join(app.home, 'dangling')
      await symlink('missing', dangling, 'file')
      const expected = await lstat(dangling)
      assert.deepEqual(await app.request('fs/getMetadata', { path: dangling }), {
        isDirectory: false,
        isFile: false,
        isSymlink: true,
        createdAtMs: expected.birthtimeMs,
        modifiedAtMs: expected.mtimeMs,
      })
      const missing = await app.call('fs/getMetadata', { path: join(app.home, 'missing') })
      assert.equal(missing.error?.code, -32000)
      assert.match(missing.error?.message ?? '', /ENOENT/)
      await symlink('loop', join(app.home, 'loop'), 'file')
      const loop = await app.call('fs/getMetadata', { path: join(app.home, 'loop') })
      assert.equal(loop.error?.code, -32000)
      assert.match(loop.error?.message ?? '', /ELOOP/)
    },
  )
})
