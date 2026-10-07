import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { basename, join } from 'node:path'

export const name = 'monitor-ci-runner'
export const inject = []

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('CI runner requires appExit')
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
    exit(1)
  }
  const startupTimer = setTimeout(() => {
    void fail(new Error('CI runner did not activate its preset within 120 seconds'))
  }, 120000)
  console.error('dsh CI: runner loaded; checking runtime imports and preset')
  void run(ctx, () => clearTimeout(startupTimer)).then(() => {
    if (stopping) return
    stopping = true
    clearTimeout(startupTimer)
    exit(0)
  }, fail)
}

async function run(ctx, ready) {
  const { installModelSelection } = await import('@deepseek-ai/dsh-agent')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
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