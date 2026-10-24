import { contextBridge, ipcRenderer } from 'electron'
import type { ChatChunk, DblionApi } from '@shared/types'

const api: DblionApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  saveConnection: (connection) => ipcRenderer.invoke('connection:save', connection),
  deleteConnection: (id) => ipcRenderer.invoke('connection:delete', id),
  testConnection: (connection) => ipcRenderer.invoke('connection:test', connection),
  connect: (id) => ipcRenderer.invoke('connection:connect', id),
  disconnect: (id) => ipcRenderer.invoke('connection:disconnect', id),
  query: (id, sql, params, allowWrites, confirmationToken, opts) =>
    ipcRenderer.invoke('db:query', {
      id,
      sql,
      params,
      allowWrites,
      confirmationToken,
      source: opts?.source,
      schemaFingerprint: opts?.schemaFingerprint
    }),
  cancelQuery: (id) => ipcRenderer.invoke('db:cancel', id),
  explain: (request) => ipcRenderer.invoke('db:explain', request),
  transaction: (id, action) => ipcRenderer.invoke('db:transaction', { id, action }),
  schema: (id) => ipcRenderer.invoke('db:schema', id),
  schemaCatalog: (id, schema) => ipcRenderer.invoke('db:catalog', { id, schema }),
  objectDdl: (connectionId, object) => ipcRenderer.invoke('db:ddl', { connectionId, object }),
  diffSchemas: (leftConnectionId, rightConnectionId, schema) =>
    ipcRenderer.invoke('db:diff', { leftConnectionId, rightConnectionId, schema }),
  listMigrations: () => ipcRenderer.invoke('migrations:list'),
  saveMigration: (request) => ipcRenderer.invoke('migrations:save', request),
  readMigration: (id) => ipcRenderer.invoke('migrations:read', id),
  describe: (id, schema, table) => ipcRenderer.invoke('db:describe', { id, schema, table }),
  tablePage: (request) => ipcRenderer.invoke('db:table-page', request),
  previewRowUpdate: (request) => ipcRenderer.invoke('db:row-preview', request),
  applyRowUpdate: (request, confirmationToken) =>
    ipcRenderer.invoke('db:row-apply', { request, confirmationToken }),
  listSessions: (connectionId) => ipcRenderer.invoke('db:sessions', connectionId),
  previewKillSession: (request) => ipcRenderer.invoke('db:kill-preview', request),
  killSession: (request, confirmationToken, opts) =>
    ipcRenderer.invoke('db:kill-session', {
      request,
      confirmationToken,
      source: opts?.source,
      schemaFingerprint: opts?.schemaFingerprint
    }),
  previewCsvImport: (request) => ipcRenderer.invoke('db:import-preview', request),
  applyCsvImport: (request, confirmationToken, schemaFingerprint) =>
    ipcRenderer.invoke('db:import-apply', { request, confirmationToken, schemaFingerprint }),
  graph: (id, schema) => ipcRenderer.invoke('db:graph', { id, schema }),
  connectionStatus: () => ipcRenderer.invoke('connection:status'),
  capabilities: (id: string) => ipcRenderer.invoke('db:capabilities', id),
  auditList: (limit?: number) => ipcRenderer.invoke('audit:list', limit),
  addQueryHistory: (entry) => ipcRenderer.invoke('query:history:add', entry),
  clearQueryHistory: () => ipcRenderer.invoke('query:history:clear'),
  saveTextFile: (defaultName, content) =>
    ipcRenderer.invoke('file:save-text', { defaultName, content }),
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  listModels: (profileId) => ipcRenderer.invoke('ai:models', profileId),
  listModelsDraft: (profile) => ipcRenderer.invoke('ai:models-draft', profile),
  chat: (request) => ipcRenderer.invoke('ai:chat', request),
  contextPreview: (request) => ipcRenderer.invoke('ai:context-preview', request),
  approveData: (request) => ipcRenderer.invoke('ai:data-approve', request),
  complete: (profileId, prompt, connectionId, requestId) =>
    ipcRenderer.invoke('ai:complete', { profileId, prompt, connectionId, requestId }),
  abort: (requestId) => ipcRenderer.invoke('ai:abort', requestId),
  onChatChunk: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: ChatChunk): void => callback(chunk)
    ipcRenderer.on('ai:chunk', listener)
    return () => ipcRenderer.removeListener('ai:chunk', listener)
  },
  onCloseRequested: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:close-requested', listener)
    return () => ipcRenderer.removeListener('app:close-requested', listener)
  },
  respondToClose: (confirmed) => ipcRenderer.send('app:close-response', confirmed),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  pickSqliteFile: () => ipcRenderer.invoke('dialog:sqlite'),
  pickCsvFile: () => ipcRenderer.invoke('dialog:csv'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  listSkills: (refresh) => ipcRenderer.invoke('skills:list', refresh),
  readSkill: (id) => ipcRenderer.invoke('skills:read', id),
  searchSkills: (query) => ipcRenderer.invoke('skills:search', query),
  requestConfirmation: (payload) => ipcRenderer.invoke('security:confirm', payload)
}

contextBridge.exposeInMainWorld('dblion', api)
