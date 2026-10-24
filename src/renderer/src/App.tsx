import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  Clock,
  Code2,
  Database,
  History,
  Network,
  Plus,
  Power,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  X
} from 'lucide-react'
import type {
  AIProfile,
  AiModelInfo,
  AppSettings,
  ChatMessage,
  ConnectionConfig,
  DbCapabilities,
  ExplainResult,
  PersistedState,
  QueryHistoryEntry,
  QueryResult,
  SchemaGraph,
  SchemaPayload
} from '@shared/types'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import SqlEditor, { type SqlEditorHandle } from './components/SqlEditor'
import PlanView from './components/PlanView'
import ResultsGrid from './components/ResultsGrid'
import TableDataView from './components/TableDataView'
import AiPanel from './components/AiPanel'
import ErGraph from './components/ErGraph'
import SettingsModal, { type SettingsTab } from './components/SettingsModal'
import ConnectionModal from './components/ConnectionModal'
import ConfirmDialog from './components/ConfirmDialog'
import SessionsModal from './components/SessionsModal'
import SchemaToolsModal from './components/SchemaToolsModal'
import { applyTheme } from './themes'
import { classifyRedis } from '@shared/sql'
import { isReadOnlyAccess } from '@shared/access'
import { isWriteSql, shortError } from './utils'

