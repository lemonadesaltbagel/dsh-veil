/**
 * dsh-veil: run DeepSeek Harness model traffic through veil, a local privacy proxy.
 *
 * The plugin starts `veil proxy` (or attaches to a running one) and provides the `veil`
 * service once the proxy answers. This bundle's patch makes the DeepSeek adapters inject
 * that service and take their `baseURL` from it, so no model request can be sent before
 * veil is up. A fetch guard refuses model requests to any other origin, which covers a
 * profile or settings layer that points an adapter elsewhere.
 * @module dsh-veil
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'dsh-veil'

/**
 * dsh tools that take Claude Code's argument names, mapped onto veil's roles. Every other
 * dsh tool (run_code, workflow, pwsh, subagent, web_*, terminals) is left unmapped, so it
 * only ever receives pseudonyms.
 */
export const DSH_TOOL_ALIASES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  edit: 'Edit',
  write: 'Write',
  working_directory: 'Read', // {cd: path}: a locator, like Read's file_path
}

export const DEFAULT_UPSTREAM = 'https://api.deepseek.com/anthropic'

export interface Config {
  /** veil executable; default `veil` on PATH (`pip install veil-proxy` or `brew install lemonadesaltbagel/veil/veil`). */
  command?: string
  /** URL of a running `veil proxy` to use instead of starting one. */
  url?: string
  /** Where veil forwards model requests; default `$DEEPSEEK_BASE_URL`, then the official API. */
  upstream?: string
  /** Extra `veil proxy` arguments. */
  args?: string[]
  /** Replaces {@link DSH_TOOL_ALIASES}. */
  toolAliases?: Record<string, string>
  /** veil's log; default `veil.log` in the system temp directory. */
  logFile?: string
  /** How long to wait for the proxy to answer; default 60 s (a large seed takes a while to load). */
  startTimeoutMs?: number
  /** Refuse model requests to any origin but veil's; default true. */
  guardFetch?: boolean
}

/** What `/veil/health` reports; counts only, never values. */
export interface VeilHealth {
  ok: boolean
  upstream: string
  known_values: number
  tokens: number
  display: string
  sources: number
  ner: boolean
}

/** The `veil` service: the proxy this process sends model requests through. */
export interface VeilService {
  /** Messages root for the DeepSeek adapter's `baseURL`. */
  baseURL: string
  upstream: string
  /** Process id when this plugin started the proxy. */
  pid?: number
  logFile?: string
  health(): Promise<VeilHealth>
}

/** The parts of Cordis's Context this plugin uses. */
interface Ctx {
  effect(fn: () => Promise<() => unknown>): Promise<unknown>
  provide(name: string, value: unknown): () => unknown
  plugin(plugin: unknown, config?: unknown): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
  veil: VeilService
  commands: { register(command: unknown): unknown }
}

const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis)

async function getHealth(baseURL: string, timeoutMs = 2_000): Promise<VeilHealth> {
  const res = await nativeFetch(new URL('/veil/health', baseURL), { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`veil health check answered HTTP ${res.status}`)
  const body = await res.json() as VeilHealth
  if (body?.ok !== true) throw new Error('not a veil proxy')
  return body
}

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return port
}

