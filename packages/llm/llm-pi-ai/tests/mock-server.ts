import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  readonly closedResponses: number
  responseClosed: Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text generation in pi-ai's chat-completions shape. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/**
 * A minimal complete text generation in the Responses API shape, as raw SSE
 * frames: the OpenAI SDK's decoder maps the `event:` line to the event `type`
 * pi-ai's responses driver switches on, exactly like a real gateway stream.
 */
export const responsesTextEvents = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_mock","object":"response","status":"in_progress","model":"deepseek-v4-flash","output":[]}}',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_mock","type":"message","role":"assistant","status":"in_progress","content":[]}}',
  'event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"msg_mock","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_mock","output_index":0,"content_index":0,"delta":"hello"}',
  'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"msg_mock","output_index":0,"content_index":0,"text":"hello"}',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_mock","object":"response","status":"completed","model":"deepseek-v4-flash","output":[{"id":"msg_mock","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello","annotations":[]}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}}',
]

/** Local provider stand-in: replays scripted behaviors per request. */
export async function mockServer(script: {
  status?: number
  events?: string[]
  /** Raw SSE frames written verbatim (each already carries its `event:`/`data:` lines). */
  sse?: string[]
  body?: string
  delayMs?: number
  headers?: Record<string, string>
}[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let closedResponses = 0
  const responseClosed = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.on('close', () => {
      closedResponses += 1
      responseClosed.resolve(undefined)
    })
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push(request.headers)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (behavior.sse !== undefined) {
        let frame = 0
        const writeNextFrame = (): void => {
          const line = behavior.sse?.[frame++]
          if (line === undefined) { response.end(); return }
          response.write(`${line}\n\n`)
          if (behavior.delayMs === undefined) writeNextFrame()
          else setTimeout(writeNextFrame, behavior.delayMs)
        }
        writeNextFrame()
        return
      }
      let index = 0
      const writeNext = (): void => {
        const event = behavior.events?.[index++]
        if (event === undefined) { response.end(); return }
        response.write(`data: ${event}\n\n`)
        if (behavior.delayMs === undefined) writeNext()
        else setTimeout(writeNext, behavior.delayMs)
      }
      writeNext()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    requests,
    headers,
    responseClosed: responseClosed.promise,
    get closedResponses() { return closedResponses },
  }
}
