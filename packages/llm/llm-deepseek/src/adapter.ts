/** Select a DeepSeek wire implementation from one validated configuration generation. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, ProviderBalance, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DeepSeekAdapterOptions } from './common/types.ts'
import { ChatCompletionsAdapter, httpErrorCode } from './protocols/chat-completions/adapter.ts'
import { DeepSeekFileStore } from './common/file-store.ts'
import { DeepSeekMessagesAdapter } from './protocols/messages/adapter.ts'

/** One row in the DeepSeek account-balance response. */
interface BalanceWireRow {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

/** DeepSeek account-balance response body. */
interface BalanceWireBody {
  is_available: boolean
  balance_infos?: BalanceWireRow[]
}

/** Resolve the account endpoint beside either official wire-protocol root. */
function balanceEndpoint(baseURL: string, protocol: 'chat-completions' | 'messages'): string {
  const url = new URL(baseURL)
  const suffix = protocol === 'messages' ? /\/anthropic(?:\/v1)?\/?$/u : /\/v1\/?$/u
  const root = url.pathname.replace(/\/+$/u, '').replace(suffix, '')
  url.pathname = `${root}/user/balance`.replace(/^\/+/u, '/')
  url.search = ''
  url.hash = ''
  return url.href
}

/** One provider route with protocol-local transport and shared credentials and model configuration. */
export class DeepSeekAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly dependencies: DeepSeekAdapterOptions) {
    super()
    this.files = dependencies.resolveFiles?.() ?? new DeepSeekFileStore()
  }

  private implementation(): LlmAdapter {
    const connection = this.dependencies.options()
    switch (connection.protocol) {
      case 'messages':
        return new DeepSeekMessagesAdapter({
          connection: () => connection,
          apiKey: this.dependencies.resolveApiKey,
          userId: this.dependencies.resolveUserId,
          attachments: () => this.dependencies.resolveAttachments?.(),
          imageAccess: (ref) => {
            const attachments = this.dependencies.resolveAttachments?.()
            return attachments === undefined ? undefined : this.dependencies.resolveImageAccess?.(attachments, ref)
          },
          files: () => this.files,
          prepareExtensions: this.dependencies.prepareExtensions,
          ...this.dependencies.onReplayDegrade === undefined ? {} : { onReplayDegrade: this.dependencies.onReplayDegrade },
        })
      case 'chat-completions':
        return new ChatCompletionsAdapter({ ...this.dependencies, options: () => connection, resolveFiles: () => this.files })
      /* v8 ignore next -- protocol is validated at configuration resolution. */
      default: return assertNever(connection.protocol, 'DeepSeek protocol')
    }
  }

  /** Query the DeepSeek account balance with the same endpoint/key snapshot as a model call. */
  override async queryBalance(_provider: string, signal?: AbortSignal): Promise<ProviderBalance | undefined> {
    const connection = this.dependencies.options()
    const apiKey = await this.dependencies.resolveApiKey(connection)
    let response: Response
    try {
      response = await fetch(balanceEndpoint(connection.baseURL, connection.protocol), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      throw new LlmError(`DeepSeek balance query to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      throw new LlmError(
        `DeepSeek balance query failed (HTTP ${String(response.status)})`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }
    let body: BalanceWireBody
    try {
      body = await response.json() as BalanceWireBody
    } catch {
      throw new LlmError('DeepSeek balance query returned no readable body', 'EMPTY_RESPONSE')
    }
    if (body.is_available !== true) return undefined
    const row = body.balance_infos?.[0]
    if (row === undefined) return undefined
    const total = Number(row.total_balance)
    const toppedUp = Number(row.topped_up_balance)
    const granted = Number(row.granted_balance)
    if (![total, toppedUp, granted].every(Number.isFinite)) {
      throw new LlmError('DeepSeek balance query returned invalid amounts', 'INVALID_RESPONSE')
    }
    return { currency: row.currency, total, toppedUp, granted }
  }

  override providerInfo(provider: string) { return this.implementation().providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.implementation().providerRetryPolicy(provider) }
  override listModels(provider: string) { return this.implementation().listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.implementation().resolveModel(provider, model, signal)
  }
  override imageRequestPricing(provider: string, model: string) {
    return this.implementation().imageRequestPricing(provider, model)
  }
  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return this.implementation().prepareCall(provider, model, signal)
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.implementation().stream(options)
  }
}
