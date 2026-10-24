import type { AIProfile, AIProviderId } from '@shared/types'

export interface ProviderMeta {
  id: AIProviderId
  label: string
  hint: string
  baseUrl: string
  model: string
  models: string[]
  requiresKey: boolean
  docsUrl?: string
}

export const PROVIDER_META: Record<AIProviderId, ProviderMeta> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Cloud API · key required',
    baseUrl: '',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini', 'o4-mini'],
    requiresKey: true,
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude API · key required',
    baseUrl: '',
    model: 'claude-3-7-sonnet-latest',
    models: [
      'claude-3-7-sonnet-latest',
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-3-5-haiku-latest'
    ],
    requiresKey: true,
    docsUrl: 'https://console.anthropic.com/settings/keys'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    hint: 'Local runtime · no key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    models: ['llama3.1', 'qwen2.5-coder', 'deepseek-coder-v2', 'mistral', 'codellama'],
    requiresKey: false,
    docsUrl: 'https://ollama.com'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Multi-provider gateway',
    baseUrl: '',
    model: 'openai/gpt-4o-mini',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.7-sonnet',
      'google/gemini-2.0-flash-001',
      'deepseek/deepseek-chat',
      'meta-llama/llama-3.3-70b-instruct'
    ],
    requiresKey: true,
    docsUrl: 'https://openrouter.ai/keys'
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    hint: 'OpenAI-compatible endpoint',
    baseUrl: 'http://localhost:8000/v1',
    model: '',
    models: [],
    requiresKey: false
  }
}

export const PROVIDERS = Object.values(PROVIDER_META)

export function createDefaultProfile(provider: AIProviderId = 'openai'): AIProfile {
  const meta = PROVIDER_META[provider]
  return {
    id: '',
    name: meta.label,
    provider,
    baseUrl: meta.baseUrl,
    model: meta.model,
    modelOptions: [...meta.models],
    apiKey: '',
    contextWindow: 128000,
    temperature: 0.2,
    maxTokens: 2048,
    timeoutSec: 120,
    streaming: true,
    sendSchema: true,
    maskPII: false,
    systemPrompt: ''
  }
}

export function providerLabel(provider: AIProviderId): string {
  return PROVIDER_META[provider]?.label ?? provider
}
