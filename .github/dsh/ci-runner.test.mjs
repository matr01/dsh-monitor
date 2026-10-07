import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const source = (await readFile(new URL('./ci-runner.mjs', import.meta.url), 'utf8'))
  .replace("import { installModelSelection } from '@deepseek-ai/dsh-agent'", 'const installModelSelection = (ctx, value) => { ctx.selection = value }')
  .replace("import { createUserMessage } from '@deepseek-ai/dsh-llm'", 'const createUserMessage = value => value')
const { apply } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

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
        DSH_CI_PROVIDER: 'groq',
        DSH_CI_MODEL: 'qwen/qwen3.8-27b',
      })
      const completion = Promise.withResolvers()
      const compaction = { config: Object.freeze({ retainRatio: 0.16, auto: true, modelPolicies: [] }) }
      const events = []
      let listener
      let mounted
      const context = {
        get: () => completion.resolve,
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
            assert.equal(agentCtx.selection.current.provider, 'groq')
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
      const logs = await readdir(join(home, 'logs'))
      assert.equal(logs.length, 1)
      assert.equal(JSON.parse((await readFile(join(home, 'logs', logs[0]), 'utf8')).trim()).type, 'turn/end')
    } finally {
      process.env = environment
      await rm(home, { recursive: true, force: true })
    }
  })
}