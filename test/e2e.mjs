// End to end: real `dsh --profile headless` with this plugin installed, real `veil proxy`,
// and a scripted Anthropic-Messages model in place of DeepSeek. Checks that
//   1. the model never receives the real values (only pseudonyms),
//   2. dsh's `bash` tool runs with the real value (the alias policy restores it),
//   3. the developer sees the real value in dsh's output,
//   4. without veil, dsh sends no model request at all (fail closed),
//   5. an adapter pointed past veil is refused by the fetch guard.
//
// Needs `dsh` (npm i -g @deepseek-ai/dsh), `pnpm`, and `veil` (pip install veil-proxy) on PATH,
// or DSH_BIN / VEIL_BIN. Run: npm run build && npm run e2e

import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = process.env.DSH_BIN ?? 'dsh'
const VEIL = process.env.VEIL_BIN ?? 'veil'
const REAL_EMAIL = 'leonekohler@surfeu.de'
const REAL_NAME = 'Leonie Köhler'
const PSEUDO_EMAIL = /[A-Za-z0-9._%+-]+@example\.test/u

const root = mkdtempSync(join(tmpdir(), 'dsh-veil-e2e-'))
const ws = join(root, 'ws')
const env = {
  ...process.env,
  DSH_HOME: join(root, 'dsh-home'),
  VEIL_HOME: join(root, 'veil-home'),
  VEIL_VAULT_KEY: Buffer.alloc(32, 'v').toString('base64'),
  VEIL_TOKEN_SECRET: Buffer.alloc(32, 't').toString('base64'),
  DEEPSEEK_API_KEY: 'sk-e2e-not-a-key',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
}
delete env.DEEPSEEK_BASE_URL

// -- the scripted model ---------------------------------------------------------------

const received = []

function toolResultText(messages) {
  const last = messages.at(-1)
  if (last?.role !== 'user' || !Array.isArray(last.content)) return undefined
  const block = last.content.find(b => b.type === 'tool_result')
  if (!block) return undefined
  return typeof block.content === 'string' ? block.content
    : (block.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

function reply(body) {
  const transcript = JSON.stringify(body.messages ?? [])
  const pseudo = transcript.match(PSEUDO_EMAIL)?.[0]
  const result = toolResultText(body.messages ?? [])
  const hasBash = (body.tools ?? []).some(t => t.name === 'bash')
  if (result !== undefined) {
    return { text: `Customer ${pseudo} appears in customers.csv; grep output: ${result.trim()}` }
  }
  if (hasBash && pseudo) {
    return { tool: { name: 'bash', input: { command: `grep -c '${pseudo}' customers.csv`, description: 'Count the customer rows' } } }
  }
  return { text: 'ok' }
}

function sse(res, answer) {
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  send('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  if (answer.tool) {
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${received.length}`, name: answer.tool.name, input: {} } })
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.tool.input) } })
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer.text } })
  }
  send('content_block_stop', { index: 0 })
  send('message_delta', { delta: { stop_reason: answer.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  send('message_stop', {})
  res.end()
}

const model = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
    res.writeHead(404).end()
    return
  }
  received.push(raw)
  const body = JSON.parse(raw)
  const answer = reply(body)
  if (body.stream) return sse(res, answer)
  const content = answer.tool ? [{ type: 'tool_use', id: `toolu_${received.length}`, ...answer.tool }] : [{ type: 'text', text: answer.text }]
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'msg_e2e', type: 'message', role: 'assistant', model: 'deepseek-flash', content,
    stop_reason: answer.tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }))
})
model.listen(0, '127.0.0.1')
await once(model, 'listening')
const upstream = `http://127.0.0.1:${model.address().port}`

// -- workspace, seed, install -----------------------------------------------------------

execFileSync('mkdir', ['-p', ws])
writeFileSync(join(ws, 'customers.csv'), `id,name,email\n2,${REAL_NAME},${REAL_EMAIL}\n9,${REAL_NAME},${REAL_EMAIL}\n`)
const db = new DatabaseSync(join(root, 'app.db'))
db.exec('create table customers (id integer primary key, name text, email text)')
db.prepare('insert into customers values (?, ?, ?)').run(2, REAL_NAME, REAL_EMAIL)
db.close()
execFileSync(VEIL, ['seed', join(root, 'app.db'), '--no-remember'], { env, stdio: ['ignore', 'ignore', 'inherit'] })
execFileSync(DSH, ['plugin', '--profile', 'headless', 'add', REPO], { env, cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })

function overlay(name, yaml) {
  const file = join(root, `${name}.yml`)
  writeFileSync(file, yaml)
  return ['--patch', file]
}
const veilRow = extra => overlay('veil', `- id: veil\n  config:\n    command: ${JSON.stringify(VEIL)}\n    upstream: ${upstream}\n    logFile: ${JSON.stringify(join(root, 'veil.log'))}\n${extra}`)

async function runDsh(args, task, timeoutMs = 300_000) {
  const child = spawn(DSH, [...args, '--profile', 'headless', task], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const [code] = await once(child, 'exit')
  clearTimeout(timer)
  return { code, stdout, stderr }
}

const failures = []
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(`${what}${detail ? `\n${detail}` : ''}`)
}
const task = `Customer ${REAL_EMAIL} (${REAL_NAME}) says their account is missing. Check customers.csv.`

try {
  // 1-3: the normal path
  const run = await runDsh(veilRow(''), task)
  const all = received.join('\n')
  check(received.length >= 2, `the model was called (${received.length} requests)`, run.stderr.slice(-3000))
  check(!all.includes(REAL_EMAIL) && !all.includes(REAL_NAME) && !all.includes('Köhler'), 'the model never saw the real email or name')
  check(PSEUDO_EMAIL.test(all), 'the model saw a pseudonym instead')
  const results = received.map(r => toolResultText(JSON.parse(r).messages ?? [])).filter(r => r !== undefined)
  check(results.some(r => /(^|\D)2(\D|$)/u.test(r)), 'dsh bash ran grep with the real email (2 rows)', JSON.stringify(results))
  check(run.code === 0 && run.stdout.includes(REAL_EMAIL), 'the developer sees the real email', `exit ${run.code}\n${run.stdout}\n${run.stderr.slice(-2000)}`)

  // 4: veil missing -> no model request at all
  received.length = 0
  const missing = await runDsh(overlay('missing', `- id: veil\n  config:\n    command: /nonexistent/veil\n`), task, 120_000)
  check(received.length === 0, `without veil, no model request (${received.length} sent, exit ${missing.code})`, missing.stderr.slice(-2000))
  check(missing.code !== 0, 'without veil, dsh fails', missing.stdout)
  check(/veil not found|not found: install veil/u.test(missing.stdout + missing.stderr), 'the failure says veil is missing',
    (missing.stdout + missing.stderr).slice(-2000))

  // 5: an adapter pointed past veil -> refused
  received.length = 0
  const past = await runDsh([...veilRow(''), ...overlay('past', `- id: llm-deepseek\n  inject: [veil]\n  config:\n    baseURL: ${upstream}\n`)], task, 120_000)
  check(received.length === 0, `a baseURL past veil is refused (${received.length} sent)`, past.stderr.slice(-2000))
  check(/dsh-veil: refused a model request/u.test(past.stdout + past.stderr), 'the refusal names dsh-veil', (past.stdout + past.stderr).slice(-2000))
} finally {
  model.close()
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log('\nall checks passed')