// Espelho mínimo de src/main/ai/redact.ts para o renderer: redact antes de
// enviar erro/SQL para a IA (onAskAi / Explain). Mantém mesma ordem de padrões.
function redactForAi(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[redacted-cpf]')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[redacted-cnpj]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[redacted-card]')
    .replace(/\b\(?\d{2}\)?[\s-]?\d{4,5}[-.\s]?\d{4}\b/g, '[redacted-phone]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [redacted]')
    .replace(
      /((?:password|passwd|pwd|secret|token|api[_-]?key|senha)\s*[:=]\s*['"]?)[^'"\s;,]+/gi,
      '$1[redacted]'
    )
}

interface QueryTab {
  id: string
  title: string
  sql: string
  result: QueryResult | null
  error: string | null
}

const DEFAULT_SQL =
  '-- DBLion\n-- Connect a database, then write SQL or ask the copilot.\nselect 1 as hello;\n'

function newQueryTab(index: number): QueryTab {
  return {
    id: crypto.randomUUID(),
    title: `Query ${index}`,
    sql: index === 1 ? DEFAULT_SQL : '-- New query\n',
    result: null,
    error: null
  }
}

function loadQueryTabs(): QueryTab[] {
  try {
    const raw = localStorage.getItem('dblion.queryTabs')
    if (!raw) return [newQueryTab(1)]
    const parsed = JSON.parse(raw) as { id?: unknown; title?: unknown; sql?: unknown }[]
    const tabs = parsed
      .filter((item) => typeof item?.id === 'string' && typeof item?.sql === 'string')
      .map((item) => ({
        id: String(item.id),
        title: String(item.title || 'Query'),
        sql: String(item.sql),
        result: null,
        error: null
      }))
    return tabs.length > 0 ? tabs : [newQueryTab(1)]
  } catch {
    return [newQueryTab(1)]
  }
}

const STARTUP_TABS = loadQueryTabs()
const STORED_ACTIVE =
  typeof localStorage !== 'undefined' ? localStorage.getItem('dblion.activeQueryId') : null
const STARTUP_ACTIVE =
  STORED_ACTIVE && STARTUP_TABS.some((tab) => tab.id === STORED_ACTIVE)
    ? STORED_ACTIVE
    : STARTUP_TABS[0].id

export default function App() {
  const [state, setState] = useState<PersistedState | null>(null)
  const [connected, setConnected] = useState<Record<string, boolean>>({})
  const [tab, setTab] = useState<'sql' | 'graph' | 'table' | 'plan'>('sql')
  const [tableTab, setTableTab] = useState<{
    connectionId: string
    schema?: string
    table: string
    type?: string
  } | null>(null)
  const [queryTabs, setQueryTabs] = useState<QueryTab[]>(STARTUP_TABS)
  const [activeQueryId, setActiveQueryId] = useState(STARTUP_ACTIVE)
  const startupTab = STARTUP_TABS.find((item) => item.id === STARTUP_ACTIVE) ?? STARTUP_TABS[0]
  const [sql, setSql] = useState(startupTab.sql)
  const [results, setResults] = useState<QueryResult | null>(startupTab.result)
  const [queryError, setQueryError] = useState<string | null>(startupTab.error)
  const [running, setRunning] = useState(false)
  const [plan, setPlan] = useState<ExplainResult | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planAnalyze, setPlanAnalyze] = useState(false)
  const [transactionActive, setTransactionActive] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [schema, setSchema] = useState<SchemaPayload | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [capabilities, setCapabilities] = useState<DbCapabilities | null>(null)
  const [graph, setGraph] = useState<SchemaGraph | null>(null)
  const [graphLoading, setGraphLoading] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [allowWrites, setAllowWrites] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('ai')
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [schemaToolsOpen, setSchemaToolsOpen] = useState(false)
  const [connectionModal, setConnectionModal] = useState<{
    open: boolean
    connection: ConnectionConfig | null
  }>({ open: false, connection: null })
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null)
  const [closeRequested, setCloseRequested] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    kind: 'disconnect' | 'delete'
    connectionId: string
    name: string
  } | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const messagesRef = useRef(messages)
  const saveTimer = useRef<number | null>(null)
  const pendingProfile = useRef<AIProfile | null>(null)
  const sqlEditorRef = useRef<SqlEditorHandle | null>(null)
  const activeConnectionIdRef = useRef<string | undefined>(undefined)
  messagesRef.current = messages

  const settings = state?.settings
  const activeConnection = state?.connections.find(
    (connection) => connection.id === settings?.activeConnectionId
  )
  const activeProfile =
    state?.profiles.find((profile) => profile.id === settings?.activeProfileId) ?? null
  const aiVisible = settings?.showAiPanel ?? true
  activeConnectionIdRef.current = settings?.activeConnectionId
  // Main is authoritative; this mirrors the badge and disables write controls.
  const connectionReadOnly = capabilities?.readOnly ?? isReadOnlyAccess(activeConnection)

  useEffect(() => {
    window.dblion
      .getState()
      .then((loaded) => {
        const normalized: PersistedState = {
          ...loaded,
          settings: {
            ...loaded.settings,
            activeConnectionId: loaded.settings.activeConnectionId ?? loaded.connections[0]?.id,
            activeProfileId: loaded.settings.activeProfileId ?? loaded.profiles[0]?.id
          }
        }
        setState(normalized)
        applyTheme(normalized.settings.theme)
      })
      .catch((error) => setToast({ message: shortError(error), error: true }))
  }, [])

  useEffect(() => {
    const unsubscribe = window.dblion.onChatChunk((chunk) => {
      if (chunk.requestId !== requestIdRef.current) return
      if (chunk.delta) {
        setMessages((previous) => {
          const next = [...previous]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + chunk.delta }
          } else {
            next.push({ role: 'assistant', content: chunk.delta ?? '' })
          }
          return next
        })
      }
      if (chunk.warning) {
        setToast({ message: chunk.warning, error: true })
      }
      if (chunk.error) {
        setMessages((previous) => {
          const next = [...previous]
          const last = next[next.length - 1]
          const content = `⚠ ${chunk.error}`
          if (last?.role === 'assistant') {
            next[next.length - 1] = {
              ...last,
              content: last.content ? `${last.content}\n\n${content}` : content
            }
          } else {
            next.push({ role: 'assistant', content })
          }
          return next
        })
        setToast({ message: chunk.error, error: true })
        setStreaming(false)
      }
      if (chunk.done) {
        setStreaming(false)
        setMessages((previous) => {
          const last = previous[previous.length - 1]
          if (last?.role === 'user') {
            return [...previous, { role: 'assistant', content: '(No response from the provider.)' }]
          }
          return previous
        })
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (settings?.theme) applyTheme(settings.theme)
  }, [settings?.theme])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), toast.error ? 9000 : 5200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    setQueryTabs((current) =>
      current.map((item) => (item.id === activeQueryId ? { ...item, sql } : item))
    )
  }, [sql, activeQueryId])

  useEffect(() => {
    setQueryTabs((current) =>
      current.map((item) =>
        item.id === activeQueryId ? { ...item, result: results, error: queryError } : item
      )
    )
  }, [results, queryError, activeQueryId])

  useEffect(() => {
    try {
      localStorage.setItem(
        'dblion.queryTabs',
        JSON.stringify(queryTabs.map(({ id, title, sql: text }) => ({ id, title, sql: text })))
      )
      localStorage.setItem('dblion.activeQueryId', activeQueryId)
    } catch {
      // localStorage is best-effort
    }
  }, [queryTabs, activeQueryId])

  useEffect(() => {
    if (tableTab && tableTab.connectionId !== activeConnection?.id) {
      setTableTab(null)
      setTab((current) => (current === 'table' ? 'sql' : current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnection?.id])

  useEffect(() => {
    const id = activeConnection?.id
    if (!id) {
      setCapabilities(null)
      return
    }
    let canceled = false
    window.dblion
      .capabilities(id)
      .then((next) => {
        if (!canceled) setCapabilities(next)
      })
      .catch(() => {
        if (!canceled) setCapabilities(null)
      })
    return () => {
      canceled = true
    }
  }, [activeConnection?.id])

  useEffect(() => window.dblion.onCloseRequested(() => setCloseRequested(true)), [])

  useEffect(() => {
    if (!closeRequested) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeRequested])

  useEffect(() => {
    setSchema(null)
    setGraph(null)
    setResults(null)
    setQueryError(null)
    setTransactionActive(false)
    setQueryTabs((current) =>
      current.map((item) => ({ ...item, result: null, error: null }))
    )
    const id = settings?.activeConnectionId
    if (id && connected[id]) void loadSchema(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.activeConnectionId])

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (pendingProfile.current) void window.dblion.saveProfile(pendingProfile.current)
    }
  }, [])

  function cancelClose(): void {
    setCloseRequested(false)
    window.dblion.respondToClose(false)
  }

  function confirmClose(): void {
    window.dblion.respondToClose(true)
  }

  async function loadSchema(connectionId: string): Promise<void> {
    setSchemaLoading(true)
    try {
      const payload = await window.dblion.schema(connectionId)
      if (activeConnectionIdRef.current === connectionId) setSchema(payload)
    } catch (error) {
      if (activeConnectionIdRef.current === connectionId) {
        setToast({ message: shortError(error), error: true })
      }
    } finally {
      setSchemaLoading(false)
    }
  }

  async function handleConnect(connectionId: string): Promise<boolean> {
    try {
      const result = await window.dblion.connect(connectionId)
      if (!result.ok) {
        setToast({ message: result.message, error: true })
        return false
      }
      setConnected((current) => ({ ...current, [connectionId]: true }))
      setToast({ message: result.message })
      if (activeConnectionIdRef.current === connectionId) await loadSchema(connectionId)
      return true
    } catch (error) {
      setToast({ message: shortError(error), error: true })
      return false
    }
  }

  async function performDisconnect(connectionId: string): Promise<void> {
    try {
      await window.dblion.disconnect(connectionId)
    } finally {
      setConnected((current) => ({ ...current, [connectionId]: false }))
      if (activeConnectionIdRef.current === connectionId) {
        setSchema(null)
        setGraph(null)
        setResults(null)
        setQueryError(null)
      }
    }
  }

  function requestDisconnect(connectionId: string): void {
    if (settings?.skipDisconnectConfirm) {
      void performDisconnect(connectionId)
      return
    }
    const connection = state?.connections.find((item) => item.id === connectionId)
    setConfirmation({
      kind: 'disconnect',
      connectionId,
      name: connection?.name ?? 'this connection'
    })
  }

  async function persistSettings(patch: Partial<AppSettings>): Promise<void> {
    const next = await window.dblion.patchSettings(patch)
    setState(next)
    applyTheme(next.settings.theme)
  }

  function selectConnection(id: string): void {
    if (!state) return
    setState({ ...state, settings: { ...state.settings, activeConnectionId: id } })
    void persistSettings({ activeConnectionId: id })
  }

  function activateQueryTab(id: string): void {
    if (id === activeQueryId) return
    const next = queryTabs.find((item) => item.id === id)
    if (!next) return
    setQueryTabs((current) =>
      current.map((item) =>
        item.id === activeQueryId ? { ...item, sql, result: results, error: queryError } : item
      )
    )
    setActiveQueryId(id)
    setSql(next.sql)
    setResults(next.result)
    setQueryError(next.error)
    setTab('sql')
  }

  function addQueryTab(): void {
    const next = newQueryTab(queryTabs.length + 1)
    setQueryTabs((current) => [
      ...current.map((item) =>
        item.id === activeQueryId ? { ...item, sql, result: results, error: queryError } : item
      ),
      next
    ])
    setActiveQueryId(next.id)
    setSql(next.sql)
    setResults(null)
    setQueryError(null)
    setTab('sql')
  }

  function closeQueryTab(id: string): void {
    if (queryTabs.length === 1) {
      setSql(DEFAULT_SQL)
      setResults(null)
      setQueryError(null)
      return
    }
    const index = queryTabs.findIndex((item) => item.id === id)
    const remaining = queryTabs.filter((item) => item.id !== id)
    setQueryTabs(remaining)
    if (id === activeQueryId) {
      const next = remaining[Math.max(0, Math.min(index, remaining.length - 1))]
      setActiveQueryId(next.id)
      setSql(next.sql)
      setResults(next.result)
      setQueryError(next.error)
    }
  }

  async function recordHistory(entry: Omit<QueryHistoryEntry, 'id' | 'at'>): Promise<void> {
    try {
      const next = await window.dblion.addQueryHistory(entry)
      setState(next)
    } catch {
      // history is best-effort
    }
  }

  async function clearHistory(): Promise<void> {
    if (!window.confirm('Clear the entire query history?')) return
    const next = await window.dblion.clearQueryHistory()
    setState(next)
  }

  async function saveProfile(profile: AIProfile): Promise<AIProfile> {
    const previousIds = new Set(state?.profiles.map((item) => item.id) ?? [])
    const next = await window.dblion.saveProfile(profile)
    setState(next)
    const saved = profile.id
      ? next.profiles.find((item) => item.id === profile.id)
      : next.profiles.find((item) => !previousIds.has(item.id))
    return saved ?? profile
  }

  async function deleteProfile(id: string): Promise<void> {
    const next = await window.dblion.deleteProfile(id)
    setState(next)
  }

  function patchProfile(patch: Partial<AIProfile>): void {
    if (!activeProfile) return
    const updated = { ...activeProfile, ...patch }
    pendingProfile.current = updated
    setState((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((profile) =>
              profile.id === updated.id ? updated : profile
            )
          }
        : current
    )
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const profile = pendingProfile.current
      pendingProfile.current = null
      if (profile) void window.dblion.saveProfile(profile)
    }, 500)
  }

  async function cancelCurrentQuery(): Promise<void> {
    if (!activeConnection) return
    try {
      await window.dblion.cancelQuery(activeConnection.id)
      setToast({ message: 'Cancel request sent to the database.' })
    } catch (error) {
      setToast({ message: shortError(error), error: true })
    }
  }

  async function handleTransaction(action: 'begin' | 'commit' | 'rollback'): Promise<void> {
    if (!activeConnection) return
    try {
      await window.dblion.transaction(activeConnection.id, action)
      setTransactionActive(action === 'begin')
      setToast({
        message:
          action === 'begin'
            ? 'Transaction started.'
            : action === 'commit'
              ? 'Transaction committed.'
              : 'Transaction rolled back.'
      })
    } catch (error) {
      setToast({ message: shortError(error), error: true })
    }
  }

  async function runSql(
    text = sql,
    allow = allowWrites,
    source: 'editor' | 'selection' | 'ai' = 'editor'
  ): Promise<void> {
    if (!activeConnection) {
      setToast({ message: 'Select a connection first.', error: true })
      return
    }
    if (!connected[activeConnection.id]) {
      const ok = await handleConnect(activeConnection.id)
      if (!ok) return
    }
    const connectionId = activeConnection.id
    const write =
      activeConnection.kind === 'redis' ? classifyRedis(text) !== 'read' : isWriteSql(text)
    if (write && connectionReadOnly) {
      setToast({
        message: `“${activeConnection.name}” is read-only. Open a read-write connection with a maintenance credential to write.`,
        error: true
      })
      return
    }
    if (write && !allow) {
      setToast({
        message: 'The write toggle is off. Enable “Writes” in the toolbar to run this statement.',
        error: true
      })
      return
    }
    if (write && settings?.readOnly) {
      setToast({
        message: 'Global read-only mode is on. Disable it in Settings → Safety first.',
        error: true
      })
      return
    }
    if (write && settings?.aiMode === 'read') {
      setToast({ message: 'AI mode is “read”. Switch to “edit” or “full” to write.', error: true })
      return
    }

    let confirmationToken: string | undefined
    if (write) {
      try {
        confirmationToken = await window.dblion.requestConfirmation({
          kind: 'sql-write',
          title: 'Approve write statement?',
          detail: `${connectionId}|${text}`
        })
      } catch (error) {
        setToast({ message: shortError(error), error: true })
        return
      }
    }

    setRunning(true)
    setQueryError(null)
    try {
      const result = await window.dblion.query(
        connectionId,
        text,
        [],
        write ? true : allow,
        confirmationToken,
        { source, schemaFingerprint: schema?.fingerprint }
      )
      if (activeConnectionIdRef.current === connectionId) setResults(result)
      void recordHistory({
        sql: text,
        connectionId,
        connectionName: activeConnection.name,
        durationMs: result.durationMs,
        rowCount: result.rowCount,
        source
      })
    } catch (error) {
      const message = shortError(error)
      if (activeConnectionIdRef.current === connectionId) {
        setResults(null)
        setQueryError(message)
      }
      void recordHistory({
        sql: text,
        connectionId,
        connectionName: activeConnection.name,
        error: message,
        source
      })
    } finally {
      setRunning(false)
    }
  }

  async function runPlan(): Promise<void> {
    if (!activeConnection) {
      setToast({ message: 'Select a connection first.', error: true })
      return
    }
    if (!(capabilities?.explain ?? false)) {
      setToast({ message: 'This connection does not support EXPLAIN.', error: true })
      return
    }
    const target = sqlEditorRef.current?.getSelectionText() || sql
    if (!target.trim()) {
      setToast({ message: 'Write a SELECT/WITH query first.', error: true })
      return
    }
    if (!connected[activeConnection.id]) {
      const ok = await handleConnect(activeConnection.id)
      if (!ok) return
    }
    const connectionId = activeConnection.id
    const planSource = sqlEditorRef.current?.getSelectionText() ? 'selection' : 'editor'
    // Token próprio de ANALYZE: mesmo SQL + mesma normalização do main
    // (security.explainAnalyzeDetail) para o hash do token casar.
    let confirmationToken: string | undefined
    if (planAnalyze) {
      if (!(capabilities?.explainAnalyze ?? false)) {
        setToast({ message: 'This connection returns estimated plans only (no ANALYZE).', error: true })
        return
      }
      try {
        confirmationToken = await window.dblion.requestConfirmation({
          kind: 'explain-analyze',
          title: 'Run EXPLAIN ANALYZE?',
          detail: `explain-analyze|${connectionId}|${target.replace(/\s+/g, ' ').trim()}`
        })
      } catch (error) {
        setToast({ message: shortError(error), error: true })
        return
      }
    }
    setPlanLoading(true)
    setPlanError(null)
    try {
      const result = await window.dblion.explain({
        connectionId,
        sql: target,
        analyze: planAnalyze,
        confirmationToken,
        source: planSource,
        schemaFingerprint: schema?.fingerprint
      })
      if (activeConnectionIdRef.current === connectionId) setPlan(result)
    } catch (error) {
      if (activeConnectionIdRef.current === connectionId) {
        setPlan(null)
        setPlanError(shortError(error))
      }
    } finally {
      setPlanLoading(false)
    }
  }

  function openPlanTab(): void {
    setTab('plan')
    void runPlan()
  }

  async function sendMessage(
    text: string,
    extraSkillIds: string[] = [],
    data?: { token: string; mode: 'profile' | 'rows' }
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || streaming) return
    if (!activeProfile) {
      openSettings('ai')
      setToast({ message: 'Create an AI profile first.', error: true })
      return
    }

    const userMessage: ChatMessage = { role: 'user', content: trimmed }
    const history = messagesRef.current.filter((message) => message.content.trim().length > 0)
    setMessages([...history, userMessage])
    setStreaming(true)

    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    try {
      await window.dblion.chat({
        requestId,
        profileId: activeProfile.id,
        messages: [...history, userMessage],
        connectionId: activeConnection?.id,
        skillIds: [
          ...new Set([...(settings?.enabledSkillIds ?? []), ...extraSkillIds])
        ],
        autoSkills: settings?.autoSkills ?? true,
        dataApprovalToken: data?.token,
        dataMode: data?.mode
      })
    } catch (error) {
      const message = shortError(error)
      setStreaming(false)
      setMessages((previous) => [
        ...previous,
        { role: 'assistant', content: `⚠ ${message}` }
      ])
      setToast({ message, error: true })
    }
  }

  function cancelAi(): void {
    if (requestIdRef.current) void window.dblion.abort(requestIdRef.current)
    setStreaming(false)
  }

  function newChat(): void {
    cancelAi()
    setMessages([])
    requestIdRef.current = null
  }

  async function refreshGraph(): Promise<void> {
    if (!activeConnection) {
      setToast({ message: 'Select a connection first.', error: true })
      return
    }
    if (!connected[activeConnection.id]) {
      const ok = await handleConnect(activeConnection.id)
      if (!ok) return
    }
    const connectionId = activeConnection.id
    setGraphLoading(true)
    try {
      const payload = await window.dblion.graph(connectionId, schema?.tables[0]?.schema)
      if (activeConnectionIdRef.current === connectionId) setGraph(payload)
    } catch (error) {
      if (activeConnectionIdRef.current === connectionId) {
        setToast({ message: shortError(error), error: true })
      }
    } finally {
      setGraphLoading(false)
    }
  }

  function insertSql(value: string): void {
    if (sqlEditorRef.current) {
      sqlEditorRef.current.insertText(value)
    } else {
      setSql((current) => `${current}\n${value}`)
    }
    setTab('sql')
  }

  function openTable(schemaName: string | undefined, tableName: string, type?: string): void {
    if (!activeConnection) {
      setToast({ message: 'Select and connect a database first.', error: true })
      return
    }
    const canBrowse =
      capabilities?.tableBrowser ??
      ['postgres', 'mysql', 'sqlite', 'mssql'].includes(activeConnection.kind)
    if (!canBrowse) {
      setToast({ message: 'This database does not support the table browser.', error: true })
      return
    }
    setTableTab({
      connectionId: activeConnection.id,
      schema: schemaName,
      table: tableName,
      type
    })
    setTab('table')
  }

  const tableConnection = state?.connections.find(
    (connection) => connection.id === tableTab?.connectionId
  )
  // The table tab can outlive a connection switch, so its own access mode
  // decides whether its edit and import controls are offered.
  const tableConnectionReadOnly = isReadOnlyAccess(tableConnection)

  function openSettings(nextTab: SettingsTab = 'ai'): void {
    setSettingsTab(nextTab)
    setSettingsOpen(true)
  }

  async function performDeleteConnection(id: string): Promise<void> {
    const next = await window.dblion.deleteConnection(id)
    setState(next)
    setConnected((current) => ({ ...current, [id]: false }))
    setConnectionModal({ open: false, connection: null })
    if (next.settings.activeConnectionId !== id) {
      setToast({ message: 'Connection deleted.' })
    }
  }

  async function requestDeleteConnection(id: string): Promise<void> {
    const connection = state?.connections.find((item) => item.id === id)
    setConfirmation({
      kind: 'delete',
      connectionId: id,
      name: connection?.name ?? 'this connection'
    })
  }

  async function resolveConfirmation(dontAskAgain: boolean): Promise<void> {
    const pending = confirmation
    if (!pending) return
    setConfirmation(null)
    try {
      if (pending.kind === 'delete') {
        await performDeleteConnection(pending.connectionId)
        return
      }
      if (dontAskAgain) {
        await performDisconnect(pending.connectionId)
        await persistSettings({ skipDisconnectConfirm: true })
        return
      }
      await performDisconnect(pending.connectionId)
    } catch (error) {
      setToast({ message: shortError(error), error: true })
    }
  }

  if (!state) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">
          <Sparkles size={20} />
        </div>
        <strong>Loading DBLion…</strong>
        <span>Preparing your workspace.</span>
      </div>
    )
  }

  return (
    <div className="app">
      <TopBar
        connections={state.connections}
        activeConnectionId={settings?.activeConnectionId}
        connected={connected}
        theme={settings?.theme ?? 'dracula'}
        aiVisible={aiVisible}
        aiMode={settings?.aiMode ?? 'read'}
        onConnectionChange={selectConnection}
        onThemeChange={(theme) => {
          applyTheme(theme)
          void persistSettings({ theme })
        }}
        onAiModeChange={(mode) => void persistSettings({ aiMode: mode })}
        onToggleAi={() => void persistSettings({ showAiPanel: !aiVisible })}
        onOpenSettings={() => openSettings('ai')}
      />

      <div className="main">
        <Sidebar
          connections={state.connections}
          activeId={settings?.activeConnectionId}
          connected={connected}
          onSelect={selectConnection}
          onAdd={() => setConnectionModal({ open: true, connection: null })}
          onEdit={(connection) => setConnectionModal({ open: true, connection })}
          onConnect={(id) => void handleConnect(id)}
          onDisconnect={(id) => requestDisconnect(id)}
          onDelete={(id) => requestDeleteConnection(id)}
          schema={activeConnection ? schema : null}
          schemaLoading={schemaLoading}
          onRefreshSchema={() =>
            activeConnection && void loadSchema(activeConnection.id)
          }
          onInsertTable={(name) => insertSql(name)}
          onOpenTable={(schemaName, tableName, type) => openTable(schemaName, tableName, type)}
          onOpenSchemaTools={() => setSchemaToolsOpen(true)}
        />

        <div className="workspace">
          <div className="workspace-tabs">
            <button
              className={`tab ${tab === 'sql' ? 'active' : ''}`}
              onClick={() => setTab('sql')}
              aria-selected={tab === 'sql'}
            >
              <Code2 size={15} /> SQL Editor
            </button>
            <button
              className={`tab ${tab === 'graph' ? 'active' : ''}`}
              onClick={() => setTab('graph')}
              aria-selected={tab === 'graph'}
            >
              <Network size={15} /> ER Graph
            </button>
            {tableTab ? (
              <button
                className={`tab ${tab === 'table' ? 'active' : ''}`}
                onClick={() => setTab('table')}
                aria-selected={tab === 'table'}
              >
                <Table2 size={15} /> {tableTab.table}
              </button>
            ) : null}
            {(capabilities?.explain ?? false) ? (
              <button
                className={`tab ${tab === 'plan' ? 'active' : ''}`}
                onClick={() => setTab('plan')}
                aria-selected={tab === 'plan'}
              >
                <Activity size={15} /> Plan
              </button>
            ) : null}
            <div className="workspace-tabs__meta">
              <span className="chip">
                <Database size={12} />
                {activeConnection ? activeConnection.name : 'no connection'}
              </span>
              {activeConnection ? (
                <span
                  className={`chip ${connectionReadOnly ? 'chip--readonly' : 'chip--writable'}`}
                  title={
                    connectionReadOnly
                      ? 'Read-only connection: writes are blocked in the main process.'
                      : 'Read-write connection: writes still need the toolbar toggle, AI mode and native confirmation.'
                  }
                >
                  <ShieldCheck size={12} />
                  {connectionReadOnly ? 'read-only' : 'read-write'}
                </span>
              ) : null}
              <span className="chip">
                <Sparkles size={12} />
                {activeProfile ? activeProfile.name : 'no AI profile'}
              </span>
            </div>
          </div>

          {tab === 'table' && tableTab && tableConnection ? (
            <div className="editor-shell">
              <div className="editor-body">
                <div className="editor-main editor-main--table">
                  <TableDataView
                    connectionId={tableTab.connectionId}
                    kind={tableConnection.kind}
                    schema={tableTab.schema}
                    table={tableTab.table}
                    tableType={tableTab.type}
                    allowWrites={allowWrites && !tableConnectionReadOnly}
                    canImport={Boolean(capabilities?.importCsv) && !tableConnectionReadOnly}
                    readOnlyConnection={tableConnectionReadOnly}
                    schemaFingerprint={schema?.fingerprint}
                    onToast={(message, error) => setToast({ message, error })}
                  />
                </div>
              </div>
            </div>
          ) : tab === 'sql' ? (
            <div className="editor-shell">
              <div className={`editor-body ${aiVisible ? '' : 'ai-hidden'}`}>
                <div className="editor-main">

                  <div className="sql-pane">
                    <div className="query-tabs" role="tablist" aria-label="Query tabs">
                      {queryTabs.map((item) => (
                        <div
                          key={item.id}
                          className={`query-tab ${item.id === activeQueryId ? 'active' : ''}`}
                          role="tab"
                          aria-selected={item.id === activeQueryId}
                          tabIndex={0}
                          onClick={() => activateQueryTab(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              activateQueryTab(item.id)
                            }
                          }}
                        >
                          <span className="query-tab__title">{item.title}</span>
                          <button
                            className="query-tab__close"
                            onClick={(event) => {
                              event.stopPropagation()
                              closeQueryTab(item.id)
                            }}
                            aria-label={`Close ${item.title}`}
                            title="Close query"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                      <button
                        className="query-tab-add"
                        onClick={addQueryTab}
                        title="New query"
                        aria-label="New query"
                      >
                        <Plus size={13} />
                      </button>
                      <div className="grow" />
                      <button
                        className={`btn btn-ghost btn-sm ${historyOpen ? 'is-active' : ''}`}
                        onClick={() => setHistoryOpen((value) => !value)}
                        aria-expanded={historyOpen}
                      >
                        <History size={13} /> History
                      </button>
                    </div>

                    {historyOpen ? (
                      <div className="query-history" role="dialog" aria-label="Query history">
                        <div className="query-history__head">
                          <div>
                            <strong>Query history</strong>
                            <span>{state.queryHistory.length} entries</span>
                          </div>
                          <div className="query-history__actions">
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => void clearHistory()}
                              disabled={state.queryHistory.length === 0}
                            >
                              <Trash2 size={12} /> Clear
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setHistoryOpen(false)}
                              aria-label="Close history"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                        <div className="query-history__list">
                          {state.queryHistory.length === 0 ? (
                            <div className="query-history__empty">
                              Run a query to start the history.
                            </div>
                          ) : (
                            state.queryHistory.map((entry) => (
                              <button
                                key={entry.id}
                                className="history-entry"
                                onClick={() => {
                                  setSql(entry.sql)
                                  setResults(null)
                                  setQueryError(null)
                                  setHistoryOpen(false)
                                  setTab('sql')
                                }}
                              >
                                <div className="history-entry__top">
                                  <span>
                                    <Clock size={10} />{' '}
                                    {new Date(entry.at).toLocaleString()}
                                  </span>
                                  <span>{entry.connectionName ?? 'no connection'}</span>
                                </div>
                                <code>{entry.sql.replace(/\s+/g, ' ').slice(0, 180)}</code>
                                <div className="history-entry__meta">
                                  {entry.error ? (
                                    <span className="is-error">error</span>
                                  ) : (
                                    <span>{entry.rowCount ?? 0} rows</span>
                                  )}
                                  {entry.durationMs ? (
                                    <span>{Math.round(entry.durationMs)} ms</span>
                                  ) : null}
                                  {entry.source ? <span>{entry.source}</span> : null}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : null}

                    <SqlEditor
                      ref={sqlEditorRef}
                      value={sql}
                      onChange={setSql}
                      theme={settings?.theme ?? 'dracula'}
                      schema={schema}
                      connectionId={activeConnection?.id}
                      profile={activeProfile}
                      aiAutocomplete={settings?.aiAutocomplete ?? true}
                      allowWrites={allowWrites && !connectionReadOnly}
                      readOnlyConnection={connectionReadOnly}
                      running={running}
                      connected={Boolean(activeConnection && connected[activeConnection.id])}
                      onRun={(selected) =>
                        void runSql(selected ?? sql, allowWrites, selected ? 'selection' : 'editor')
                      }
                      onCancel={() => void cancelCurrentQuery()}
                      canCancel={Boolean(capabilities?.cancelQuery)}
                      canTransact={Boolean(capabilities?.transactions)}
                      transactionActive={transactionActive}
                      onTransaction={(action) => void handleTransaction(action)}
                      sessionsSupported={Boolean(capabilities?.sessions)}
                      onOpenSessions={() => setSessionsOpen(true)}
                      onOpenSchemaTools={() => setSchemaToolsOpen(true)}
                      onExplain={() => {
                        const selected = sqlEditorRef.current?.getSelectionText()
                        const target = (selected || sql).trim()
                        if (!target) return
                        void persistSettings({ showAiPanel: true })
                        void sendMessage(
                          `Explain this SQL and point out performance risks:\n\n\`\`\`sql\n${redactForAi(target)}\n\`\`\``
                        )
                      }}
                      onExplainPlan={() => void openPlanTab()}
                      explainSupported={capabilities?.explain ?? false}
                      onRefreshSchema={() =>
                        activeConnection && void loadSchema(activeConnection.id)
                      }
                      onOpenGraph={() => {
                        setTab('graph')
                        void refreshGraph()
                      }}
                      onToggleWrites={() => setAllowWrites((current) => !current)}
                    />
                  </div>
                  <ResultsGrid
                    result={results}
                    error={queryError}
                    running={running}
                    onExport={async (content, filename) => {
                      try {
                        const saved = await window.dblion.saveTextFile(filename, content)
                        if (saved) setToast({ message: `Exported to ${saved}` })
                      } catch (error) {
                        setToast({ message: shortError(error), error: true })
                      }
                    }}
                    onAskAi={(error) => {
                      void persistSettings({ showAiPanel: true })
                      void sendMessage(
                        `Explain and fix this database error:\n\n\`\`\`\n${redactForAi(error)}\n\`\`\``
                      )
                    }}
                  />
                </div>

                {aiVisible ? (
                  <AiPanel
                    profiles={state.profiles}
                    activeProfileId={settings?.activeProfileId}
                    activeProfile={activeProfile}
                    messages={messages}
                    streaming={streaming}
                    schemaAvailable={Boolean(schema)}
                    schemaTableCount={schema?.tables.length ?? 0}
                    schemaFingerprint={schema?.fingerprint}
                    tables={schema?.tables ?? []}
                    connectionId={activeConnection?.id}
                    connectionLabel={activeConnection?.name}
                    enabledSkillIds={settings?.enabledSkillIds}
                    autoSkills={settings?.autoSkills}
                    onProfileChange={(id) => void persistSettings({ activeProfileId: id })}
                    onSend={(text, skillIds) => void sendMessage(text, skillIds)}
                    onCancel={cancelAi}
                    onInsertSql={insertSql}
                    onRunSql={(value) => {
                      setTab('sql')
                      void runSql(value, allowWrites, 'ai')
                    }}
                    onPatchProfile={patchProfile}
                    onOpenSettings={() => openSettings('ai')}
                    onNewChat={newChat}
                  />
                ) : null}
              </div>
            </div>
          ) : tab === 'plan' ? (
            <div className="editor-shell">
              <div className="editor-body">
                <div className="editor-main">
                  <PlanView
                    plan={plan}
                    loading={planLoading}
                    error={planError}
                    analyze={planAnalyze}
                    canAnalyze={capabilities?.explainAnalyze ?? false}
                    supported={capabilities?.explain ?? false}
                    connected={Boolean(activeConnection && connected[activeConnection.id])}
                    onToggleAnalyze={setPlanAnalyze}
                    onRun={() => void runPlan()}
                  />
                </div>
              </div>
            </div>
          ) : (
            <ErGraph graph={graph} loading={graphLoading} onRefresh={() => void refreshGraph()} />
          )}
        </div>
      </div>

      {schemaToolsOpen && activeConnection ? (
        <SchemaToolsModal
          activeConnection={activeConnection}
          connections={state.connections}
          schema={schema}
          readOnlyConnection={connectionReadOnly}
          onClose={() => setSchemaToolsOpen(false)}
          onToast={(message, error) => setToast({ message, error })}
          onOpenSql={(value) => {
            insertSql(value)
            setSchemaToolsOpen(false)
          }}
        />
      ) : null}

      {sessionsOpen && activeConnection ? (
        <SessionsModal
          connectionId={activeConnection.id}
          connectionName={activeConnection.name}
          canKill={Boolean(capabilities?.killSession) && !connectionReadOnly}
          onClose={() => setSessionsOpen(false)}
          onToast={(message, error) => setToast({ message, error })}
        />
      ) : null}

      <ConnectionModal
        open={connectionModal.open}
        connection={connectionModal.connection}
        onClose={() => setConnectionModal({ open: false, connection: null })}
        onTest={(connection) => window.dblion.testConnection(connection)}
        onDelete={requestDeleteConnection}
        onSave={async (connection) => {
          try {
            const next = await window.dblion.saveConnection(connection)
            setState(next)
            setConnectionModal({ open: false, connection: null })
            setToast({ message: 'Connection saved.' })
          } catch (error) {
            setToast({ message: shortError(error), error: true })
          }
        }}
      />

      <SettingsModal
        open={settingsOpen}
        state={state}
        initialTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
        onSaveProfile={saveProfile}
        onDeleteProfile={deleteProfile}
        onActivateProfile={(id) => persistSettings({ activeProfileId: id })}
        onListModels={async (profile) => window.dblion.listModelsDraft(profile)}
        onPatchSettings={persistSettings}
        onThemeChange={applyTheme}
      />

      {closeRequested ? (
        <div className="modal-backdrop">
          <div
            className="modal modal--close"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="close-title"
            aria-describedby="close-detail"
          >
            <div className="modal-header">
              <div className="modal-icon modal-icon--danger">
                <Power size={16} />
              </div>
              <div>
                <div className="modal-title" id="close-title">
                  Close DBLion?
                </div>
                <div className="modal-subtitle">Open connections will be disconnected.</div>
              </div>
            </div>
            <div className="modal-body" id="close-detail">
              Running statements are cancelled. Query tabs, history and saved profiles stay on this
              machine.
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={cancelClose} autoFocus>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={confirmClose}>
                Close DBLion
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmation ? (
        <ConfirmDialog
          open
          kind={confirmation.kind}
          connectionName={confirmation.name}
          onCancel={() => setConfirmation(null)}
          onConfirm={(dontAskAgain) => void resolveConfirmation(dontAskAgain)}
        />
      ) : null}

      {toast ? (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
          aria-live={toast.error ? 'assertive' : 'polite'}
        >
          <span>{toast.message}</span>
          <button
            className="icon-btn"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
