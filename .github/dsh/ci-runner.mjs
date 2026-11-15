import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { finished } from 'node:stream/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'monitor-ci-runner'
export const inject = ['loader', 'agents', 'agentPresets', 'sessions']

const LLM_MAX_ATTEMPTS = 3
const LLM_RETRY_STATUSES = new Set([429, 503])
const LLM_BACKOFF_INITIAL_MS = 15000
const LLM_MAX_DELAY_MS = 120000
const LLM_JITTER_RATIO = 0.1

/**
 * Wrap fetch so OpenAI-compatible chat completion requests are counted and
 * 429/503 responses are retried. The pi-ai adapter drops Retry-After, so DSH
 * retryPolicy cannot honor it; the provider policies therefore must not retry
 * RATE_LIMIT, QUOTA, or SERVER again.
 */
export function createLlmFetch(baseFetch, { sleep = abortableSleep, random = Math.random, log = console.error } = {}) {
  const stats = { requests: 0, retries: 0 }
  const fetch = async (input, init) => {
    if (!isLlmRequest(input)) return baseFetch(input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    for (let attempt = 1; ; attempt++) {
      stats.requests++
      const response = await baseFetch(input instanceof Request ? input.clone() : input, init)
      if (!LLM_RETRY_STATUSES.has(response.status)) return response
      const body = await response.text()
      const delay = retryAfterMs(response.headers, body) ?? backoffMs(attempt, random)
      if (attempt >= LLM_MAX_ATTEMPTS || delay > LLM_MAX_DELAY_MS) {
        const headers = new Headers(response.headers)
        headers.delete('content-encoding')
        headers.delete('content-length')
        return new Response(body, { status: response.status, statusText: response.statusText, headers })
      }
      log(`dsh CI: LLM HTTP ${response.status}, attempt ${attempt}/${LLM_MAX_ATTEMPTS}, retrying in ${Math.ceil(delay / 1000)}s`)
      await sleep(delay, signal)
      stats.retries++
    }
  }
  return { fetch, stats }
}

function isLlmRequest(input) {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith('/chat/completions')
  } catch {
    return false
  }
}

function retryAfterMs(headers, body) {
  const milliseconds = Number.parseFloat(headers.get('retry-after-ms') ?? '')
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds
  const retryAfter = headers.get('retry-after')?.trim()
  if (retryAfter) {
    const delay = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(delay)) return Math.max(0, delay)
  }
  // Gemini reports the wait as google.rpc.RetryInfo in the error body instead of a header.
  const retryDelay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body)?.[1]
  return retryDelay === undefined ? undefined : Number(retryDelay) * 1000
}

function backoffMs(attempt, random) {
  const exponential = Math.min(LLM_BACKOFF_INITIAL_MS * 2 ** (attempt - 1), LLM_MAX_DELAY_MS)
  return exponential * (1 - LLM_JITTER_RATIO + 2 * LLM_JITTER_RATIO * random())
}

function abortableSleep(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function reportLlmRequests({ requests, retries }) {
  console.error(`dsh CI: LLM requests=${requests} (retries=${retries})`)
  try {
    const prompt = basename(process.env.DSH_CI_PROMPT_FILE ?? 'unknown')
    await appendFile(join(process.env.DSH_HOME, 'llm-requests.tsv'), `${prompt}\t${requests}\t${retries}\n`)
  } catch (error) {
    console.error(`dsh CI: cannot record LLM request count: ${error.message}`)
  }
}

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('CI runner requires appExit')
  const originalFetch = globalThis.fetch
  const llm = createLlmFetch(originalFetch)
  globalThis.fetch = llm.fetch
  const stop = async code => {
    if (globalThis.fetch === llm.fetch) globalThis.fetch = originalFetch
    await reportLlmRequests(llm.stats)
    exit(code)
  }
  let stopping = false
  const fail = async error => {
    if (stopping) return
    stopping = true
    clearTimeout(startupTimer)
    const diagnostic = `dsh CI: ${error.stack ?? error}`
    console.error(diagnostic)
    try {
      const logDirectory = join(process.env.DSH_HOME, 'logs')
      await mkdir(logDirectory, { recursive: true })
      await writeFile(join(logDirectory, `ci-startup-${randomUUID()}.log`), diagnostic, { mode: 0o600 })
    } catch (logError) {
      console.error(`dsh CI: cannot write diagnostic: ${logError.message}`)
    }
    await stop(1)
  }
  const startupTimer = setTimeout(() => {
    void fail(new Error('CI runner did not activate its preset within 120 seconds'))
  }, 120000)
  console.error('dsh CI: runner loaded; checking runtime imports and preset')
  void run(ctx, () => clearTimeout(startupTimer)).then(() => {
    if (stopping) return
    stopping = true
    clearTimeout(startupTimer)
    return stop(0)
  }, fail)
}

