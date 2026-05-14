#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { chmod, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import { dirname, resolve } from 'node:path'

const socketPath = getArg('--socket') || process.env.CLAUDE_CODEX_RUNTIME_SOCKET || resolve('.claude-codex/runtime.sock')
const python = process.env.CLAUDE_CODEX_PYTHON || resolve('.venv/bin/python')
const sidecar = process.env.CLAUDE_CODEX_SIDECAR || resolve('python/claude_sidecar.py')

await mkdir(dirname(socketPath), { recursive: true })
await rm(socketPath, { force: true })

const server = net.createServer((socket) => {
  const child = spawn(python, [sidecar], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(`[claude-runtime-daemon] ${chunk}`))
  socket.pipe(child.stdin)
  child.stdout.pipe(socket)
  socket.on('close', () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 3000)
    force.unref()
  })
  child.on('exit', () => socket.destroy())
})

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o600).catch(() => {})
  process.stderr.write(`[claude-runtime-daemon] listening on ${socketPath}\n`)
})

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

function shutdown() {
  server.close(() => {
    void rm(socketPath, { force: true }).finally(() => process.exit(0))
  })
}

function getArg(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1] || null
  const prefix = `${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}
