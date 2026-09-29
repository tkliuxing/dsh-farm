/**
 * dsh-farm — Node half.
 *
 * Process supervisor for long-running project services:
 *  - registry (dynamic services persisted under $DSH_HOME/storages/dsh-farm)
 *  - farm.yaml per-workspace declarations (merged into the list view)
 *  - spawn / stop / restart with a small status machine and auto-restart
 *  - log pipeline: in-memory ring buffer + on-disk append + SSE stream
 *  - HTTP API under /farm for the browser half
 *  - agent tools: farm_status/start/stop/restart/logs/register/unregister
 *
 * Dependency-free on purpose: the tool registry accepts a plain
 * ToolDefinition, and routes ride ctx.webServer.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-farm'

/** Wait for the tool registry and the web HTTP carrier before mounting. */
export const inject = ['tools', 'webServer']

const RING_DEFAULT = 5000
const STOP_GRACE_MS = 3000
const RESTART_MAX = 5
const RESTART_BASE_MS = 1000

const RUNNING = new Set(['running', 'starting', 'unhealthy'])

function defaultDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-farm')
}

function serviceId(workspace, serviceName) {
  return createHash('sha1').update(`${workspace}::${serviceName}`).digest('hex').slice(0, 12)
}

// ── minimal farm.yaml reader (no dependency) ────────────────────────────────
// Recognized shape:
//   services:
//     dev-server:
//       command: pnpm dev
//       cwd: sub/dir            # optional, resolved against the workspace
//       autoRestart: true
//       env:                    # optional flat string map
//         KEY: value
//
// A scalar may be wrapped in one matching pair of quotes, which are then
// syntax. Quotes that are part of the value stay put: `command: node -e
// "console.log(1)"` must keep its `"`. The naive `^["']|["']$` strip this used
// to do truncated every such command (and every `'a' && 'b'`), so the closing
// quote is only syntax when it is the last character AND no unescaped quote of
// the same kind appears between the pair.
function unquoteYamlScalar(value) {
  const text = value.trim()
  const quote = text[0]
  if (text.length < 2) return text
  if (quote !== '"' && quote !== "'") return text
  if (text[text.length - 1] !== quote) return text
  if (text.slice(1, -1).includes(quote)) return text
  return text.slice(1, -1)
}

