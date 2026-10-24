import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  Copy,
  CornerDownLeft,
  Database,
  FileText,
  Gauge,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import type {
  AIProfile,
  AiContextPreview,
  AiDataApproval,
  AiDataMode,
  ChatMessage,
  ExplainResult,
  PlanNode,
  SkillInfo,
  TableInfo
} from '@shared/types'
import { getExplainBlockReason } from '@shared/sql'
import { PROVIDER_META } from '../providers'

interface Props {
  profiles: AIProfile[]
  activeProfileId?: string
  activeProfile: AIProfile | null
  messages: ChatMessage[]
  streaming: boolean
  schemaAvailable: boolean
  schemaTableCount: number
  schemaFingerprint?: string
  tables?: TableInfo[]
  connectionId?: string
  connectionLabel?: string
  /** Skill ids enabled in settings; the panel adds its own attached skills. */
  enabledSkillIds?: string[]
  autoSkills?: boolean
  onProfileChange: (id: string) => void
  onSend: (
    text: string,
    skillIds: string[],
    data?: { token: string; mode: AiDataMode }
  ) => void
  onCancel: () => void
  onInsertSql: (sql: string) => void
  onRunSql: (sql: string) => void
  onPatchProfile: (patch: Partial<AIProfile>) => void
  onOpenSettings: () => void
  onNewChat: () => void
}

interface SlashState {
  start: number
  end: number
  query: string
}

/**
 * The EXPLAIN preflight for AI-proposed SQL. `checking` is the only state where
 * running is blocked; `done` always carries either a plan or the reason the
 * engine could not explain the statement, so the user can still run it.
 */
type PlanCheck =
  | { stage: 'checking'; sql: string }
  | { stage: 'done'; sql: string; plan: ExplainResult | null; failure: string | null }

function detectSlash(value: string, caret: number): SlashState | null {
  const before = value.slice(0, caret)
  const match = /(^|\s)\/([a-zA-Z0-9._-]*)$/.exec(before)
  if (!match) return null
  return {
    start: match.index + match[1].length,
    end: caret,
    query: match[2]
  }
}

function CodeCard({
  code,
  language,
  onInsert,
  onPlanCheck
}: {
  code: string
  language: string
  onInsert: (code: string) => void
  /** Asks the database for an estimated plan; it never executes the SQL. */
  onPlanCheck: (code: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lines = code.split('\n')
  const canCollapse = lines.length > 14
  const shown = canCollapse && !expanded ? lines.slice(0, 14).join('\n') : code
  const isSql = /sql|postgres|mysql|sqlite|plsql/i.test(language)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <div className="code-card">
      <div className="code-card__head">
        <span className="code-card__lang">{language || 'code'}</span>
        <div className="code-card__actions">
          <button className="btn btn-ghost btn-sm" onClick={() => void copy()}>
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => onInsert(code)}>
            Insert
          </button>
          {isSql ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onPlanCheck(code)}
              title="Asks the database for an estimated plan (EXPLAIN — the statement does not run) and shows it for review. Nothing executes until you approve it."
            >
              <Play size={11} /> Explain &amp; run
            </button>
          ) : null}
        </div>
      </div>
      <pre className="code-card__body">
        <code>{shown}</code>
      </pre>
      {canCollapse ? (
        <button className="code-card__more" onClick={() => setExpanded((value) => !value)}>
          <ChevronDown size={13} className={expanded ? 'rotated' : ''} />
          {expanded ? 'Collapse' : `Show ${lines.length - 14} more lines`}
        </button>
      ) : null}
    </div>
  )
}

