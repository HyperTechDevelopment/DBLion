import type { AIProfile, AiModelInfo, ChatMessage } from '@shared/types'

export interface StreamUsage {
  input?: number
  output?: number
}

export interface StreamResult {
  usage?: StreamUsage
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function openAiBase(profile: AIProfile): string {
  if (profile.baseUrl.trim()) return stripTrailingSlash(profile.baseUrl.trim())
  switch (profile.provider) {
    case 'openai':
      return 'https://api.openai.com/v1'
    case 'openrouter':
      return 'https://openrouter.ai/api/v1'
    case 'ollama':
      return 'http://localhost:11434/v1'
    default:
      return 'https://api.openai.com/v1'
  }
}

function anthropicBase(profile: AIProfile): string {
  if (profile.baseUrl.trim()) return stripTrailingSlash(profile.baseUrl.trim())
  return 'https://api.anthropic.com'
}

function isOpenAiCompatible(profile: AIProfile): boolean {
  return profile.provider !== 'anthropic'
}

/**
 * Request headers for one provider.
 *
 * Only what the protocol needs is sent: authentication plus the Anthropic
 * version header. No referrer, app title, or any other attribution/telemetry
 * metadata is attached — a database IDE must not announce itself to the
 * provider on every request. Exported so `scripts/ai-safety.test.mjs` can
 * assert this contract.
 */
export function headersFor(profile: AIProfile): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(profile.customHeaders ?? {})
  }
  if (profile.provider === 'anthropic') {
    if (profile.apiKey) headers['x-api-key'] = profile.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`
  }
  return headers
}

function timeoutSignal(profile: AIProfile, signal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5, profile.timeoutSec) * 1000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function readSse(
  response: Response,
  onEvent: (payload: unknown) => void
): Promise<void> {
  if (!response.body) throw new Error('The provider returned an empty response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          onEvent(JSON.parse(data))
        } catch {
          // ignore malformed upstream event
        }
      }
    }
  }
}

async function chatOpenAi(
  profile: AIProfile,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<StreamResult> {
  const base = openAiBase(profile)
  const url = `${base}/chat/completions`
  const timed = timeoutSignal(profile, signal)
  let usage: StreamUsage | undefined
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headersFor(profile),
      signal: timed.signal,
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        stream: profile.streaming
      })
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`AI provider error ${response.status}: ${text.slice(0, 800)}`)
    }
    if (!profile.streaming) {
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const content = payload.choices?.[0]?.message?.content ?? ''
      if (content) onDelta(content)
      if (payload.usage) {
        usage = { input: payload.usage.prompt_tokens, output: payload.usage.completion_tokens }
      }
      return { usage }
    }
    await readSse(response, (event) => {
      const payload = event as {
        choices?: { delta?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const delta = payload.choices?.[0]?.delta?.content
      if (delta) onDelta(delta)
      if (payload.usage) {
        usage = { input: payload.usage.prompt_tokens, output: payload.usage.completion_tokens }
      }
    })
    return { usage }
  } finally {
    timed.clear()
  }
}

async function chatAnthropic(
  profile: AIProfile,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<StreamResult> {
  const base = anthropicBase(profile)
  const url = `${base}/v1/messages`
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
  const conversation = messages.filter((message) => message.role !== 'system')
  const timed = timeoutSignal(profile, signal)
  let usage: StreamUsage | undefined
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headersFor(profile),
      signal: timed.signal,
      body: JSON.stringify({
        model: profile.model,
        system: system || undefined,
        messages: conversation.map((message) => ({ role: message.role, content: message.content })),
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        stream: profile.streaming
      })
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Anthropic error ${response.status}: ${text.slice(0, 800)}`)
    }
    if (!profile.streaming) {
      const payload = (await response.json()) as {
        content?: { type: string; text?: string }[]
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const content = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (content) onDelta(content)
      if (payload.usage) {
        usage = { input: payload.usage.input_tokens, output: payload.usage.output_tokens }
      }
      return { usage }
    }
    await readSse(response, (event) => {
      const payload = event as {
        type?: string
        delta?: { type?: string; text?: string }
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      if (payload.type === 'content_block_delta' && payload.delta?.text) {
        onDelta(payload.delta.text)
      }
      if (payload.type === 'message_delta' && payload.usage) {
        usage = { input: payload.usage.input_tokens, output: payload.usage.output_tokens }
      }
    })
    return { usage }
  } finally {
    timed.clear()
  }
}

export async function streamChat(
  profile: AIProfile,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<StreamResult> {
  if (isOpenAiCompatible(profile)) return chatOpenAi(profile, messages, onDelta, signal)
  return chatAnthropic(profile, messages, onDelta, signal)
}

export async function listModels(profile: AIProfile): Promise<AiModelInfo[]> {
  const headers = headersFor(profile)
  if (profile.provider === 'ollama') {
    const base = openAiBase(profile).replace(/\/v1$/, '')
    const response = await fetch(`${base}/api/tags`, { headers })
    if (!response.ok) throw new Error(`Ollama model list failed: ${response.status}`)
    const payload = (await response.json()) as { models?: { name: string }[] }
    return (payload.models ?? []).map((model) => ({ id: model.name, label: model.name }))
  }

  if (profile.provider === 'anthropic') {
    const base = anthropicBase(profile)
    const response = await fetch(`${base}/v1/models`, { headers })
    if (!response.ok) throw new Error(`Anthropic model list failed: ${response.status}`)
    const payload = (await response.json()) as { data?: { id: string; display_name?: string }[] }
    return (payload.data ?? []).map((model) => ({ id: model.id, label: model.display_name ?? model.id }))
  }

  const base = openAiBase(profile)
  const response = await fetch(`${base}/models`, { headers })
  if (!response.ok) throw new Error(`Model list failed: ${response.status}`)
  const payload = (await response.json()) as { data?: { id: string }[] }
  return (payload.data ?? []).map((model) => ({ id: model.id, label: model.id }))
}