export function parseFarmYaml(text, workspace) {
  const services = {}
  let current = null
  let inServices = false
  let inEnv = false
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    if (indent === 0) {
      inServices = line === 'services:'
      inEnv = false
      if (!inServices) current = null
      continue
    }
    if (!inServices) continue
    if (indent === 2 && line.endsWith(':') && !line.includes(': ')) {
      current = line.slice(0, -1).trim()
      services[current] = { command: '', cwd: '', autoRestart: false, env: {} }
      inEnv = false
      continue
    }
    if (!current) continue
    const kv = line.match(/^([A-Za-z_][\w.-]*):\s*(.*)$/)
    if (!kv) continue
    const [, key, value] = kv
    if (indent <= 4) inEnv = false
    if (key === 'env' && value === '') { inEnv = true; continue }
    if (inEnv && indent >= 6) { services[current].env[key] = unquoteYamlScalar(value); continue }
    if (key === 'command') services[current].command = unquoteYamlScalar(value)
    else if (key === 'cwd') services[current].cwd = unquoteYamlScalar(value)
    else if (key === 'autoRestart') services[current].autoRestart = value === 'true'
  }
  const out = {}
  for (const [svcName, svc] of Object.entries(services)) {
    if (!svcName || !svc.command) continue
    out[svcName] = {
      id: serviceId(workspace, svcName),
      name: svcName,
      workspace,
      command: svc.command,
      cwd: svc.cwd ? (svc.cwd.startsWith('/') ? svc.cwd : join(workspace, svc.cwd)) : workspace,
      env: svc.env || {},
      autoRestart: svc.autoRestart === true,
      source: 'yaml',
    }
  }
  return out
}

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || defaultDataDir()
  const ringLimit = config.ringLines || RING_DEFAULT
  const stopGraceMs = config.stopGraceMs || STOP_GRACE_MS
  const logDir = join(dataDir, 'logs')
  const registryPath = join(dataDir, 'services.json')
  mkdirSync(logDir, { recursive: true })

  /** @type {Map<string, object>} dynamic registry: id -> record */
  const dynamic = new Map()
  /** runtime state: id -> { child, status, pid, startedAt, lastExit, ring: [], restarts, fileOffset } */
  const runtime = new Map()
  /** SSE response sockets per service id */
  const streams = new Map()

  try {
    if (existsSync(registryPath)) {
      const saved = JSON.parse(readFileSync(registryPath, 'utf8'))
      for (const rec of Array.isArray(saved) ? saved : []) {
        if (rec && rec.id && rec.name && rec.workspace && rec.command) {
          rec.source = 'dynamic'
          dynamic.set(rec.id, rec)
        }
      }
    }
  } catch (err) {
    ctx.logger?.warn?.('[dsh-farm] failed to read registry: %s', err.message)
  }

  const persist = () => {
    try {
      writeFileSync(registryPath, JSON.stringify([...dynamic.values()], null, 2))
    } catch (err) {
      ctx.logger?.warn?.('[dsh-farm] failed to persist registry: %s', err.message)
    }
  }

  const logPath = (id) => join(logDir, `${id}.log`)

  const getRuntime = (id) => {
    let rt = runtime.get(id)
    if (!rt) {
      rt = { child: undefined, status: 'stopped', pid: undefined, startedAt: undefined, lastExit: undefined, ring: [], restarts: 0 }
      runtime.set(id, rt)
    }
    return rt
  }

  const pushLine = (rec, line, stream) => {
    const rt = getRuntime(rec.id)
    const entry = { at: Date.now(), stream, text: line }
    rt.ring.push(entry)
    if (rt.ring.length > ringLimit) rt.ring.splice(0, rt.ring.length - ringLimit)
    try { appendFileSync(logPath(rec.id), `${new Date(entry.at).toISOString()} [${stream}] ${line}\n`) } catch {}
    const sinks = streams.get(rec.id)
    if (sinks) {
      const payload = `data: ${JSON.stringify(entry)}\n\n`
      for (const res of [...sinks]) { try { res.write(payload) } catch { sinks.delete(res) } }
    }
  }

  const setStatus = (rec, status) => {
    const rt = getRuntime(rec.id)
    rt.status = status
  }

  const scheduleStreams = (id) => {
    if (!streams.has(id)) streams.set(id, new Set())
    return streams.get(id)
  }

  const start = async (rec) => {
    const rt = getRuntime(rec.id)
    if (RUNNING.has(rt.status) && rt.child) return { ok: false, error: `service ${rec.name} is already ${rt.status}` }
    rt.restarts = 0
    return spawnChild(rec)
  }

  const spawnChild = (rec) => new Promise((resolve) => {
    const rt = getRuntime(rec.id)
    rt.status = 'starting'
    let child
    try {
      child = spawn('/bin/sh', ['-c', rec.command], {
        cwd: rec.cwd || rec.workspace,
        env: { ...process.env, ...(rec.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      rt.status = 'failed'
      resolve({ ok: false, error: `spawn failed: ${err.message}` })
      return
    }
    rt.child = child
    rt.pid = child.pid
    rt.startedAt = Date.now()
    pushLine(rec, `$ ${rec.command}`, 'meta')

    let settled = false
    const settleOk = () => { if (!settled) { settled = true; rt.status = 'running'; resolve({ ok: true, pid: child.pid }) } }
    // A short grace window: an immediately-crashing command resolves as failed.
    const grace = setTimeout(settleOk, 400)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let outBuf = ''
    let errBuf = ''
    child.stdout.on('data', (chunk) => {
      outBuf += chunk
      const lines = outBuf.split('\n')
      outBuf = lines.pop()
      for (const l of lines) pushLine(rec, l, 'stdout')
    })
    child.stderr.on('data', (chunk) => {
      errBuf += chunk
      const lines = errBuf.split('\n')
      errBuf = lines.pop()
      for (const l of lines) pushLine(rec, l, 'stderr')
    })
    child.on('error', (err) => {
      clearTimeout(grace)
      settled = true
      rt.status = 'failed'
      rt.child = undefined
      rt.lastExit = { code: null, signal: undefined, at: Date.now(), error: err.message }
      pushLine(rec, `[farm] spawn error: ${err.message}`, 'meta')
      resolve({ ok: false, error: err.message })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(grace)
      if (outBuf) pushLine(rec, outBuf, 'stdout')
      if (errBuf) pushLine(rec, errBuf, 'stderr')
      pushLine(rec, `[farm] exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`, 'meta')
      rt.child = undefined
      rt.pid = undefined
      rt.lastExit = { code, signal, at: Date.now() }
      const manualStop = rt.status === 'stopping'
      if (manualStop) {
        rt.status = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'exited'
      } else {
        rt.status = code === 0 ? 'exited' : 'failed'
        if (rec.autoRestart && rt.restarts < RESTART_MAX) {
          rt.restarts += 1
          const delay = RESTART_BASE_MS * 2 ** (rt.restarts - 1)
          pushLine(rec, `[farm] auto-restart ${rt.restarts}/${RESTART_MAX} in ${delay}ms`, 'meta')
          setTimeout(() => {
            const cur = dynamic.get(rec.id) || readYamlServices(rec.workspace)[rec.name]
            if (cur) spawnChild(cur)
          }, delay)
          rt.status = 'starting'
        }
      }
      if (!settled) { settled = true; resolve({ ok: false, error: `exited immediately (code=${code})` }) }
    })
  })

  const stop = (rec) => new Promise((resolve) => {
    const rt = getRuntime(rec.id)
    if (!rt.child) {
      rt.status = 'stopped'
      resolve({ ok: true })
      return
    }
    rt.status = 'stopping'
    const child = rt.child
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, stopGraceMs)
    child.once('exit', () => { clearTimeout(killTimer); resolve({ ok: true }) })
    try { child.kill('SIGTERM') } catch { clearTimeout(killTimer); resolve({ ok: true }) }
  })

  // ── farm.yaml merge ───────────────────────────────────────────────────────
  const readYamlServices = (workspace) => {
    if (!workspace) return {}
    const yamlPath = join(workspace, 'farm.yaml')
    if (!existsSync(yamlPath)) return {}
    try {
      return parseFarmYaml(readFileSync(yamlPath, 'utf8'), workspace)
    } catch {
      return {}
    }
  }

  const findRecord = (id) => {
    const dyn = dynamic.get(id)
    if (dyn) return dyn
    // yaml services are discovered by scanning registered workspaces.
    // parseFarmYaml keys them by name, so match on the record's own id.
    const workspaces = new Set([...dynamic.values()].map((r) => r.workspace))
    for (const ws of workspaces) {
      for (const rec of Object.values(readYamlServices(ws))) if (rec.id === id) return rec
    }
    return undefined
  }

  const listServices = (workspace) => {
    const out = []
    const seen = new Set()
    const push = (rec) => {
      if (seen.has(rec.id)) return
      seen.add(rec.id)
      const rt = runtime.get(rec.id)
      out.push({
        id: rec.id,
        name: rec.name,
        workspace: rec.workspace,
        command: rec.command,
        cwd: rec.cwd || rec.workspace,
        source: rec.source,
        autoRestart: rec.autoRestart === true,
        status: rt?.status || 'stopped',
        pid: rt?.pid,
        startedAt: rt?.startedAt,
        lastExit: rt?.lastExit,
      })
    }
    const wsFilter = (rec) => !workspace || rec.workspace === workspace
    for (const rec of dynamic.values()) if (wsFilter(rec)) push(rec)
    const workspaces = workspace ? [workspace] : [...new Set([...dynamic.values()].map((r) => r.workspace))]
    for (const ws of workspaces) {
      for (const rec of Object.values(readYamlServices(ws))) if (wsFilter(rec)) push(rec)
    }
    return out
  }

  /**
   * Unregister a service: stop it if it is running, then drop its registry
   * row, its runtime state, its log sinks and its log file. farm.yaml
   * services belong to the file, so they are refused here instead of
   * silently reappearing on the next list.
   */
  const removeService = async (id) => {
    const rec = findRecord(id)
    if (!rec) return { ok: false, code: 404, error: `unknown service id ${id}` }
    if (!dynamic.has(id)) {
      return { ok: false, code: 400, error: `${rec.name} is declared in ${join(rec.workspace, 'farm.yaml')}; remove it there instead` }
    }
    const rt = runtime.get(id)
    if (rt?.child) await stop(rec)
    dynamic.delete(id)
    runtime.delete(id)
    const sinks = streams.get(id)
    if (sinks) {
      for (const res of [...sinks]) { try { res.end() } catch {} }
      streams.delete(id)
    }
    try { unlinkSync(logPath(id)) } catch {}
    persist()
    return { ok: true, id, name: rec.name }
  }

  // ── HTTP API ──────────────────────────────────────────────────────────────
  const json = (res, code, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(payload)
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

  const tailFile = (id, maxLines) => {
    const p = logPath(id)
    if (!existsSync(p)) return []
    const stat = statSync(p)
    const size = Math.min(stat.size, 512 * 1024)
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(size)
      readSync(fd, buf, 0, size, stat.size - size)
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      return maxLines ? lines.slice(-maxLines) : lines
    } finally { closeSync(fd) }
  }

  const searchRing = (rec, needle, tail) => {
    const rt = getRuntime(rec.id)
    let lines = rt.ring.map((e) => ({ at: e.at, stream: e.stream, text: e.text }))
    if (needle) lines = lines.filter((e) => e.text.toLowerCase().includes(needle.toLowerCase()))
    return tail ? lines.slice(-tail) : lines
  }

  const registerRoute = ctx.webServer.register({
    kind: 'prefix',
    path: '/farm',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://local')
      const parts = url.pathname.split('/').filter(Boolean) // ['farm', ...]
      // /farm/services | /farm/services/:id | /farm/services/:id/(start|stop|restart|logs|logs/stream)
      if (parts[1] === 'services') {
        if (parts.length === 2 && req.method === 'GET') {
          return json(res, 200, { services: listServices(url.searchParams.get('workspace') || undefined) })
        }
        if (parts.length === 2 && req.method === 'POST') {
          let body
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { error: 'invalid JSON body' }) }
          const { name, workspace, command, cwd, env, autoRestart } = body
          if (!name || !workspace || !command) return json(res, 400, { error: 'name, workspace, command are required' })
          if (!workspace.startsWith('/')) return json(res, 400, { error: 'workspace must be an absolute path' })
          const rec = {
            id: serviceId(workspace, name), name, workspace,
            command, cwd: cwd || workspace, env: env || {},
            autoRestart: autoRestart === true, source: 'dynamic',
          }
          dynamic.set(rec.id, rec)
          persist()
          return json(res, 200, { service: rec })
        }
        // Batch unregister. Sits above the /:id routes on purpose: service
        // ids are hex digests, so 'batch-delete' can never shadow one.
        if (parts.length === 3 && parts[2] === 'batch-delete' && req.method === 'POST') {
          let body
          try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { error: 'invalid JSON body' }) }
          const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x) => typeof x === 'string' && x))] : []
          if (!ids.length) return json(res, 400, { error: 'ids must be a non-empty array of service ids' })
          const deleted = []
          const failed = []
          for (const target of ids) {
            const r = await removeService(target)
            if (r.ok) deleted.push({ id: r.id, name: r.name })
            else failed.push({ id: target, error: r.error })
          }
          return json(res, 200, { ok: failed.length === 0, deleted, failed })
        }
        const id = parts[2]
        const rec = findRecord(id) || dynamic.get(id)
        if (!rec) return json(res, 404, { error: `unknown service id ${id}` })
        const action = parts[3]
        if (!action && req.method === 'GET') {
          const svc = listServices().find((s) => s.id === id)
          return svc ? json(res, 200, { service: svc }) : json(res, 404, { error: `unknown service id ${id}` })
        }
        if (!action && req.method === 'DELETE') {
          const r = await removeService(id)
          return r.ok ? json(res, 200, { ok: true, id: r.id, name: r.name }) : json(res, r.code || 400, { error: r.error })
        }
        if (action === 'start' && req.method === 'POST') return json(res, 200, await start(rec))
        if (action === 'stop' && req.method === 'POST') return json(res, 200, await stop(rec))
        if (action === 'restart' && req.method === 'POST') {
          const rt = getRuntime(id)
          if (rt.child) await stop(rec)
          return json(res, 200, await start(rec))
        }
        if (action === 'logs' && parts[4] === 'stream' && req.method === 'GET') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          res.write(': connected\n\n')
          const sinks = scheduleStreams(id)
          sinks.add(res)
          req.on('close', () => sinks.delete(res))
          return
        }
        if (action === 'logs' && req.method === 'GET') {
          const tail = Number(url.searchParams.get('tail') || 0) || undefined
          const search = url.searchParams.get('search') || ''
          const live = searchRing(rec, search, tail)
          const fileLines = tailFile(id, tail)
          const fileFiltered = search ? fileLines.filter((l) => l.toLowerCase().includes(search.toLowerCase())) : fileLines
          if (url.searchParams.get('export')) {
            const body = [...fileFiltered, ...live.map((e) => `${new Date(e.at).toISOString()} [${e.stream}] ${e.text}`)].join('\n')
            res.writeHead(200, {
              'content-type': 'text/plain; charset=utf-8',
              'content-disposition': `attachment; filename="farm-${rec.name}.log"`,
            })
            return res.end(body)
          }
          return json(res, 200, { lines: live, fileTail: fileFiltered.slice(-tail ?? 0) })
        }
      }
      return json(res, 404, { error: `no such farm route: ${req.method} ${url.pathname}` })
    },
  })

  // ── agent tools ───────────────────────────────────────────────────────────
  const toolView = (svc) => [
    `- ${svc.name} (${svc.id})`,
    `  status: ${svc.status}${svc.pid ? ` pid=${svc.pid}` : ''} source=${svc.source}`,
    `  workspace: ${svc.workspace}`,
    `  command: ${svc.command}`,
    svc.lastExit ? `  lastExit: code=${svc.lastExit.code} signal=${svc.lastExit.signal ?? 'none'} at=${new Date(svc.lastExit.at).toISOString()}` : '',
  ].filter(Boolean).join('\n')

  const listForTool = (workspace) => listServices(workspace).map(toolView).join('\n') || '(no services registered)'

  ctx.tools.register({
    name: 'farm_status',
    description: 'List dsh-farm managed services and their status. Optionally filter by workspace absolute path.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Optional workspace absolute path filter' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => listForTool(args?.workspace),
  })

  for (const [toolName, action] of [['farm_start', 'start'], ['farm_stop', 'stop'], ['farm_restart', 'restart']]) {
    ctx.tools.register({
      name: toolName,
      description: {
        farm_start: 'Start a dsh-farm service by id (or unique name).',
        farm_stop: 'Stop a running dsh-farm service by id (or unique name).',
        farm_restart: 'Restart a dsh-farm service by id (or unique name).',
      }[toolName],
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service id or unique service name' },
        },
        required: ['service'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        const svc = listServices().find((s) => s.id === args.service || s.name === args.service)
        if (!svc) return `unknown service: ${args.service}. Use farm_status to list services.`
        if (action === 'start') {
          const r = await start({ ...svc, source: 'dynamic' })
          return r.ok ? `started ${svc.name} (pid=${r.pid})` : `failed to start ${svc.name}: ${r.error}`
        }
        if (action === 'stop') {
          await stop({ ...svc, source: 'dynamic' })
          return `stopped ${svc.name}`
        }
        const rt = getRuntime(svc.id)
        if (rt.child) await stop({ ...svc, source: 'dynamic' })
        const r = await start({ ...svc, source: 'dynamic' })
        return r.ok ? `restarted ${svc.name} (pid=${r.pid})` : `failed to restart ${svc.name}: ${r.error}`
      },
    })
  }

  ctx.tools.register({
    name: 'farm_logs',
    description: 'Read recent log lines of a dsh-farm service. Supports tail count and case-insensitive substring search.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service id or unique service name' },
        tail: { type: 'number', description: 'How many recent lines to return (default 100)' },
        search: { type: 'string', description: 'Case-insensitive substring filter' },
      },
      required: ['service'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => {
      const svc = listServices().find((s) => s.id === args.service || s.name === args.service)
      if (!svc) return `unknown service: ${args.service}`
      const tail = Number(args?.tail || 100)
      const search = String(args?.search || '')
      const lines = searchRing(svc, search, tail)
      const header = `logs of ${svc.name} (${svc.status})${search ? ` matching "${search}"` : ''}, last ${lines.length} in-memory lines:\n`
      return header + (lines.length
        ? lines.map((e) => `${new Date(e.at).toISOString()} [${e.stream}] ${e.text}`).join('\n')
        : `(no in-memory lines yet; full history: ${logPath(svc.id)})`)
    },
  })

  ctx.tools.register({
    name: 'farm_register',
    description: 'Register (or update) a service in dsh-farm so it can be started, watched and stopped. The service runs under this DSH process and is killed when DSH exits.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Service name, unique within the workspace' },
        workspace: { type: 'string', description: 'Absolute path of the owning workspace' },
        command: { type: 'string', description: 'Shell command to run, e.g. "pnpm dev"' },
        cwd: { type: 'string', description: 'Working directory; defaults to the workspace' },
        autoRestart: { type: 'boolean', description: 'Auto-restart on abnormal exit (max 5 tries)' },
      },
      required: ['name', 'workspace', 'command'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => {
      const { name: svcName, workspace, command, cwd, autoRestart } = args
      if (!svcName || !workspace || !command) return 'name, workspace, command are required'
      if (!workspace.startsWith('/')) return 'workspace must be an absolute path'
      const rec = {
        id: serviceId(workspace, svcName), name: svcName, workspace, command,
        cwd: cwd || workspace, env: {}, autoRestart: autoRestart === true, source: 'dynamic',
      }
      dynamic.set(rec.id, rec)
      persist()
      return `registered ${svcName} (id=${rec.id}). Start it with farm_start.`
    },
  })

  ctx.tools.register({
    name: 'farm_unregister',
    description: 'Delete one or more dsh-farm services from the registry. Running services are stopped first, and their log file is removed. Services declared in a farm.yaml are owned by that file and cannot be deleted this way.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service id or unique service name' },
        services: { type: 'array', items: { type: 'string' }, description: 'Several service ids or names, deleted in one go' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => {
      const wanted = [
        ...(args?.service ? [args.service] : []),
        ...(Array.isArray(args?.services) ? args.services : []),
      ].filter((x) => typeof x === 'string' && x.trim())
      if (!wanted.length) return 'pass service (one id or name) or services (an array of them)'
      const known = listServices()
      const lines = []
      for (const wantedName of [...new Set(wanted)]) {
        const svc = known.find((s) => s.id === wantedName || s.name === wantedName)
        if (!svc) { lines.push(`- ${wantedName}: unknown service`); continue }
        const r = await removeService(svc.id)
        lines.push(r.ok ? `- ${svc.name} (${svc.id}): deleted` : `- ${svc.name}: ${r.error}`)
      }
      return `farm_unregister:\n${lines.join('\n')}`
    },
  })

  ctx.logger?.info?.('[dsh-farm] supervisor ready (%d persisted services, data dir %s)', dynamic.size, dataDir)

  return () => {
    registerRoute()
    // Stop every child so nothing outlives the host process half-alive.
    for (const rec of dynamic.values()) {
      const rt = runtime.get(rec.id)
      if (rt?.child) { try { rt.child.kill('SIGKILL') } catch {} }
    }
  }
}