function ChatTurn({
  message,
  streaming,
  onInsert,
  onPlanCheck
}: {
  message: ChatMessage
  streaming: boolean
  onInsert: (code: string) => void
  onPlanCheck: (code: string) => void
}) {
  const isError = message.content.trimStart().startsWith('⚠')
  const isUser = message.role === 'user'

  const components: Components = {
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children
      const props = (child as { props?: { className?: string; children?: unknown } } | null)?.props
      const code = String(props?.children ?? '').replace(/\n$/, '')
      const language = /language-([\w-]+)/.exec(props?.className ?? '')?.[1] ?? 'code'
      return <CodeCard code={code} language={language} onInsert={onInsert} onPlanCheck={onPlanCheck} />
    },
    code({ children, className }) {
      return <code className={`inline-code ${className ?? ''}`}>{children}</code>
    },
    a({ href, children }) {
      return (
        <button
          type="button"
          className="link-button"
          onClick={() => href && window.open(href, '_blank')}
        >
          {children}
        </button>
      )
    }
  }

  return (
    <article
      className={`chat-turn ${isUser ? 'chat-turn--user' : 'chat-turn--assistant'} ${
        isError ? 'chat-turn--error' : ''
      } ${streaming ? 'chat-turn--streaming' : ''}`}
    >
      {!isUser ? (
        <div className="chat-turn__avatar" aria-hidden="true">
          <Bot size={14} />
        </div>
      ) : null}
      <div className="chat-turn__body">
        <div className="chat-turn__meta">
          <span>{isUser ? 'You' : 'DBLion'}</span>
          {!isUser && !streaming ? <span>copilot</span> : null}
        </div>
        {message.content ? (
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : streaming ? (
          <div className="thinking" aria-label="DBLion is thinking">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
    </article>
  )
}

/** Depth-first list of plan nodes, so the panel can show the whole tree. */
function flattenPlan(nodes: PlanNode[], depth = 0): { node: PlanNode; depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...flattenPlan(node.children, depth + 1)
  ])
}

function PlanLine({ node, depth }: { node: PlanNode; depth: number }) {
  return (
    <li className="mono" style={{ paddingLeft: depth * 12 }}>
      {node.operation}
      {node.relation ? ` · ${node.relation}` : ''}
      {node.index ? ` · idx ${node.index}` : ''}
      {node.costTotal !== undefined ? ` · cost ${node.costTotal.toFixed(2)}` : ''}
      {node.rows !== undefined ? ` · rows ~${Math.round(node.rows)}` : ''}
    </li>
  )
}

const PROMPTS = [
  'Explain the relationships in my schema',
  'Write a query with a JOIN and a filter',
  'Suggest indexes for the slowest-looking query',
  'Design a migration to add a status column'
]

