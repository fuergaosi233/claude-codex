import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { gitRoot } from '../../src/project-instructions.mjs'

// A fresh temp folder with no .git in it or above it, for tests about folders
// outside any repository. A stray .git above the temp dir (an empty /tmp/.git
// is enough) puts every folder under it in that repository, as Codex sees it,
// so this tries the other usual temp dirs before skipping the test. Returns
// null once the test is skipped.
export async function tempRootOutsideGit(t: TestContext, prefix: string): Promise<string | null> {
  const bases = [tmpdir(), ...(process.platform === 'win32' ? [] : ['/var/tmp', '/dev/shm'])]
  for (const base of bases) {
    if (gitRoot(base) !== null) continue
    try {
      return await mkdtemp(join(base, prefix))
    } catch {
      // Missing or read-only here; try the next one.
    }
  }
  t.skip(`a .git above ${tmpdir()} makes every temp folder part of a repository`)
  return null
}
