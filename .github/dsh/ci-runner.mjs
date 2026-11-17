import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { finished } from 'node:stream/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'monitor-ci-runner'
export const inject = ['loader', 'agents', 'agentPresets', 'sessions']

const LLM_RETRY_STATUSES = new Set([429, 503])
const LLM_JITTER_RATIO = 0.1
const LLM_DEFAULT_RETRY = { maxAttempts: 3, backoffInitialMs: 15000, maxDelayMs: 120000 }
// Z.ai free models answer 429 code 1305 ("temporarily overloaded") even without
// concurrency, so its requests get more and longer-spaced attempts, and only one
// request (including its retries and streamed body) is in flight at a time.
const LLM_HOST_RETRY = new Map([
  ['api.z.ai', { maxAttempts: 6, backoffInitialMs: 30000, maxDelayMs: 180000, serialize: true }],
])

/**
 * Wrap fetch so LLM requests (OpenAI-compatible chat completions and native
 * Gemini generateContent) are counted and 429/503 responses are retried. The
 * pi-ai adapter drops Retry-After, so DSH
 * retryPolicy cannot honor it; the provider policies therefore must not retry
 * RATE_LIMIT, QUOTA, or SERVER again.
 */
export function createLlmFetch(baseFetch, { sleep = abortableSleep, random = Math.random, log = console.error } = {}) {
  const stats = { requests: 0, retries: 0 }
  const locks = new Map()
  const fetch = async (input, init) => {
    const url = llmRequestUrl(input)
    if (!url) return baseFetch(input, init)
    const policy = LLM_HOST_RETRY.get(url.hostname) ?? LLM_DEFAULT_RETRY
    let release
    if (policy.serialize) {
      if (!locks.has(url.hostname)) locks.set(url.hostname, createMutex())
      release = await locks.get(url.hostname)()
    }
    try {
      return releaseAfterBody(await fetchWithRetry(input, init, policy), release)
    } catch (error) {
      release?.()
      throw error
    }
  }
  const fetchWithRetry = async (input, init, policy) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    for (let attempt = 1; ; attempt++) {
      stats.requests++
      const response = await baseFetch(input instanceof Request ? input.clone() : input, init)
      if (!LLM_RETRY_STATUSES.has(response.status)) return response
      const body = await response.text()
      const delay = retryAfterMs(response.headers, body) ?? backoffMs(attempt, policy, random)
      if (attempt >= policy.maxAttempts || delay > policy.maxDelayMs) {
        const headers = new Headers(response.headers)
        headers.delete('content-encoding')
        headers.delete('content-length')
        return new Response(body, { status: response.status, statusText: response.statusText, headers })
      }
      log(`dsh CI: LLM HTTP ${response.status}, attempt ${attempt}/${policy.maxAttempts}, retrying in ${Math.ceil(delay / 1000)}s`)
      await sleep(delay, signal)
      stats.retries++
    }
  }
  return { fetch, stats }
}

function createMutex() {
  let tail = Promise.resolve()
  return async () => {
    const previous = tail
    let unlock
    tail = new Promise(resolve => { unlock = resolve })
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      unlock()
    }
  }
}

// Keeps the lock until the (possibly streamed) body is fully read, fails, or is cancelled.
function releaseAfterBody(response, release) {
  if (!release) return response
  if (!response.body) {
    release()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

function llmRequestUrl(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const { pathname } = url
    return pathname.endsWith('/chat/completions') || /:(?:stream)?[Gg]enerateContent$/.test(pathname) ? url : undefined
  } catch {
    return undefined
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

function backoffMs(attempt, { backoffInitialMs, maxDelayMs }, random) {
  const exponential = Math.min(backoffInitialMs * 2 ** (attempt - 1), maxDelayMs)
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