async function run(ctx, ready) {
  const entryPath = process.argv[1]
  if (!entryPath) throw new Error('Cannot locate the running DSH entry point')
  const runtimeRequire = createRequire(await realpath(entryPath))
  const importRuntime = packageName => import(pathToFileURL(runtimeRequire.resolve(packageName)).href)
  const { installModelSelection } = await importRuntime('@deepseek-ai/dsh-agent')
  const { createUserMessage } = await importRuntime('@deepseek-ai/dsh-llm')
  await ctx.loader.await()
  for (const service of ['agents', 'agentPresets', 'sessions']) {
    if (!ctx.get(service)) throw new Error(`CI runner requires active DSH service: ${service}`)
  }
  const presetId = process.env.DSH_AGENT_PRESET
  const promptFile = process.env.DSH_CI_PROMPT_FILE
  const provider = process.env.DSH_CI_PROVIDER
  const model = process.env.DSH_CI_MODEL
  if (!presetId || !promptFile || !provider || !model || !process.env.DSH_HOME) {
    throw new Error('Missing CI preset, prompt, model selection, or DSH_HOME')
  }
  const task = await readFile(promptFile, 'utf8')
  if (!task.trim()) throw new Error('Monitor prompt must not be empty')
  const preset = await ctx.agentPresets.resolve(presetId)
  if (preset.broken) throw new Error(`Preset ${presetId}: ${preset.broken}`)
  const sessionId = `monitor-${randomUUID()}`
  const logDirectory = join(process.env.DSH_HOME, 'logs')
  await mkdir(logDirectory, { recursive: true })
  const log = createWriteStream(join(logDirectory, `${basename(promptFile)}-${sessionId}.jsonl`), { mode: 0o600 })
  const logFinished = finished(log)
  void logFinished.catch(() => {})
  const unsubscribe = ctx.on('session/event', (session, event) => {
    if (session.id === sessionId) log.write(`${JSON.stringify(event)}\n`)
  })
  try {
    const selection = { provider, model }
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: presetId },
      agentOptions: selection,
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, presetId)
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
    if (ctx.agentPresets.composedPreset(agent.ctx) !== presetId) {
      throw new Error(`Preset ${presetId} was not activated`)
    }
    const compaction = ctx.agentPresets.serviceFor(agent, 'compaction')
    if (!compaction?.config) throw new Error('Preset compaction configuration is unavailable')
    const { retainRatio, ...compactionDefaults } = compaction.config
    compaction.config = Object.freeze({
      ...compactionDefaults,
      headroomTokens: 0,
      thresholdRatio: 0.25,
      retainTokens: 256,
      maxTokens: 256,
      modelPolicies: [],
    })
    console.error(`dsh CI: active preset=${presetId}, provider=${provider}, model=${model}`)
    ready()
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    const events = Array.from({ length: agent.session.seq }, (_, index) => agent.session.eventAt(index))
    const outcome = events.findLast(event => event?.type === 'turn/end')?.data.reason
    if (outcome?.kind !== 'completed') {
      throw new Error(`Monitor failed: ${JSON.stringify(outcome)}`)
    }
  } finally {
    unsubscribe()
    log.end()
    await logFinished
  }
}