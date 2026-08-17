/**
 * Smoke-test one llm-pi-ai provider channel exactly the way the running
 * harness will call it, and optionally cold-add it to the settings document
 * on a pass.
 *
 * The two checks go through the real production path (PiAiAdapter ->
 * pi-ai -> gateway): a plain completion, and a tool round trip that forces
 * the model to call tools and consumes the results across turns. Gateways
 * that refuse non-official clients fail the completion check with their 403,
 * gateways whose Responses implementation breaks on `function_call_output`
 * history replay fail the tool check — the two failure modes a hand-declared
 * channel hides until a live request.
 *
 * Usage:
 *   pnpm exec tsx scripts/smoke-provider-channel.ts \
 *     --provider zzzcoding --api openai-responses \
 *     --base-url https://gateway.example/v1 \
 *     --api-key-env ZZZCODING_API_KEY --api-key sk-... \
 *     --headers '{"originator":"codex_exec","session-id":"smoke","thread-id":"smoke"}' \
 *     --models '{"gpt-5.6-sol":{"name":"GPT-5.6 Sol","contextWindow":262144}}' \
 *     [--add]
 *
 * `--add` writes the provider block into `$DSH_HOME/settings.yaml` (and the
 * credential into `$DSH_HOME/.credentials.yaml`) only after every check
 * passes; the settings document hot-reloads, so the channel is live without
 * a server restart. Without `--add` the script only reports, exiting 0 on
 * pass, 1 on failure, 2 on usage errors.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../packages/llm/llm-pi-ai/src/adapter.ts'
import { assertServiceable, Config, resolveProfiles } from '../packages/llm/llm-pi-ai/src/config.ts'
import type { PiAiProviderProfile } from '../packages/llm/llm-pi-ai/src/config.ts'

const USAGE = 'usage: pnpm exec tsx scripts/smoke-provider-channel.ts'
  + ' --provider <route> --api <protocol> --base-url <url> --api-key <key>'
  + ' --headers <json> --models <json> [--api-key-env <name>] [--display-name <name>]'
  + ' [--model <id>] [--add]'

interface ModelSpec {
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: Record<string, string | null>
}

const TOOLS: ToolSchema[] = [
  {
    name: 'get_current_weather',
    description: 'Get current weather temperature for a city',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['city'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a numeric arithmetic expression',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
]

const TOOL_TASK = '北京现在多少度（摄氏度）？用 get_current_weather 工具查，然后用 calculate 工具把温度乘以 2，最后告诉我结果。'

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

function fail(message: string): never {
  console.error(`smoke-provider-channel: ${message}`)
  console.error(USAGE)
  process.exit(2)
}

function parseJsonArg(value: string, what: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    fail(`--${what} is not valid JSON`)
  }
}

function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Render one model entry's extra fields at the given indent. */
function renderModelFields(spec: ModelSpec, indent: string): string {
  const lines: string[] = []
  if (spec.name !== undefined) lines.push(`${indent}name: ${yamlScalar(spec.name)}`)
  if (spec.contextWindow !== undefined) lines.push(`${indent}contextWindow: ${spec.contextWindow}`)
  if (spec.maxTokens !== undefined) lines.push(`${indent}maxTokens: ${spec.maxTokens}`)
  if (spec.reasoningEfforts !== undefined) {
    lines.push(`${indent}reasoningEfforts:`)
    for (const [level, spelling] of Object.entries(spec.reasoningEfforts)) {
      lines.push(spelling === null
        ? `${indent}  ${level}:`
        : `${indent}  ${level}: ${yamlScalar(spelling)}`)
    }
  }
  return lines.join('\n')
}

/** Render the provider block, indented for the `providers:` dict (4 spaces). */
function renderProviderBlock(provider: string, profile: PiAiProviderProfile, models: Record<string, ModelSpec>): string {
  const lines: string[] = [`    ${provider}:`]
  if (profile.displayName !== undefined) lines.push(`      displayName: ${yamlScalar(profile.displayName)}`)
  if (profile.apiKeyEnv !== undefined) lines.push(`      apiKeyEnv: ${yamlScalar(profile.apiKeyEnv)}`)
  if (profile.api !== undefined) lines.push(`      api: ${yamlScalar(profile.api)}`)
  if (profile.baseURL !== undefined) lines.push(`      baseURL: ${yamlScalar(profile.baseURL)}`)
  if (profile.headers !== undefined && Object.keys(profile.headers).length > 0) {
    lines.push('      headers:')
    for (const [name, value] of Object.entries(profile.headers)) {
      lines.push(`        ${name}: ${yamlScalar(value)}`)
    }
  }
  lines.push('      models:')
  for (const [id, spec] of Object.entries(models)) {
    lines.push(`        - id: ${yamlScalar(id)}`)
    const fields = renderModelFields(spec, '          ')
    if (fields.length > 0) lines.push(fields)
  }
  return lines.join('\n')
}

