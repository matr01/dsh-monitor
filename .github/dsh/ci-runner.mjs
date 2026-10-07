import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { basename, join } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'monitor-ci-runner'
export const inject = ['agents', 'agentPresets', 'sessions']

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('CI runner requires appExit')
  void run(ctx).then(() => exit(0), error => {
    console.error(`dsh CI: ${error.stack ?? error}`)
    exit(1)
  })
}

async function run(ctx) {
  await ctx.loader.await()
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