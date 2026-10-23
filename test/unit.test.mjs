import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'

import { aliasArgs, bypassesVeil, describe, DSH_TOOL_ALIASES, guardFetch, noProxyFor } from '../lib/index.js'

const VEIL = 'http://127.0.0.1:8787'

test('dsh tools map onto veil roles; nothing else is aliased', () => {
  assert.deepEqual(aliasArgs(DSH_TOOL_ALIASES).filter((_, i) => i % 2 === 1),
    ['bash=Bash', 'read=Read', 'grep=Grep', 'glob=Glob', 'edit=Edit', 'write=Write', 'working_directory=Read'])
  for (const tool of ['run_code', 'workflow', 'pwsh', 'subagent', 'web_fetch', 'terminal_send']) {
    assert.equal(DSH_TOOL_ALIASES[tool], undefined)
  }
})

test('model calls that do not go to veil are bypasses', () => {
  const post = { method: 'POST' }
  assert.equal(bypassesVeil('https://api.deepseek.com/anthropic/v1/messages', post, VEIL), true)
  assert.equal(bypassesVeil('https://api.openai.com/v1/chat/completions', post, VEIL), true)
  assert.equal(bypassesVeil('https://api.openai.com/v1/responses/', post, VEIL), true)
  assert.equal(bypassesVeil('https://x.googleapis.com/v1/models/g:streamGenerateContent', post, VEIL), true)
  assert.equal(bypassesVeil(new Request('https://api.deepseek.com/anthropic/v1/messages', post), undefined, VEIL), true)
  assert.equal(bypassesVeil(`${VEIL}/v1/messages`, post, VEIL), false)
  assert.equal(bypassesVeil('https://api.deepseek.com/models', undefined, VEIL), false)   // listing, not a model call
  assert.equal(bypassesVeil('https://example.org/messages', { method: 'GET' }, VEIL), false)
})

test('the guard refuses bypasses, passes veil through, and restores fetch', async () => {
  const server = createServer((_, res) => res.end('ok'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const original = globalThis.fetch
  const refused = []
  const dispose = guardFetch(origin, m => refused.push(m))
  try {
    assert.equal(await (await fetch(`${origin}/v1/messages`, { method: 'POST', body: '{}' })).text(), 'ok')
    await assert.rejects(fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', body: '{}' }),
      /dsh-veil: refused a model request to https:\/\/api\.deepseek\.com/)
    assert.equal(refused.length, 1)
  } finally {
    dispose()
    server.close()
  }
  assert.equal(globalThis.fetch, original)
})

test('status text carries counts, never values', () => {
  const text = describe({ baseURL: VEIL, upstream: 'u', pid: 7, logFile: '/tmp/v.log', health: async () => ({}) },
    { ok: true, upstream: 'https://api.deepseek.com/anthropic', known_values: 12, tokens: 3, display: 'real', sources: 1, ner: false })
  assert.match(text, /through http:\/\/127\.0\.0\.1:8787 to https:\/\/api\.deepseek\.com\/anthropic/)
  assert.match(text, /12 seeded values, 3 pseudonyms, display real, 1 source\(s\) re-seeded/)
})

test('NO_PROXY for veil has loopback and no bracketed hosts', () => {
  assert.equal(noProxyFor('127.0.0.1,localhost,::1,[::1],corp.example'), '127.0.0.1,localhost,::1,corp.example')
  assert.equal(noProxyFor(undefined), '127.0.0.1,localhost')
})