function formatChars(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k chars` : `${value} chars`
}

export default function AiPanel({
  profiles,
  activeProfileId,
  activeProfile,
  messages,
  streaming,
  schemaAvailable,
  schemaTableCount,
  schemaFingerprint,
  tables = [],
  connectionId,
  connectionLabel,
  enabledSkillIds,
  autoSkills,
  onProfileChange,
  onSend,
  onCancel,
  onInsertSql,
  onRunSql,
  onPatchProfile,
  onOpenSettings,
  onNewChat
}: Props) {
  const [input, setInput] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [attachedSkills, setAttachedSkills] = useState<SkillInfo[]>([])
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [tuningOpen, setTuningOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<AiContextPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const [dataMode, setDataMode] = useState<AiDataMode>('profile')
  const [dataTables, setDataTables] = useState('')
  const [dataApproval, setDataApproval] = useState<AiDataApproval | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [planCheck, setPlanCheck] = useState<PlanCheck | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let alive = true
    setSkillsLoading(true)
    window.dblion
      .listSkills()
      .then((list) => {
        if (alive) setSkills(list)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setSkillsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (!node || !atBottom) return
    const frame = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, streaming, atBottom])

  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`
  }, [input])

  const filteredSkills = useMemo(() => {
    if (!slash) return []
    const query = slash.query.toLowerCase().trim()
    const list = skills.filter((skill) => {
      if (!query) return true
      return `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query)
    })
    return list
      .sort((a, b) => {
        const aName = a.name.toLowerCase()
        const bName = b.name.toLowerCase()
        const aStarts = query ? Number(aName.startsWith(query)) : 0
        const bStarts = query ? Number(bName.startsWith(query)) : 0
        if (aStarts !== bStarts) return bStarts - aStarts
        return aName.localeCompare(bName)
      })
      .slice(0, 8)
  }, [slash, skills])

  useEffect(() => {
    if (slashIndex >= filteredSkills.length) setSlashIndex(0)
  }, [filteredSkills.length, slashIndex])

  function updateInput(value: string, caret: number): void {
    setInput(value)
    const nextSlash = detectSlash(value, caret)
    setSlash(nextSlash)
    if (nextSlash) setSlashIndex(0)
  }

  function addSkill(skill: SkillInfo): void {
    setAttachedSkills((current) =>
      current.some((item) => item.id === skill.id) ? current : [...current, skill]
    )
  }

  function selectSkill(skill: SkillInfo): void {
    if (!slash) return
    const caret = textareaRef.current?.selectionStart ?? input.length
    const before = input.slice(0, slash.start)
    const after = input.slice(caret)
    const spacer = before && !/\s$/.test(before) ? ' ' : ''
    const next = `${before}${spacer}${after}`
    setInput(next)
    addSkill(skill)
    setSlash(null)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      const position = before.length + spacer.length
      element.setSelectionRange(position, position)
    })
  }

  function removeSkill(id: string): void {
    setAttachedSkills((current) => current.filter((skill) => skill.id !== id))
  }

  /**
   * Asks main for the exact payload `ai:chat` would send right now. Read-only:
   * no provider call, no SQL execution, no API key in the response.
   */
  async function loadPreview(): Promise<void> {
    if (!activeProfile) return
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const draft = input.trim()
      const history = messages.filter((message) => message.content.trim().length > 0)
      setPreview(
        await window.dblion.contextPreview({
          profileId: activeProfile.id,
          messages: draft ? [...history, { role: 'user', content: draft }] : history,
          connectionId,
          skillIds: [
            ...new Set([...(enabledSkillIds ?? []), ...attachedSkills.map((skill) => skill.id)])
          ],
          autoSkills,
          dataApprovalToken: dataApproval?.token,
          dataMode: dataApproval?.mode
        })
      )
    } catch (error) {
      setPreview(null)
      setPreviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewLoading(false)
    }
  }

  function togglePreview(): void {
    setPreviewOpen((value) => !value)
  }

  // Build the preview whenever it is opened or the profile changes, so the
  // shown payload always matches the profile that would actually send it.
  useEffect(() => {
    if (previewOpen) void loadPreview()
  }, [previewOpen, activeProfileId])

  function send(): void {
    if (streaming) return
    let text = input.trim()
    if (!text) return
    if (!activeProfile) {
      onOpenSettings()
      return
    }

    const leading = /^\/([a-zA-Z0-9._-]+)\s+/.exec(text)
    if (leading) {
      const skill = skills.find(
        (item) => item.name.toLowerCase() === leading[1].toLowerCase()
      )
      if (skill) {
        addSkill(skill)
        text = text.slice(leading[0].length).trim()
      }
    }
    if (!text) return

    onSend(
      text,
      attachedSkills.map((skill) => skill.id),
      dataApproval ? { token: dataApproval.token, mode: dataApproval.mode } : undefined
    )
    setInput('')
    setAttachedSkills([])
    setSlash(null)
    setAtBottom(true)
    // The token is single-use; main consumed it with this request.
    setDataApproval(null)
  }

  async function prepareData(): Promise<void> {
    if (!connectionId) {
      setDataError('Connect to a database first.')
      return
    }
    const list = dataTables
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    if (list.length === 0) {
      setDataError('Type at least one table name.')
      return
    }
    setDataLoading(true)
    setDataError(null)
    try {
      const approval = await window.dblion.approveData({
        connectionId,
        mode: dataMode,
        tables: list
      })
      setDataApproval(approval)
      setPreviewOpen(true)
    } catch (error) {
      setDataApproval(null)
      setDataError(error instanceof Error ? error.message : String(error))
    } finally {
      setDataLoading(false)
    }
  }

  /**
   * Optional preflight: asks the database for an ESTIMATED plan for the SQL the
   * model proposed. The main handler only accepts a single read-only
   * SELECT/WITH, never passes ANALYZE, and gates on the connection's read-only
   * policy, so this call cannot execute or write anything. Failures are shown,
   * not fatal: a statement the engine cannot explain is still runnable.
   */
  async function checkPlan(sqlToCheck: string): Promise<void> {
    // Statements the engine cannot explain are skipped without a round trip:
    // the same shared gate used by main is applied here only to explain why.
    const blocked = getExplainBlockReason(sqlToCheck)
    if (blocked) {
      setPlanCheck({ stage: 'done', sql: sqlToCheck, plan: null, failure: blocked })
      return
    }
    if (!connectionId) {
      setPlanCheck({
        stage: 'done',
        sql: sqlToCheck,
        plan: null,
        failure: 'no connection is selected'
      })
      return
    }
    setPlanCheck({ stage: 'checking', sql: sqlToCheck })
    try {
      const plan = await window.dblion.explain({
        connectionId,
        sql: sqlToCheck,
        analyze: false,
        source: 'ai'
      })
      setPlanCheck({ stage: 'done', sql: sqlToCheck, plan, failure: null })
    } catch (error) {
      setPlanCheck({
        stage: 'done',
        sql: sqlToCheck,
        plan: null,
        failure: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * The only place the panel lets AI-proposed SQL reach the database, and it is
   * a human click on the plan-check card. It goes through the same
   * `onRunSql`/`runSql` gate as typed SQL (write toggle, AI mode, native
   * confirmation, read-only connection). Nothing here runs on send, on stream
   * completion, on a timer or on a keyboard shortcut.
   */
  function runApproved(sqlToRun: string): void {
    setPlanCheck(null)
    onRunSql(sqlToRun)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return
    if (slash) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashIndex((index) => (filteredSkills.length ? (index + 1) % filteredSkills.length : 0))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex((index) =>
          filteredSkills.length ? (index - 1 + filteredSkills.length) % filteredSkills.length : 0
        )
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const skill = filteredSkills[slashIndex]
        if (skill) selectSkill(skill)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlash(null)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  function onScroll(): void {
    const node = scrollRef.current
    if (!node) return
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 48)
  }

  const last = messages[messages.length - 1]
  const showThinking = streaming && last?.role !== 'assistant'
  const modelOptions = useMemo(() => {
    if (!activeProfile) return []
    const source = activeProfile.modelOptions?.length
      ? activeProfile.modelOptions
      : (PROVIDER_META[activeProfile.provider]?.models ?? [])
    return [...new Set([activeProfile.model, ...source].filter(Boolean))]
  }, [activeProfile])

  return (
    <aside className="ai-panel">
      <div className="ai-header">
        <div className="ai-avatar">
          <Sparkles size={15} />
        </div>
        <div className="ai-header__copy">
          <div className="ai-title">
            Copilot
            <span className={`ai-state ${streaming ? 'is-streaming' : ''}`}>
              {streaming ? 'streaming' : 'ready'}
            </span>
          </div>
          <div className="ai-subtitle">
            {activeProfile ? `${activeProfile.model || 'no model'} · ${activeProfile.provider}` : 'No profile selected'}
          </div>
        </div>
        <div className="ai-header__actions">
          <button
            className="icon-btn"
            onClick={onNewChat}
            title="New chat"
            aria-label="New chat"
          >
            <Plus size={15} />
          </button>
          <button
            className="icon-btn"
            onClick={onOpenSettings}
            title="AI settings"
            aria-label="Open AI settings"
          >
            <SlidersHorizontal size={15} />
          </button>
        </div>
      </div>

      <div className="ai-context">
        <select
          className="ai-profile-select"
          value={activeProfileId ?? ''}
          onChange={(event) => onProfileChange(event.target.value)}
          aria-label="AI profile"
        >
          {profiles.length === 0 ? <option value="">No profiles</option> : null}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.provider}
            </option>
          ))}
        </select>
        <select
          className="ai-model-select"
          value={activeProfile?.model ?? ''}
          onChange={(event) => onPatchProfile({ model: event.target.value })}
          disabled={!activeProfile}
          aria-label="AI model"
          title={activeProfile?.model ? `Model: ${activeProfile.model}` : 'Select an AI model'}
        >
          {!activeProfile || modelOptions.length === 0 ? (
            <option value="">No model</option>
          ) : null}
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <span
          className="chip chip--soft"
          title={
            schemaAvailable
              ? `Schema fingerprint: ${schemaFingerprint ?? 'not available'}`
              : 'No schema loaded'
          }
        >
          <Database size={11} />
          {schemaAvailable ? `${schemaTableCount} tables` : 'no schema'}
        </span>
        {connectionLabel ? (
          <span className="chip chip--soft" title={connectionLabel}>
            <Layers size={11} />
            {connectionLabel}
          </span>
        ) : null}
        <button
          className={`chip chip--button ${tuningOpen ? 'is-active' : ''}`}
          onClick={() => setTuningOpen((value) => !value)}
          aria-expanded={tuningOpen}
        >
          <SlidersHorizontal size={11} />
          {Math.round((activeProfile?.contextWindow ?? 128000) / 1000)}k · t{(activeProfile?.temperature ?? 0.2).toFixed(2)}
        </button>
        <button
          className={`chip chip--button ${previewOpen ? 'is-active' : ''}`}
          onClick={togglePreview}
          aria-expanded={previewOpen}
          aria-controls="ai-context-preview"
          title="Show the exact text this request would send to the provider"
        >
          <FileText size={11} />
          Context
        </button>
        <button
          className={`chip chip--button ${dataOpen ? 'is-active' : ''}`}
          onClick={() => setDataOpen((value) => !value)}
          aria-expanded={dataOpen}
          title="Attach aggregate statistics or a masked row sample to the next request. Nothing is sent until you prepare and send."
        >
          <Database size={11} />
          Data
        </button>
      </div>

      {dataOpen ? (
        <div className="ai-preview" role="region" aria-label="Data for debugging">
          <div className="ai-preview__head">
            <span className="ai-preview__title">
              <Database size={12} /> Data for debugging
            </span>
            <button
              className="icon-btn"
              onClick={() => setDataOpen(false)}
              title="Close data panel"
              aria-label="Close data panel"
            >
              <X size={12} />
            </button>
          </div>
          <div className="field">
            <label htmlFor="ai-data-mode">Mode</label>
            <select
              id="ai-data-mode"
              className="input"
              value={dataMode}
              onChange={(event) => {
                setDataMode(event.target.value as AiDataMode)
                setDataApproval(null)
              }}
            >
              <option value="profile">Column profile — aggregates and hashed top values</option>
              <option value="rows">Sample rows — max 25, every cell masked</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ai-data-tables">Tables</label>
            <input
              id="ai-data-tables"
              className="input"
              list="ai-data-table-names"
              value={dataTables}
              onChange={(event) => {
                setDataTables(event.target.value)
                setDataApproval(null)
              }}
              placeholder={dataMode === 'rows' ? 'CLIENTE' : 'CLIENTE, PEDIDO'}
            />
            <datalist id="ai-data-table-names">
              {tables.map((table) => (
                <option
                  key={`${table.schema ?? ''}.${table.name}`}
                  value={table.schema ? `${table.schema}.${table.name}` : table.name}
                />
              ))}
            </datalist>
          </div>
          <div className="ai-preview__note">
            {dataMode === 'profile'
              ? 'Sends row counts, nulls, distinct counts, min/max and hashed top values. PII-named columns are redacted. No row values leave the machine.'
              : 'Sends up to 25 rows in a database read-only transaction, with PII columns and PII-shaped values masked. The preview below is exactly what the provider receives.'}
          </div>
          <div className="ai-preview__meta">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void prepareData()}
              disabled={dataLoading || !connectionId}
            >
              {dataLoading ? 'Preparing…' : 'Prepare preview'}
            </button>
            {connectionId ? null : <span className="chip chip--soft">no connection</span>}
          </div>
          {dataError ? (
            <div className="ai-preview__note ai-preview__note--warn">{dataError}</div>
          ) : null}
          {dataApproval ? (
            <>
              <div className="ai-preview__meta">
                <span className="chip chip--flag">
                  {dataApproval.mode === 'profile'
                    ? 'profile'
                    : `${dataApproval.rows} row${dataApproval.rows === 1 ? '' : 's'}`}
                </span>
                {dataApproval.maskedCells > 0 ? (
                  <span className="chip chip--flag">{dataApproval.maskedCells} masked cells</span>
                ) : null}
                <span className="chip chip--soft">single request · 60s</span>
                <button className="icon-btn" onClick={() => setDataApproval(null)} title="Remove">
                  <X size={12} />
                </button>
              </div>
              <pre className="ai-preview__block">{dataApproval.context}</pre>
              <div className="ai-preview__note">
                This block is attached to the next message. The token is consumed when you send.
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {tuningOpen ? (
        <div className="ai-tuning">
          <div className="field">
            <label htmlFor="chat-context">Context window</label>
            <input
              id="chat-context"
              className="input"
              type="number"
              min={2000}
              step={1000}
              value={activeProfile?.contextWindow ?? 128000}
              onChange={(event) => onPatchProfile({ contextWindow: Number(event.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="chat-temperature">Temperature</label>
            <div className="range-row">
              <input
                id="chat-temperature"
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={activeProfile?.temperature ?? 0.2}
                onChange={(event) => onPatchProfile({ temperature: Number(event.target.value) })}
              />
              <span className="mono">{(activeProfile?.temperature ?? 0.2).toFixed(2)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {previewOpen ? (
        <div className="ai-preview" id="ai-context-preview" role="region" aria-label="What will be sent">
          <div className="ai-preview__head">
            <span className="ai-preview__title">
              <FileText size={12} /> What will be sent
            </span>
            <button
              className="icon-btn"
              onClick={() => void loadPreview()}
              disabled={previewLoading || !activeProfile}
              title="Rebuild the preview"
              aria-label="Rebuild context preview"
            >
              <RefreshCw size={12} className={previewLoading ? 'spin' : ''} />
            </button>
            <button
              className="icon-btn"
              onClick={() => setPreviewOpen(false)}
              title="Close preview"
              aria-label="Close context preview"
            >
              <X size={12} />
            </button>
          </div>
          {previewError ? (
            <div className="ai-preview__note ai-preview__note--warn">{previewError}</div>
          ) : null}
          {preview ? (
            <>
              <div className="ai-preview__meta">
                <span className="chip chip--soft">
                  {preview.provider} · {preview.model || 'no model'}
                </span>
                <span className={`chip ${preview.schemaIncluded ? 'chip--flag' : 'chip--soft'}`}>
                  {preview.schemaIncluded
                    ? `schema · ${formatChars(preview.schemaChars)}`
                    : 'no schema'}
                </span>
                <span className={`chip ${preview.skillsIncluded ? 'chip--flag' : 'chip--soft'}`}>
                  {preview.skillsIncluded
                    ? `skills · ${formatChars(preview.skillsChars)}`
                    : 'no skills'}
                </span>
                <span className="chip chip--soft">~{preview.estimatedInputTokens} tokens</span>
                <span className={`chip ${preview.masked ? 'chip--flag' : 'chip--soft'}`}>
                  {preview.masked ? 'PII masked' : 'PII masking off'}
                </span>
              </div>
              {preview.schemaWarning ? (
                <div className="ai-preview__note ai-preview__note--warn">
                  {preview.schemaWarning}
                </div>
              ) : null}
              <div className="ai-preview__note">
                {preview.masked
                  ? 'Context is redacted (PII masking is on). Redaction can also hide identifiers that only look like PII, so the model may ask for details you can see.'
                  : 'No PII masking: schema names, comments and defaults are sent as-is. Enable “Mask emails, CPF/CNPJ…” in AI settings to redact them.'}{' '}
                API keys are never part of this preview. Schema and skill text still leave this
                machine when “Send schema context” is on.
              </div>
              <div className="ai-preview__label">System prompt · {formatChars(preview.systemPromptChars)}</div>
              <pre className="ai-preview__block">{preview.systemPrompt}</pre>
              <div className="ai-preview__label">
                Conversation · {preview.messages.length} message
                {preview.messages.length === 1 ? '' : 's'}
              </div>
              {preview.messages.length === 0 ? (
                <pre className="ai-preview__block">(nothing yet — type a message to include it)</pre>
              ) : (
                preview.messages.map((message, index) => (
                  <div className="ai-preview__message" key={`preview-${index}-${message.role}`}>
                    <span className="ai-preview__role">{message.role}</span>
                    <pre className="ai-preview__block">{message.content}</pre>
                  </div>
                ))
              )}
            </>
          ) : !previewError ? (
            <div className="ai-preview__note">
              {previewLoading ? 'Building the request preview…' : 'Select an AI profile first.'}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="AI conversation"
      >
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty__mark">
              <Sparkles size={22} />
            </div>
            <h3>Ask DBLion about your database</h3>
            <p>
              Generate SQL, explain a query, design a schema or draw relationships. The active
              schema is sent as context when enabled — open <strong>Context</strong> to see the
              exact payload. Proposed SQL never runs on its own: “Explain &amp; run” shows the
              database plan first and only “Run now” can execute it.
            </p>
            <div className="prompt-grid">
              {PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  className="prompt-card"
                  onClick={() => {
                    setInput(prompt)
                    textareaRef.current?.focus()
                  }}
                >
                  <CornerDownLeft size={13} />
                  {prompt}
                </button>
              ))}
            </div>
            {!schemaAvailable ? <span className="chip">no schema loaded</span> : null}
          </div>
        ) : (
          messages.map((message, index) => (
            <ChatTurn
              key={`${index}-${message.role}`}
              message={message}
              streaming={streaming && index === messages.length - 1}
              onInsert={onInsertSql}
              onPlanCheck={checkPlan}
            />
          ))
        )}
        {showThinking ? (
          <div className="chat-turn chat-turn--assistant">
            <div className="chat-turn__avatar" aria-hidden="true">
              <Bot size={14} />
            </div>
            <div className="chat-turn__body">
              <div className="chat-turn__meta">DBLion</div>
              <div className="thinking" aria-label="DBLion is thinking">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {!atBottom && (messages.length > 0 || streaming) ? (
        <button
          className="chat-jump"
          onClick={() => {
            setAtBottom(true)
            const node = scrollRef.current
            if (node) node.scrollTop = node.scrollHeight
          }}
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      ) : null}

      {planCheck ? (
        <div
          className="ai-plan-check"
          role="region"
          aria-label="Plan check before running AI SQL"
        >
          <div className="ai-plan-check__head">
            <span className="ai-plan-check__title">
              <Gauge size={12} /> Plan check · EXPLAIN only, the statement did not run
            </span>
            <button
              className="icon-btn"
              onClick={() => setPlanCheck(null)}
              title="Discard the plan check"
              aria-label="Discard the plan check"
            >
              <X size={12} />
            </button>
          </div>
          {planCheck.stage === 'checking' ? (
            <div className="ai-plan-check__note">
              <span className="spinner" /> Asking the database for an estimated plan…
            </div>
          ) : planCheck.plan ? (
            <>
              <div className="ai-plan-check__meta">
                <span className="chip chip--soft">{planCheck.plan.dialect}</span>
                <span className="chip chip--soft">
                  {planCheck.plan.roots.length} plan root
                  {planCheck.plan.roots.length === 1 ? '' : 's'}
                </span>
                {planCheck.plan.totalCost !== undefined ? (
                  <span className="chip chip--soft">
                    cost {planCheck.plan.totalCost.toFixed(2)}
                  </span>
                ) : null}
                {planCheck.plan.warnings.length > 0 ? (
                  <span className="chip chip--flag">
                    {planCheck.plan.warnings.length} warning
                    {planCheck.plan.warnings.length === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
              <ul className="ai-plan-check__nodes">
                {flattenPlan(planCheck.plan.roots).map(({ node, depth }) => (
                  <PlanLine key={node.id} node={node} depth={depth} />
                ))}
              </ul>
              {planCheck.plan.warnings[0] ? (
                <div className="ai-plan-check__note ai-plan-check__note--warn">
                  {planCheck.plan.warnings[0]}
                </div>
              ) : null}
            </>
          ) : (
            <div className="ai-plan-check__note ai-plan-check__note--warn">
              No plan for this statement ({planCheck.failure}). DBLion did not execute it; you
              can still run it from here.
            </div>
          )}
          <div className="ai-plan-check__actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setPlanCheck(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={planCheck.stage === 'checking'}
              onClick={() => runApproved(planCheck.sql)}
              title="Runs the reviewed statement through the same gate as typed SQL."
            >
              <Play size={11} /> Run now
            </button>
          </div>
        </div>
      ) : null}

      <div className="composer">
        {slash ? (
          <div className="slash-menu" id="skills-listbox" role="listbox" aria-label="Skills">
            <div className="slash-menu__head">
              <span>Skills</span>
              <span>{skillsLoading ? 'scanning…' : `${filteredSkills.length} matches`}</span>
            </div>
            {skillsLoading ? (
              <div className="slash-menu__empty">
                <span className="spinner" /> Scanning skill folders…
              </div>
            ) : filteredSkills.length === 0 ? (
              <div className="slash-menu__empty">
                No skill matches “{slash.query}”. Try another term or open Settings → Skills.
              </div>
            ) : (
              filteredSkills.map((skill, index) => (
                <button
                  key={skill.id}
                  id={`skill-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === slashIndex}
                  className={`slash-option ${index === slashIndex ? 'active' : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    selectSkill(skill)
                  }}
                >
                  <span className="slash-option__mark">
                    <Sparkles size={12} />
                  </span>
                  <span className="slash-option__body">
                    <span className="slash-option__name">{skill.name}</span>
                    <span className="slash-option__meta">
                      {skill.source} · {skill.description}
                    </span>
                  </span>
                  <span className="slash-option__hint">↵</span>
                </button>
              ))
            )}
          </div>
        ) : null}

        {attachedSkills.length > 0 ? (
          <div className="composer__chips">
            {attachedSkills.map((skill) => (
              <span className="skill-chip" key={skill.id}>
                <Sparkles size={11} />
                {skill.name}
                <button
                  type="button"
                  onClick={() => removeSkill(skill.id)}
                  aria-label={`Remove skill ${skill.name}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="composer__box">
          <textarea
            ref={textareaRef}
            data-testid="chat-input"
            className="composer__input"
            value={input}
            onChange={(event) =>
              updateInput(event.target.value, event.target.selectionStart ?? event.target.value.length)
            }
            onKeyDown={onKeyDown}
            placeholder={
              activeProfile
                ? 'Ask for SQL, an explanation, an index suggestion…  / for skills'
                : 'Create an AI profile to start'
            }
            rows={2}
            aria-label="Message DBLion"
            aria-haspopup="listbox"
            aria-expanded={Boolean(slash)}
            aria-controls={slash ? 'skills-listbox' : undefined}
            aria-activedescendant={
              slash && filteredSkills[slashIndex]
                ? `skill-option-${slashIndex}`
                : undefined
            }
          />
          <div className="composer__footer">
            <span className="composer__hint">
              <span className="kbd">Enter</span> send
              <span className="composer__hint-sep">·</span>
              <span className="kbd">Shift↵</span> newline
              <span className="composer__hint-sep">·</span>
              <span className="kbd">/</span> skills
              <span className="composer__hint-sep">·</span>
              SQL never auto-runs
            </span>
            <div className="composer__actions">
              {streaming ? (
                <button className="btn btn-danger btn-sm" onClick={onCancel}>
                  <Square size={12} /> Stop
                </button>
              ) : null}
              <button
                className="send-button"
                onClick={send}
                disabled={!activeProfile || !input.trim() || streaming}
                aria-label="Send message"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