function addToSettings(home: string, provider: string, block: string, fullSection: boolean): void {
  const path = resolve(home, 'settings.yaml')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  let next: string
  if (text.includes('llm-pi-ai:')) {
    const anchor = /^agent-default-model:/m
    const match = anchor.exec(text)
    if (match === null) {
      console.error('smoke-provider-channel: settings.yaml has no `agent-default-model:` anchor;'
        + ` add the ${provider} block under llm-pi-ai.providers manually`)
      process.exit(1)
    }
    const insertAt = match.index
    next = `${text.slice(0, insertAt)}${block}\n${text.slice(insertAt)}`
  } else if (fullSection) {
    next = `${text}${text.trim().length > 0 ? '\n' : ''}llm-pi-ai:\n  providers:\n${block}\n`
  } else {
    fail('settings.yaml has no llm-pi-ai section; re-run with a --api-key-env so the section can be created')
  }
  writeFileSync(path, next)
  console.log(`smoke-provider-channel: wrote ${provider} into ${path} (hot-reloads, no restart)`)
}

function addCredential(home: string, envName: string, key: string): void {
  const path = resolve(home, '.credentials.yaml')
  mkdirSync(dirname(path), { recursive: true })
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const prefix = `${envName}:`
  if (text.split('\n').some(line => line.startsWith(prefix))) {
    console.log(`smoke-provider-channel: credential ${envName} already present in ${path}`)
    return
  }
  writeFileSync(path, `${text}${text.trim().length > 0 ? '\n' : ''}${prefix} ${key}\n`)
  console.log(`smoke-provider-channel: wrote ${envName} into ${path}`)
}

