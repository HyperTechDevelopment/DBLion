import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AIProfile, AppSettings, ConnectionConfig, PersistedState } from '@shared/types'
import { normalizeAccessMode } from '@shared/access'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dracula',
  readOnly: true,
  confirmWrites: true,
  aiAutocomplete: true,
  showAiPanel: true,
  skipDisconnectConfirm: false,
  aiMode: 'read',
  enabledSkillIds: [],
  autoSkills: true,
  maxRows: 5000,
  queryTimeoutMs: 30000
}

const DEFAULT_STATE: PersistedState = {
  connections: [],
  profiles: [],
  settings: DEFAULT_SETTINGS,
  queryHistory: []
}

let cachedState: PersistedState | null = null

function statePath(): string {
  return path.join(app.getPath('userData'), 'dblion-state.json')
}

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'dblion-secrets.json')
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

function encryptSecret(value: string): string {
  if (!value) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(value).toString('base64')}`
  }
  console.warn('[security] OS credential encryption is unavailable; the secret will not be persisted')
  return ''
}

function decryptSecret(value: string): string {
  if (!value) return ''
  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    } catch {
      return ''
    }
  }
  if (value.startsWith('plain:')) {
    return Buffer.from(value.slice(6), 'base64').toString('utf8')
  }
  return value
}

function normalizeConnection(connection: ConnectionConfig): ConnectionConfig {
  // Persisted profiles from before per-connection access modes have no
  // `accessMode`. They must default to read-only, never to read-write.
  return { ...connection, accessMode: normalizeAccessMode(connection.accessMode) }
}

function normalizeState(raw: Partial<PersistedState> | null): PersistedState {
  const state: PersistedState = {
    connections: Array.isArray(raw?.connections)
      ? raw!.connections.map(normalizeConnection)
      : [],
    profiles: Array.isArray(raw?.profiles) ? raw!.profiles : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
    queryHistory: Array.isArray(raw?.queryHistory) ? raw!.queryHistory : []
  }
  // MCP was removed. Drop the legacy field so old state files cannot
  // re-enable a feature that no longer exists.
  delete (state.settings as unknown as Record<string, unknown>).enabledMcpServerIds
  return state
}

export function toPublicState(state: PersistedState): PersistedState {
  return {
    ...state,
    connections: state.connections.map((connection) => ({
      ...connection,
      password: undefined,
      hasPassword: Boolean(connection.password),
      ssh: connection.ssh
        ? {
            ...connection.ssh,
            password: undefined,
            privateKey: undefined,
            hasPassword: Boolean(connection.ssh.password),
            hasPrivateKey: Boolean(connection.ssh.privateKey)
          }
        : undefined
    })),
    profiles: state.profiles.map((profile) => ({
      ...profile,
      apiKey: undefined,
      hasApiKey: Boolean(profile.apiKey)
    }))
  }
}

export async function loadState(): Promise<PersistedState> {
  if (cachedState) return cachedState

  const raw = await readJson<Partial<PersistedState>>(statePath(), {})
  const state = normalizeState(raw)
  const secrets = await readJson<Record<string, string>>(secretsPath(), {})

  for (const connection of state.connections) {
    connection.password = decryptSecret(secrets[`connection:${connection.id}:password`] ?? '')
    if (connection.ssh) {
      connection.ssh.password = decryptSecret(
        secrets[`connection:${connection.id}:sshPassword`] ?? ''
      )
      connection.ssh.privateKey = decryptSecret(
        secrets[`connection:${connection.id}:sshKey`] ?? ''
      )
    }
  }
  for (const profile of state.profiles) {
    profile.apiKey = decryptSecret(secrets[`profile:${profile.id}:apiKey`] ?? '')
  }

  cachedState = state
  return state
}

export async function saveState(next: PersistedState): Promise<PersistedState> {
  const state = normalizeState(next)
  const secrets: Record<string, string> = {}

  const publicConnections: ConnectionConfig[] = state.connections.map((connection) => {
    if (connection.password) {
      secrets[`connection:${connection.id}:password`] = encryptSecret(connection.password)
    }
    if (connection.ssh?.password) {
      secrets[`connection:${connection.id}:sshPassword`] = encryptSecret(connection.ssh.password)
    }
    if (connection.ssh?.privateKey) {
      secrets[`connection:${connection.id}:sshKey`] = encryptSecret(connection.ssh.privateKey)
    }
    return {
      ...connection,
      password: undefined,
      ssh: connection.ssh
        ? {
            ...connection.ssh,
            password: undefined,
            privateKey: undefined,
            hasPassword: Boolean(connection.ssh.password),
            hasPrivateKey: Boolean(connection.ssh.privateKey)
          }
        : undefined
    }
  })

  const publicProfiles: AIProfile[] = state.profiles.map((profile) => {
    if (profile.apiKey) {
      secrets[`profile:${profile.id}:apiKey`] = encryptSecret(profile.apiKey)
    }
    return { ...profile, apiKey: undefined }
  })

  const persistedState: PersistedState = {
    connections: publicConnections,
    profiles: publicProfiles,
    settings: state.settings,
    queryHistory: state.queryHistory
  }

  await writeJson(statePath(), persistedState)
  await writeJson(secretsPath(), secrets)

  cachedState = state
  return toPublicState(state)
}

export function getCachedState(): PersistedState {
  if (!cachedState) throw new Error('State not loaded')
  return cachedState
}
