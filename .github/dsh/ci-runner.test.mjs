import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const source = (await readFile(new URL('./ci-runner.mjs', import.meta.url), 'utf8'))
  .replace("const { installModelSelection } = await importRuntime('@deepseek-ai/dsh-agent')", 'const installModelSelection = (ctx, value) => { ctx.selection = value }')
  .replace("const { createUserMessage } = await importRuntime('@deepseek-ai/dsh-llm')", 'const createUserMessage = value => value')
const { apply, createLlmFetch } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

for (const successful of [true, false]) {
  test(`CI runner mounts preset and exits ${successful ? 0 : 1}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ci-test-'))
    const environment = { ...process.env }
    try {
      const promptFile = join(home, 'prompt.md')
      await writeFile(promptFile, 'Produce the monitor report')
      Object.assign(process.env, {
        DSH_HOME: home,
        DSH_AGENT_PRESET: 'ptc-minimal',
        DSH_CI_PROMPT_FILE: promptFile,
        DSH_CI_PROVIDER: 'gemini',
        DSH_CI_MODEL: 'gemini-3.8-flash',
      })
      const completion = Promise.withResolvers()
      const compaction = { config: Object.freeze({ retainRatio: 0.16, auto: true, modelPolicies: [] }) }
      const events = []
      let listener
      let mounted
      const context = {
        get: service => service === 'appExit' ? completion.resolve : context[service],
        loader: { await: async () => {} },
        on: (_type, callback) => { listener = callback; return () => { listener = undefined } },
        sessions: { flush: async () => {} },
        agentPresets: {
          resolve: async presetId => ({ id: presetId }),
          mount: async (_ctx, presetId) => { mounted = presetId },
          composedPreset: () => mounted,
          serviceFor: () => compaction,
        },
        agents: {
          create: async options => {
            const agentCtx = {}
            await options.setup(agentCtx)
            assert.equal(mounted, 'ptc-minimal')
            assert.equal(agentCtx.selection.current.provider, 'gemini')
            const session = { id: options.sessionId, get seq() { return events.length }, eventAt: index => events[index] }
            return { agent: {
              ctx: agentCtx, session, whenIdle: async () => {},
              followup: message => {
                assert.equal(message.content[0].text, 'Produce the monitor report')
                const event = { type: 'turn/end', data: { reason: { kind: successful ? 'completed' : 'error' } } }
                events.push(event)
                listener(session, event)
              },
            } }
          },
        },
      }
      apply(context)
      assert.equal(await completion.promise, successful ? 0 : 1)
      assert.equal(compaction.config.headroomTokens, 0)
      assert.equal(compaction.config.thresholdRatio, 0.25)
      assert.equal(compaction.config.maxTokens, 256)
      assert.equal(compaction.config.retainRatio, undefined)
      const logs = (await readdir(join(home, 'logs'))).filter(file => file.endsWith('.jsonl'))
      assert.equal(logs.length, 1)
      assert.equal(JSON.parse((await readFile(join(home, 'logs', logs[0]), 'utf8')).trim()).type, 'turn/end')
      assert.equal(await readFile(join(home, 'llm-requests.tsv'), 'utf8'), 'prompt.md\t0\t0\n')
    } finally {
      process.env = environment
      await rm(home, { recursive: true, force: true })
    }
  })
}

test('Runtime import failure exits and writes a diagnostic without creating an agent', async context => {
  context.mock.method(console, 'error', () => {})
  const home = await mkdtemp(join(tmpdir(), 'dsh-ci-import-test-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const failingSource = source.replace(
      'const installModelSelection = (ctx, value) => { ctx.selection = value }',
      "const { installModelSelection } = await import('node:dsh-ci-missing-module')",
    )
    const runner = await import(`data:text/javascript;base64,${Buffer.from(failingSource).toString('base64')}`)
    const completion = Promise.withResolvers()
    runner.apply({ get: () => completion.resolve })
    assert.equal(await completion.promise, 1)
    const logs = await readdir(join(home, 'logs'))
    assert.equal(logs.length, 1)
    assert.match(await readFile(join(home, 'logs', logs[0]), 'utf8'), /dsh-ci-missing-module/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('Startup deadline terminates an unsettled DSH loader', async context => {
  context.mock.method(console, 'error', () => {})
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const home = await mkdtemp(join(tmpdir(), 'dsh-ci-timeout-test-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const completion = Promise.withResolvers()
    apply({
      get: () => completion.resolve,
      loader: { await: () => new Promise(() => {}) },
    })
    context.mock.timers.tick(120000)
    assert.equal(await completion.promise, 1)
    const logs = await readdir(join(home, 'logs'))
    assert.match(await readFile(join(home, 'logs', logs[0]), 'utf8'), /within 120 seconds/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

const completionsUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'

function scriptedFetch(responses) {
  return async () => responses.shift()()
}

test('LLM fetch honors Retry-After and Gemini retryDelay, counting only LLM requests', async () => {
  const delays = []
  const upstream = scriptedFetch([
    () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
    () => new Response(JSON.stringify([{ error: { details: [{ retryDelay: '37s' }] } }]), { status: 429 }),
    () => new Response('ok'),
    () => new Response('page'),
  ])
  const llm = createLlmFetch(upstream, { sleep: async delay => { delays.push(delay) }, log: () => {} })
  const response = await llm.fetch(geminiUrl, { method: 'POST', body: '{}' })
  assert.equal(await response.text(), 'ok')
  assert.equal(await (await llm.fetch('https://example.com/news')).text(), 'page')
  assert.deepEqual(delays, [7000, 37000])
  assert.deepEqual(llm.stats, { requests: 3, retries: 2 })
})

test('LLM fetch backs off exponentially and returns the last 503 after three attempts', async () => {
  const delays = []
  const upstream = scriptedFetch(Array.from({ length: 3 }, () => () => new Response('overloaded', { status: 503 })))
  const llm = createLlmFetch(upstream, { sleep: async delay => { delays.push(delay) }, random: () => 0.5, log: () => {} })
  const response = await llm.fetch(completionsUrl, { method: 'POST', body: '{}' })
  assert.equal(response.status, 503)
  assert.equal(await response.text(), 'overloaded')
  assert.deepEqual(delays, [15000, 30000])
  assert.deepEqual(llm.stats, { requests: 3, retries: 2 })
})

test('LLM fetch does not wait for a Retry-After beyond its limit', async () => {
  const upstream = scriptedFetch([() => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } })])
  const llm = createLlmFetch(upstream, { sleep: async () => assert.fail('must not sleep'), log: () => {} })
  assert.equal((await llm.fetch(completionsUrl, { method: 'POST', body: '{}' })).status, 429)
  assert.deepEqual(llm.stats, { requests: 1, retries: 0 })
})