/** `--tool-alias` arguments for `veil proxy`. */
export function aliasArgs(aliases: Readonly<Record<string, string>>): string[] {
  return Object.entries(aliases).flatMap(([tool, role]) => ['--tool-alias', `${tool}=${role}`])
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/**
 * NO_PROXY for veil: loopback added, brackets dropped. dsh adds `[::1]`, which httpx (veil's
 * HTTP client) cannot parse, so veil would exit at startup.
 */
export function noProxyFor(value: string | undefined): string {
  const hosts = (value ?? '').split(',').map(h => h.trim().replace(/^\[(.*)\]$/u, '$1')).filter(Boolean)
  return [...new Set([...hosts, '127.0.0.1', 'localhost'])].join(',')
}

interface Proxy {
  service: VeilService
  stop(): Promise<void>
}

async function attach(url: string): Promise<Proxy> {
  const baseURL = url.replace(/\/+$/u, '')
  const health = await getHealth(baseURL)
  return {
    service: { baseURL, upstream: health.upstream, health: () => getHealth(baseURL) },
    stop: async () => {},
  }
}

async function start(config: Config): Promise<Proxy> {
  const command = config.command ?? 'veil'
  const upstream = config.upstream ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_UPSTREAM
  const logFile = config.logFile ?? join(tmpdir(), 'dsh-veil', `veil-${process.pid}.log`)
  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`
  const args = ['proxy', '--port', String(port), '--upstream', upstream,
    ...aliasArgs(config.toolAliases ?? DSH_TOOL_ALIASES), ...(config.args ?? [])]
  mkdirSync(dirname(logFile), { recursive: true })
  const fd = openSync(logFile, 'a')
  let child: ChildProcess
  try {
    const noProxy = noProxyFor(process.env.NO_PROXY ?? process.env.no_proxy)
    child = spawn(command, args, { stdio: ['ignore', fd, fd], env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy } })
  } finally {
    closeSync(fd)
  }
  let exited: string | undefined
  const exit = new Promise<void>(resolve => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      exited = error.code === 'ENOENT'
        ? `${command} not found: install veil (pip install veil-proxy, or brew install lemonadesaltbagel/veil/veil) or set the plugin's \`command\``
        : `${command} failed to start: ${error.message}`
      resolve()
    })
    child.once('exit', (code, signal) => {
      exited ??= `veil exited (${signal ?? `code ${code}`})`
      resolve()
    })
  })
  const killOnExit = () => child.kill('SIGTERM')
  process.once('exit', killOnExit)
  const stop = async () => {
    process.removeListener('exit', killOnExit)
    if (exited !== undefined) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
    await exit
    clearTimeout(timer)
  }

  const deadline = Date.now() + (config.startTimeoutMs ?? 60_000)
  for (;;) {
    if (exited !== undefined) {
      await stop()
      const log = tail(logFile)
      throw new Error(`dsh-veil: ${exited}${log ? `\n${log}` : ''}`)
    }
    try {
      await getHealth(baseURL, 1_000)
      break
    } catch {
      if (Date.now() > deadline) {
        await stop()
        throw new Error(`dsh-veil: veil did not answer on ${baseURL} within ${config.startTimeoutMs ?? 60_000} ms; see ${logFile}`)
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  return {
    service: { baseURL, upstream, pid: child.pid, logFile, health: () => getHealth(baseURL) },
    stop,
  }
}

const MODEL_PATH = /(?:\/messages|\/chat\/completions|\/responses|:(?:streamGenerateContent|generateContent))$/u

/** Whether a request is a model call that does not go to `origin`. */
export function bypassesVeil(input: string | URL | Request, init: RequestInit | undefined, origin: string): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return method === 'POST' && MODEL_PATH.test(url.pathname.replace(/\/+$/u, '')) && url.origin !== origin
}

/**
 * Refuse model requests to any origin but `origin` until the returned disposer runs.
 * @param onRefuse - also told each refusal (dsh reports a failed fetch without its cause).
 * @returns a disposer that restores the previous `fetch`.
 */
export function guardFetch(origin: string, onRefuse: (message: string) => void = () => {}): () => void {
  const previous = globalThis.fetch
  const guarded: typeof fetch = (input, init) => {
    if (bypassesVeil(input, init, origin)) {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const message = `dsh-veil: refused a model request to ${url.origin}, which is not veil (${origin}). `
        + 'A profile or settings layer points a model route past veil; remove that baseURL, or remove dsh-veil.'
      onRefuse(message)
      return Promise.reject(new Error(message))
    }
    return previous(input, init)
  }
  globalThis.fetch = guarded
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = previous
  }
}

/** One line per fact for `/veil`. */
export function describe(service: VeilService, health: VeilHealth): string {
  return [
    `veil is on: model requests go through ${service.baseURL} to ${health.upstream}`,
    `${health.known_values} seeded values, ${health.tokens} pseudonyms, display ${health.display}`
      + `${health.sources ? `, ${health.sources} source(s) re-seeded` : ''}${health.ner ? ', NER on' : ''}`,
    ...(service.pid ? [`proxy pid ${service.pid}, log ${service.logFile}`] : []),
  ].join('\n')
}

const command = {
  name: 'dsh-veil/command',
  inject: ['commands', 'veil'],
  apply(ctx: Ctx) {
    ctx.commands.register({
      definitionId: 'dsh-veil/status',
      name: 'veil',
      description: 'Show the veil privacy proxy this session sends model requests through',
      recordInput: false,
      handler: async () => {
        try {
          return { kind: 'success', text: describe(ctx.veil, await ctx.veil.health()) }
        } catch (error) {
          return { kind: 'error', text: `veil is not answering on ${ctx.veil.baseURL}: ${String(error)}` }
        }
      },
    })
  },
}

export async function apply(ctx: Ctx, config: Config | undefined): Promise<void> {
  const cfg = config ?? {}
  await ctx.effect(async () => {
    const proxy = cfg.url ? await attach(cfg.url) : await start(cfg)
    const disposers: Array<() => unknown> = [() => proxy.stop()]
    try {
      if (cfg.guardFetch !== false) {
        const told = new Set<string>()  // once per message: the adapter retries
        disposers.push(guardFetch(new URL(proxy.service.baseURL).origin, message => {
          if (!told.has(message)) process.stderr.write(`${message}\n`)
          told.add(message)
        }))
      }
      disposers.push(ctx.provide('veil', proxy.service))
    } catch (error) {
      for (const dispose of disposers.reverse()) await dispose()
      throw error
    }
    ctx.logger.info(`model requests go through veil at ${proxy.service.baseURL} -> ${proxy.service.upstream}`)
    return async () => {
      for (const dispose of disposers.reverse()) await dispose()
    }
  })
  ctx.plugin(command)
}
