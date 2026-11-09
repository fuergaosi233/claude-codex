import { type FSWatcher, statSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { debugLog } from './util.mjs'

// Codex coalesces a watch's events over this window before it sends
// `fs/changed` (codex-rs/app-server/src/fs_watch.rs).
export const FS_WATCH_DEBOUNCE_MS = 200

export interface PathWatch {
  close(): void
}

// Watches `path` the way Codex's `fs/watch` does: non-recursively, reporting
// paths under the requested path rather than its realpath. A directory is
// watched itself, and each change is reported as the entry inside it. A file,
// or a path that does not exist yet (FETCH_HEAD before the first fetch), is
// watched through its parent directory, so the watch survives the file being
// replaced by a rename (git's `HEAD.lock` -> `HEAD`) and fires once it appears.
// Throws when neither the path nor its parent can be watched.
export function watchPath(
  path: string,
  onChange: (changedPaths: string[]) => void,
  debounceMs = FS_WATCH_DEBOUNCE_MS,
): PathWatch {
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  const changed = (changedPath: string): void => {
    pending.add(changedPath)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const paths = [...pending]
      pending.clear()
      onChange(paths)
    }, debounceMs)
    timer.unref()
  }

  let watcher: FSWatcher
  if (isDirectory(path)) {
    watcher = watch(path, { persistent: false }, (_eventType, filename) => {
      changed(filename ? join(path, String(filename)) : path)
    })
  } else {
    const name = basename(path)
    watcher = watch(dirname(path), { persistent: false }, (_eventType, filename) => {
      // Without a filename the event may be about the file; report it.
      if (!filename || String(filename) === name) changed(path)
    })
  }
  // A watched directory that goes away errors the watcher. Unhandled, that
  // error would end the process; the watch just stops instead.
  watcher.on('error', (error) => debugLog('fs_watch_error', { path, error: String(error) }))
  return {
    close: () => {
      watcher.close()
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