async function runChecks(
  adapter: PiAiAdapter,
  provider: string,
  model: string,
  apiKey: string,
  timeoutMs: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  const failureDetail = (reason: { kind: string; failure?: { code: string; status?: number; message: string } }): string => {
    const base = `${reason.failure?.code}${reason.failure?.status !== undefined ? ` (${reason.failure.status})` : ''}: ${reason.failure?.message ?? ''}`
    return /codex/i.test(reason.failure?.message ?? '')
      ? `${base} — hint: Codex-locked gateway; include the official-client header set (originator, x-codex-*, session-id, thread-id)`
      : base
  }

  try {
    const timeout = AbortSignal.timeout(timeoutMs)
    const collected = { text: '', finish: '', failure: '' }
    for await (const chunk of adapter.stream({
      provider,
      model,
      system: 'Reply with exactly: smoke-ok',
      messages: [],
      maxTokens: 100,
      signal: timeout,
    })) {
      if (chunk.type === 'text-delta') collected.text += chunk.text
      else if (chunk.type === 'finish') {
        collected.finish = chunk.reason.kind
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          collected.failure = failureDetail(chunk.reason)
        }
      }
    }
    results.push({
      name: 'completion',
      ok: collected.finish === 'stop' && collected.text.length > 0,
      detail: collected.finish === 'stop'
        ? `finish=${collected.finish} text=${JSON.stringify(collected.text.slice(0, 60))}`
        : collected.failure || `finish=${collected.finish} text=${JSON.stringify(collected.text.slice(0, 60))}`,
    })
  } catch (error) {
    results.push({ name: 'completion', ok: false, detail: String(error).slice(0, 200) })
  }

  let toolOk = false
  let toolDetail = 'not attempted'
  try {
    const timeout = AbortSignal.timeout(timeoutMs)
    const user = createUserMessage({ content: [{ type: 'text', text: TOOL_TASK }], source: { kind: 'plugin', plugin: 'smoke' } })
    let history: unknown[] = [user]
    let rounds = 0
    for (;;) {
      rounds += 1
      const calls: ToolCallBlock[] = []
      let text = ''
      let finish = ''
      let failure = ''
      for await (const chunk of adapter.stream({
        provider,
        model,
        messages: history as never,
        tools: TOOLS,
        maxTokens: 500,
        signal: timeout,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') calls.push(chunk.block)
        else if (chunk.type === 'finish') {
          finish = chunk.reason.kind
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failure = failureDetail(chunk.reason)
          }
        }
      }
      if (failure !== '') {
        toolDetail = `round ${rounds}: ${failure}`
        break
      }
      if (calls.length === 0) {
        toolOk = finish === 'stop' && text.length > 0
        toolDetail = `no tool call in round ${rounds}; finish=${finish} text=${JSON.stringify(text.slice(0, 60))}`
        break
      }
      const assistant = createAssistantMessage({
        content: calls.map(call => ({ type: 'tool-call' as const, id: call.id, name: call.name, arguments: call.arguments })),
        source: { provider, model },
      })
      const resultsOut = calls.map(call => createToolResultMessage({
        callId: call.id,
        content: [{
          type: 'text',
          text: JSON.stringify(call.name === 'get_current_weather'
            ? { city: 'beijing', temp: 11, unit: 'celsius' }
            : { result: 22 }),
        }],
        isError: false,
      }))
      history = [...history, assistant, ...resultsOut]
      if (rounds >= 6) {
        toolDetail = `still calling tools after ${rounds} rounds`
        break
      }
    }
    toolDetail = `${rounds} round(s), ${toolDetail}`
    results.push({ name: 'tool round trip', ok: toolOk, detail: toolDetail })
  } catch (error) {
    results.push({ name: 'tool round trip', ok: false, detail: String(error).slice(0, 200) })
  }
  void apiKey
  return results
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: 'string' },
      api: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      'api-key-env': { type: 'string' },
      'display-name': { type: 'string' },
      headers: { type: 'string' },
      models: { type: 'string' },
      model: { type: 'string' },
      add: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '300000' },
    },
  })
  if (values.provider === undefined || values.api === undefined || values['base-url'] === undefined
    || values['api-key'] === undefined || values.models === undefined) {
    fail('missing required options')
  }
  const provider = values.provider
  const apiKey = values['api-key']
  const rawModels = parseJsonArg(values.models, 'models')
  if (typeof rawModels !== 'object' || rawModels === null || Array.isArray(rawModels)
    || Object.keys(rawModels).length === 0) {
    fail('--models must be a non-empty object keyed by model id')
  }
  const models = rawModels as Record<string, ModelSpec>
  const model = values.model ?? Object.keys(models)[0]
  if (model === undefined || !(model in models)) {
    fail(`--model ${model ?? '(first declared)'} is not declared in --models`)
  }
  const timeoutMs = Number(values.timeout)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('--timeout must be a positive number of milliseconds')

  const profile: PiAiProviderProfile = {
    ...values['display-name'] === undefined ? {} : { displayName: values['display-name'] },
    ...values['api-key-env'] === undefined ? {} : { apiKeyEnv: values['api-key-env'] },
    api: values.api,
    baseURL: values['base-url'],
    ...values.headers === undefined ? {} : { headers: parseJsonArg(values.headers, 'headers') as Record<string, string> },
    models: Object.entries(models).map(([id, spec]) => ({
      id,
      ...spec.name === undefined ? {} : { name: spec.name },
      ...spec.contextWindow === undefined ? {} : { contextWindow: spec.contextWindow },
      ...spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens },
      ...spec.reasoningEfforts === undefined ? {} : { reasoningEfforts: spec.reasoningEfforts as never },
    })),
  }
  const config = Config({ providers: { [provider]: profile } })
  assertServiceable(config)
  const profiles = resolveProfiles(config.providers)
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve(apiKey),
  })

  console.log(`smoke-provider-channel: ${provider} -> ${values.api} ${values['base-url']} (model ${model})`)
  const results = await runChecks(adapter, provider, model, apiKey, timeoutMs)
  for (const result of results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}`)
  }
  if (results.some(result => !result.ok)) {
    console.error('smoke-provider-channel: checks failed; nothing was added')
    process.exit(1)
  }

  console.log('smoke-provider-channel: all checks passed')
  if (!values.add) return
  const home = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  const block = renderProviderBlock(provider, profile, models)
  addToSettings(home, provider, block, values['api-key-env'] !== undefined)
  if (values['api-key-env'] !== undefined) addCredential(home, values['api-key-env'], apiKey)
  console.log('smoke-provider-channel: channel cold-added; the running harness hot-reloads settings.yaml')
}

void main()
