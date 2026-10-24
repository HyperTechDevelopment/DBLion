import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Cable,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Cylinder,
  Database,
  Eye,
  EyeOff,
  FileText,
  Flame,
  FolderOpen,
  HardDrive,
  KeyRound,
  Leaf,
  Link2,
  Network,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { ConnectionAccessMode, ConnectionConfig, DbKind, TestResult } from '@shared/types'
import {
  accessModeOf,
  normalizeAccessMode,
  readOnlyEnforcement,
  readOnlyEnforcementNote
} from '@shared/access'
import { buildFirebirdUrl, FIREBIRD_ENCODINGS, parseFirebirdUrl } from '@shared/firebird'

const DEFAULTS: Record<DbKind, Partial<ConnectionConfig>> = {
  postgres: { port: 5432, database: 'postgres', user: 'postgres', ssl: false },
  mysql: { port: 3306, database: '', user: 'root', ssl: false },
  mssql: { port: 1433, database: 'master', user: 'sa', ssl: true },
  firebird: { port: 3050, database: '', user: 'SYSDBA', ssl: false, encoding: 'UTF8' },
  sqlite: { file: '' },
  mongodb: { port: 27017, database: 'admin', ssl: false },
  redis: { port: 6379, database: '0', ssl: false }
}

const KIND_META: Record<
  DbKind,
  {
    label: string
    hint: string
    mode: string
    icon: typeof Database
    port?: number
  }
> = {
  postgres: { label: 'PostgreSQL', hint: 'Relational database', mode: 'JDBC · relational', icon: Database, port: 5432 },
  mysql: { label: 'MySQL', hint: 'MariaDB compatible', mode: 'JDBC · relational', icon: Cylinder, port: 3306 },
  mssql: { label: 'SQL Server', hint: 'Microsoft T-SQL', mode: 'JDBC · relational', icon: Server, port: 1433 },
  firebird: { label: 'Firebird', hint: 'RDB$ metadata', mode: 'JDBC · relational', icon: Flame, port: 3050 },
  sqlite: { label: 'SQLite', hint: 'Local database file', mode: 'Local file', icon: HardDrive },
  mongodb: { label: 'MongoDB', hint: 'Document database', mode: 'Document store', icon: Leaf, port: 27017 },
  redis: { label: 'Redis', hint: 'Key/value store', mode: 'Key/value', icon: Zap, port: 6379 }
}

const KINDS = Object.keys(KIND_META) as DbKind[]

type StepId = 'engine' | 'general' | 'options' | 'review'

const STEPS: { id: StepId; label: string; hint: string; icon: typeof Database }[] = [
  { id: 'engine', label: 'Engine', hint: 'Database type', icon: Database },
  { id: 'general', label: 'General', hint: 'Endpoint and login', icon: Network },
  { id: 'options', label: 'Options', hint: 'Security and extras', icon: SlidersHorizontal },
  { id: 'review', label: 'Review', hint: 'Test and save', icon: ClipboardCheck }
]

interface Props {
  open: boolean
  connection: ConnectionConfig | null
  onClose: () => void
  onSave: (connection: ConnectionConfig) => Promise<void>
  onTest: (connection: ConnectionConfig) => Promise<TestResult>
  onDelete?: (id: string) => Promise<void>
}

function emptyConnection(): ConnectionConfig {
  return {
    id: '',
    name: 'New connection',
    ...DEFAULTS.postgres,
    accessMode: 'read-only',
    kind: 'postgres'
  }
}

function previewUrl(form: ConnectionConfig): string {
  const meta = KIND_META[form.kind]
  if (form.kind === 'sqlite') return form.file ? `sqlite://${form.file}` : 'sqlite://<file>'
  const host = form.host || 'localhost'
  const port = form.port ?? meta.port ?? 0
  const user = form.user ? `${form.user}${form.password ? ':•••' : ''}@` : ''
  const db = form.database ? `/${form.database}` : ''
  switch (form.kind) {
    case 'postgres':
      return `postgresql://${user}${host}:${port}${db}`
    case 'mysql':
      return `mysql://${user}${host}:${port}${db}`
    case 'mssql':
      return `sqlserver://${user}${host}:${port}${db}`
    case 'firebird':
      return buildFirebirdUrl(form)
    case 'mongodb':
      return `mongodb://${user}${host}:${port}${db}`
    case 'redis':
      return `redis://${user}${host}:${port}${db}`
    default:
      return ''
  }
}

export default function ConnectionModal({
  open,
  connection,
  onClose,
  onSave,
  onTest,
  onDelete
}: Props) {
  const [form, setForm] = useState<ConnectionConfig>(emptyConnection)
  const [step, setStep] = useState<StepId>('engine')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [firebirdUrl, setFirebirdUrl] = useState('')
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(connection ? { ...connection } : emptyConnection())
    setStep(connection ? 'general' : 'engine')
    setTestResult(null)
    setError(null)
    setShowPassword(false)
    setFirebirdUrl('')
  }, [open, connection])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form])

  if (!open) return null

  const meta = KIND_META[form.kind]
  const EngineIcon = meta.icon
  const isSqlite = form.kind === 'sqlite'
  const isDocument = form.kind === 'mongodb' || form.kind === 'redis'
  const dirty = JSON.stringify(form) !== JSON.stringify(connection ?? emptyConnection())
  const activeIndex = STEPS.findIndex((item) => item.id === step)
  const accessMode = accessModeOf(form)
  const canDuplicateAsReadWrite =
    Boolean(connection) && accessMode === 'read-only'

  function patch(patchValue: Partial<ConnectionConfig>): void {
    setForm((current) => ({ ...current, ...patchValue }))
    setError(null)
    setTestResult(null)
  }

  function patchSsh(patchValue: Partial<NonNullable<ConnectionConfig['ssh']>>): void {
    setForm((current) => ({
      ...current,
      ssh: current.ssh
        ? { ...current.ssh, ...patchValue }
        : { host: '', port: 22, user: '', ...patchValue }
    }))
    setError(null)
    setTestResult(null)
  }

  function changeKind(kind: DbKind): void {
    setForm((current) => ({
      id: current.id,
      name: current.name,
      accessMode: normalizeAccessMode(current.accessMode),
      ...DEFAULTS[kind],
      kind
    }))
    setTestResult(null)
    setError(null)
  }

  /**
   * Starts a second profile for maintenance. DBLion stores one credential per
   * connection, so the read-only password is cleared: the read-write profile
   * must use its own database login. No second secret store is created.
   */
  function duplicateAsReadWrite(): void {
    setForm((current) => ({
      ...current,
      id: '',
      name: `${(current.name || current.kind).replace(/\s*\(read-write\)$/i, '')} (read-write)`,
      accessMode: 'read-write',
      password: undefined,
      hasPassword: false
    }))
    setStep('general')
    setTestResult(null)
    setError(null)
  }

  function requestClose(): void {
    if (dirty && !window.confirm('Discard the unsaved connection changes?')) {
      return
    }
    onClose()
  }

  function applyFirebirdUrl(value: string): void {
    setFirebirdUrl(value)
    if (!value.trim()) {
      setError(null)
      return
    }
    const parts = parseFirebirdUrl(value)
    if (!parts) {
      if (/^(jdbc:)?firebird/i.test(value.trim())) {
        setError('Use jdbc:firebirdsql://host:3050/database?encoding=ISO8859')
      }
      return
    }
    setError(null)
    patch({
      host: parts.host,
      port: parts.port,
      database: parts.database,
      encoding: parts.encoding ?? form.encoding ?? 'UTF8'
    })
  }

  function validateGeneral(): boolean {
    if (!form.name.trim()) {
      setError('Give this connection a name.')
      return false
    }
    if (isSqlite && !form.file?.trim()) {
      setError('Choose a SQLite database file.')
      return false
    }
    if (!isSqlite && !form.host?.trim()) {
      setError('Host is required for this database type.')
      return false
    }
    return true
  }

  function next(): void {
    setError(null)
    if (step === 'engine') {
      setStep('general')
      return
    }
    if (step === 'general') {
      if (!validateGeneral()) return
      setStep('options')
      return
    }
    if (step === 'options') {
      setStep('review')
    }
  }

  function back(): void {
    setError(null)
    if (step === 'general') setStep('engine')
    else if (step === 'options') setStep('general')
    else if (step === 'review') setStep('options')
  }

  async function test(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      setTestResult(await onTest(form))
    } catch (testError) {
      setTestResult({
        ok: false,
        message: testError instanceof Error ? testError.message : String(testError)
      })
    } finally {
      setTesting(false)
    }
  }

  async function save(): Promise<void> {
    if (!validateGeneral()) {
      setStep('general')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(form)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  function stepComplete(id: StepId): boolean {
    if (id === 'general' || id === 'review') {
      return Boolean(form.name.trim() && (isSqlite ? form.file : form.host))
    }
    return true
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        className="modal modal--connection"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
      >
        <div className="modal-header">
          <div className="modal-icon">
            <Database size={16} />
          </div>
          <div>
            <div className="modal-title" id="connection-title">
              {connection ? 'Edit connection' : 'New connection'}
            </div>
            <div className="modal-subtitle">
              {connection ? 'Update the endpoint and options.' : 'Follow the steps to add a data source.'}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={requestClose}
            title="Close"
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body connection-body">
          <aside className="wizard-rail">
            <div className="wizard-engine">
              <div className="wizard-engine__icon">
                <EngineIcon size={18} />
              </div>
              <div>
                <div className="wizard-engine__name">{meta.label}</div>
                <div className="wizard-engine__mode">{meta.mode}</div>
              </div>
            </div>

            <nav className="wizard-steps" aria-label="Connection wizard steps">
              {STEPS.map((item, index) => {
                const Icon = item.icon
                const active = step === item.id
                const complete = index < activeIndex && stepComplete(item.id)
                return (
                  <button
                    key={item.id}
                    className={`wizard-step ${active ? 'active' : ''} ${complete ? 'complete' : ''}`}
                    onClick={() => setStep(item.id)}
                    aria-current={active ? 'step' : undefined}
                  >
                    <span className="wizard-step__index">
                      {complete ? <Check size={11} /> : index + 1}
                    </span>
                    <span className="wizard-step__icon">
                      <Icon size={14} />
                    </span>
                    <span className="wizard-step__copy">
                      <span className="wizard-step__label">{item.label}</span>
                      <span className="wizard-step__hint">{item.hint}</span>
                    </span>
                  </button>
                )
              })}
            </nav>

            <div className="wizard-rail__note">
              <ShieldCheck size={14} />
              <span>Test the connection before saving. Credentials stay on this machine.</span>
            </div>
          </aside>

          <section className="wizard-content">
            {step === 'engine' ? (
              <div className="wizard-section">
                <div className="wizard-section__head">
                  <span className="eyebrow">Step 1</span>
                  <h3>Choose the engine</h3>
                  <p>DBLion uses one adapter per engine, like DBeaver uses one driver per database.</p>
                </div>
                <div className="engine-grid" role="radiogroup" aria-label="Database engine">
                  {KINDS.map((kind) => {
                    const item = KIND_META[kind]
                    const Icon = item.icon
                    return (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={form.kind === kind}
                        className={`engine-card ${form.kind === kind ? 'active' : ''}`}
                        onClick={() => changeKind(kind)}
                      >
                        <span className="engine-card__icon">
                          <Icon size={17} />
                        </span>
                        <span className="engine-card__label">{item.label}</span>
                        <span className="engine-card__hint">{item.hint}</span>
                        {item.port ? <span className="engine-card__port">:{item.port}</span> : null}
                      </button>
                    )
                  })}
                </div>
                <div className="engine-summary">
                  <div className="engine-summary__icon">
                    <EngineIcon size={18} />
                  </div>
                  <div>
                    <strong>{meta.label}</strong>
                    <span>{meta.mode} · driver defaults will be applied</span>
                  </div>
                  <span className="chip">{meta.port ? `port ${meta.port}` : 'file'}</span>
                </div>
              </div>
            ) : null}

            {step === 'general' ? (
              <div className="wizard-section">
                <div className="wizard-section__head">
                  <span className="eyebrow">Step 2</span>
                  <h3>{isSqlite ? 'Database file' : 'Endpoint and login'}</h3>
                  <p>
                    {isSqlite
                      ? 'Select the local SQLite file DBLion should open.'
                      : 'These values build the connection URL shown in the review step.'}
                  </p>
                </div>

                <div className="field">
                  <label htmlFor="connection-name">Connection name</label>
                  <input
                    id="connection-name"
                    className="input"
                    autoFocus
                    value={form.name}
                    onChange={(event) => patch({ name: event.target.value })}
                    placeholder="Production PostgreSQL"
                  />
                </div>

                {isSqlite ? (
                  <div className="field">
                    <label htmlFor="connection-file">SQLite file</label>
                    <div className="row">
                      <input
                        id="connection-file"
                        className="input"
                        value={form.file ?? ''}
                        onChange={(event) => patch({ file: event.target.value })}
                        placeholder="path/to/app.db"
                      />
                      <button
                        className="btn"
                        onClick={async () => {
                          const file = await window.dblion.pickSqliteFile()
                          if (file) patch({ file })
                        }}
                      >
                        <FolderOpen size={14} /> Browse
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {form.kind === 'firebird' ? (
                      <div className="field">
                        <label htmlFor="connection-jdbc">JDBC URL</label>
                        <input
                          id="connection-jdbc"
                          className="input"
                          value={firebirdUrl}
                          onChange={(event) => applyFirebirdUrl(event.target.value)}
                          placeholder="jdbc:firebirdsql://host:3050/sample?encoding=ISO8859"
                          spellCheck={false}
                        />
                        <div className="field-hint">
                          Paste the Jaybird URL to fill host, port, database and encoding. ISO8859
                          is sent as ISO8859_1.
                        </div>
                      </div>
                    ) : null}
                    <div className="form-grid">
                      <div className="field">
                        <label htmlFor="connection-host">Host</label>
                        <input
                          id="connection-host"
                          className="input"
                          value={form.host ?? ''}
                          onChange={(event) => patch({ host: event.target.value })}
                          placeholder="localhost"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="connection-port">Port</label>
                        <input
                          id="connection-port"
                          className="input"
                          type="number"
                          value={form.port ?? ''}
                          onChange={(event) =>
                            patch({
                              port:
                                event.target.value === '' ? undefined : Number(event.target.value)
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="connection-database">
                          {form.kind === 'firebird'
                            ? 'Database path or alias'
                            : isDocument
                              ? 'Database (optional)'
                              : 'Database'}
                        </label>
                        <input
                          id="connection-database"
                          className="input"
                          value={form.database ?? ''}
                          onChange={(event) => patch({ database: event.target.value })}
                          placeholder={
                            form.kind === 'redis'
                              ? '0'
                              : form.kind === 'firebird'
                                ? 'path/to/app.fdb or alias'
                                : 'database'
                          }
                        />
                      </div>
                      {form.kind === 'firebird' ? (
                        <div className="field">
                          <label htmlFor="connection-encoding">Encoding</label>
                          <select
                            id="connection-encoding"
                            className="select"
                            value={form.encoding ?? 'UTF8'}
                            onChange={(event) => patch({ encoding: event.target.value })}
                          >
                            {FIREBIRD_ENCODINGS.map((encoding) => (
                              <option key={encoding.id} value={encoding.id}>
                                {encoding.label}
                              </option>
                            ))}
                          </select>
                          <div className="field-hint">Sent as lc_ctype when connecting.</div>
                        </div>
                      ) : null}
                      <div className="field">
                        <label htmlFor="connection-user">User</label>
                        <input
                          id="connection-user"
                          className="input"
                          value={form.user ?? ''}
                          onChange={(event) => patch({ user: event.target.value })}
                          placeholder={form.kind === 'redis' ? '(optional)' : 'user'}
                        />
                      </div>
                      <div className="field field--full">
                        <label htmlFor="connection-password">
                          <KeyRound size={12} /> Password
                        </label>
                        <div className="input-affix">
                          <input
                            id="connection-password"
                            className="input"
                            type={showPassword ? 'text' : 'password'}
                            value={form.password ?? ''}
                            onChange={(event) => patch({ password: event.target.value })}
                            placeholder="••••••••"
                          />
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => setShowPassword((value) => !value)}
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                            title={showPassword ? 'Hide password' : 'Show password'}
                          >
                            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                        {form.hasPassword && form.password === undefined ? (
                          <div className="field-hint">
                            <KeyRound size={11} /> Saved password will be kept. Type a new value to
                            replace it.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {step === 'options' ? (
              <div className="wizard-section">
                <div className="wizard-section__head">
                  <span className="eyebrow">Step 3</span>
                  <h3>Options</h3>
                  <p>
                    Access mode decides what this connection can do. DBLion stores one password per
                    connection, so a read-only profile and a read-write profile are two profiles with
                    two database credentials.
                  </p>
                </div>

                <div className="access-choice" role="radiogroup" aria-label="Connection access mode">
                  {(['read-only', 'read-write'] as ConnectionAccessMode[]).map((mode) => {
                    const selected = accessMode === mode
                    const danger = mode === 'read-write'
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`access-choice__option ${selected ? 'active' : ''} ${danger ? 'is-danger' : ''}`}
                        onClick={() => patch({ accessMode: mode })}
                      >
                        <span className="access-choice__head">
                          {danger ? <AlertCircle size={15} /> : <ShieldCheck size={15} />}
                          <strong>{danger ? 'Read-write' : 'Read-only'}</strong>
                          {selected ? <Check size={13} /> : null}
                        </span>
                        <span className="access-choice__hint">
                          {danger
                            ? 'Writes, row edits, CSV import, migrations and session kill. Every write still needs the toolbar toggle, AI mode and native confirmation.'
                            : 'SELECT, catalog and DDL inspection, EXPLAIN (estimated or read-only ANALYZE), query tabs and exports.'}
                        </span>
                      </button>
                    )
                  })}
                </div>

                <div className={`callout ${accessMode === 'read-write' ? 'callout--danger' : 'callout--info'}`}>
                  {accessMode === 'read-write' ? <AlertCircle size={15} /> : <KeyRound size={15} />}
                  <span>
                    {accessMode === 'read-write'
                      ? 'This profile can modify data and schema. Give it a maintenance credential that is used only here. Keep everyday browsing on a read-only profile.'
                      : 'Use a database credential with read-only grants (for example a role with only SELECT). DBLion also enforces this in the main process, so a renderer bug cannot write.'}
                  </span>
                </div>

                <div className="field-hint">
                  <ShieldCheck size={11} /> {readOnlyEnforcement(form.kind)} enforcement:{' '}
                  {readOnlyEnforcementNote(form.kind)}
                </div>

                {form.kind === 'postgres' || form.kind === 'mysql' || form.kind === 'mssql' ? (
                  <div className="option-card">
                    <div className="option-card__copy">
                      <ShieldCheck size={16} />
                      <div>
                        <strong>Use SSL/TLS</strong>
                        <span>Encrypt traffic between DBLion and the server.</span>
                      </div>
                    </div>
                    <span className={`switch ${form.ssl ? 'is-on' : ''}`}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={Boolean(form.ssl)}
                        onChange={(event) => patch({ ssl: event.target.checked })}
                        aria-checked={Boolean(form.ssl)}
                      />
                      <span className="switch__thumb" />
                    </span>
                  </div>
                ) : null}

                {form.ssl ? (
                  <details className="tls-details">
                    <summary>
                      <ShieldCheck size={13} /> Certificates (PEM)
                    </summary>
                    <p className="field-hint">
                      The server certificate is verified. Paste a CA for self-signed servers, and an
                      optional client certificate/key for mutual TLS.
                    </p>
                    <div className="field">
                      <label htmlFor="connection-ssl-ca">CA certificate</label>
                      <textarea
                        id="connection-ssl-ca"
                        className="textarea"
                        rows={3}
                        value={form.sslCa ?? ''}
                        onChange={(event) => patch({ sslCa: event.target.value })}
                        placeholder="-----BEGIN CERTIFICATE-----"
                      />
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label htmlFor="connection-ssl-cert">Client certificate</label>
                        <textarea
                          id="connection-ssl-cert"
                          className="textarea"
                          rows={3}
                          value={form.sslCert ?? ''}
                          onChange={(event) => patch({ sslCert: event.target.value })}
                          placeholder="-----BEGIN CERTIFICATE-----"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="connection-ssl-key">Client private key</label>
                        <textarea
                          id="connection-ssl-key"
                          className="textarea"
                          rows={3}
                          value={form.sslKey ?? ''}
                          onChange={(event) => patch({ sslKey: event.target.value })}
                          placeholder="-----BEGIN PRIVATE KEY-----"
                        />
                      </div>
                    </div>
                  </details>
                ) : null}

                {!isSqlite ? (
                  <div className="ssh-tunnel">
                    <div className="option-card">
                      <div className="option-card__copy">
                        <Network size={16} />
                        <div>
                          <strong>SSH tunnel</strong>
                          <span>Forward the database port through a bastion host.</span>
                        </div>
                      </div>
                      <span className={`switch ${form.ssh ? 'is-on' : ''}`}>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={Boolean(form.ssh)}
                          onChange={(event) =>
                            patch({
                              ssh: event.target.checked
                                ? { host: '', port: 22, user: '' }
                                : undefined
                            })
                          }
                          aria-checked={Boolean(form.ssh)}
                        />
                        <span className="switch__thumb" />
                      </span>
                    </div>
                    {form.ssh ? (
                      <div className="ssh-fields">
                        <div className="form-grid">
                          <div className="field">
                            <label htmlFor="ssh-host">SSH host</label>
                            <input
                              id="ssh-host"
                              className="input"
                              value={form.ssh.host}
                              onChange={(event) => patchSsh({ host: event.target.value })}
                              placeholder="bastion.example.com"
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="ssh-port">SSH port</label>
                            <input
                              id="ssh-port"
                              className="input"
                              type="number"
                              value={form.ssh.port ?? 22}
                              onChange={(event) =>
                                patchSsh({ port: Number(event.target.value) || 22 })
                              }
                            />
                          </div>
                          <div className="field field--full">
                            <label htmlFor="ssh-user">SSH user</label>
                            <input
                              id="ssh-user"
                              className="input"
                              value={form.ssh.user}
                              onChange={(event) => patchSsh({ user: event.target.value })}
                              placeholder="deploy"
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label htmlFor="ssh-password">SSH password</label>
                          <input
                            id="ssh-password"
                            className="input"
                            type="password"
                            value={form.ssh.password ?? ''}
                            onChange={(event) => patchSsh({ password: event.target.value })}
                            placeholder="••••••••"
                            autoComplete="off"
                          />
                          {form.ssh.hasPassword && form.ssh.password === undefined ? (
                            <div className="field-hint">Saved SSH password will be kept.</div>
                          ) : null}
                        </div>
                        <div className="field">
                          <label htmlFor="ssh-key">Private key (OpenSSH PEM)</label>
                          <textarea
                            id="ssh-key"
                            className="textarea"
                            rows={4}
                            value={form.ssh.privateKey ?? ''}
                            onChange={(event) => patchSsh({ privateKey: event.target.value })}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          />
                          {form.ssh.hasPrivateKey && form.ssh.privateKey === undefined ? (
                            <div className="field-hint">Saved private key will be kept.</div>
                          ) : null}
                        </div>
                        <div className="field">
                          <label htmlFor="ssh-passphrase">Key passphrase</label>
                          <input
                            id="ssh-passphrase"
                            className="input"
                            type="password"
                            value={form.ssh.passphrase ?? ''}
                            onChange={(event) => patchSsh({ passphrase: event.target.value })}
                            autoComplete="off"
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="field">
                  <label htmlFor="connection-string">
                    <Link2 size={12} /> Connection string
                  </label>
                  <input
                    id="connection-string"
                    className="input"
                    value={form.connectionString ?? ''}
                    onChange={(event) => patch({ connectionString: event.target.value })}
                    placeholder={
                      form.kind === 'mongodb'
                        ? 'mongodb://user:pass@host:27017/db'
                        : form.kind === 'redis'
                          ? 'redis://:pass@host:6379/0'
                          : form.kind === 'sqlite'
                            ? 'not used for SQLite'
                            : 'postgresql://user:pass@host:5432/db'
                    }
                  />
                  <div className="field-hint">
                    <Link2 size={11} /> Overrides host, port and database when provided.
                  </div>
                </div>

                <div className="callout callout--info">
                  <Cable size={15} />
                  <span>
                    DBLion keeps driver defaults for timeouts and pooling. Engine-specific properties
                    live in the adapter, not in this form.
                  </span>
                </div>
              </div>
            ) : null}

            {step === 'review' ? (
              <div className="wizard-section">
                <div className="wizard-section__head">
                  <span className="eyebrow">Step 4</span>
                  <h3>Review and test</h3>
                  <p>Check the summary, run a connection test, then save.</p>
                </div>

                <div className="review-grid">
                  <div className="review-card">
                    <span className="review-card__label">Engine</span>
                    <strong>{meta.label}</strong>
                    <span>{meta.mode}</span>
                  </div>
                  <div className="review-card">
                    <span className="review-card__label">Name</span>
                    <strong>{form.name || 'Unnamed connection'}</strong>
                    <span>{form.kind}</span>
                  </div>
                  <div className="review-card">
                    <span className="review-card__label">{isSqlite ? 'File' : 'Endpoint'}</span>
                    <strong>{isSqlite ? form.file || 'No file' : `${form.host || 'localhost'}:${form.port ?? meta.port ?? ''}`}</strong>
                    <span>{isDocument ? 'document store' : 'network'}</span>
                  </div>
                  <div className="review-card">
                    <span className="review-card__label">Security</span>
                    <strong>{form.ssl ? 'SSL/TLS on' : 'SSL/TLS off'}</strong>
                    <span>{form.password ? 'password set' : 'no password'}</span>
                  </div>
                  <div className="review-card">
                    <span className="review-card__label">Access</span>
                    <strong>{accessMode === 'read-only' ? 'Read-only' : 'Read-write'}</strong>
                    <span>{readOnlyEnforcement(form.kind)} enforcement</span>
                  </div>
                </div>

                <div className="url-preview">
                  <div className="url-preview__head">
                    <span>Connection URL</span>
                    <span className="chip">password masked</span>
                  </div>
                  <code>{form.connectionString || previewUrl(form)}</code>
                </div>

                <div className="review-test">
                  <div>
                    <strong>Connection test</strong>
                    <span>Verifies the endpoint and credentials before saving.</span>
                  </div>
                  <button className="btn" onClick={() => void test()} disabled={testing || saving}>
                    {testing ? 'Testing…' : 'Test connection'}
                  </button>
                </div>

                {testResult ? (
                  <div className={`test-result ${testResult.ok ? 'is-ok' : 'is-error'}`} role="status">
                    {testResult.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                    <div>
                      <strong>{testResult.ok ? 'Connection works' : 'Connection failed'}</strong>
                      <span>{testResult.message}</span>
                    </div>
                  </div>
                ) : null}

                <div className="review-note">
                  <FileText size={14} />
                  <span>
                    Saving stores the configuration and one password on this machine. A read-only
                    profile rejects writes in the main process; a read-write profile still needs the
                    toolbar write toggle, AI mode and native confirmation.
                  </span>
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="notice notice--error" role="alert">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            ) : null}

            {testResult && step !== 'review' ? (
              <div className={`test-result ${testResult.ok ? 'is-ok' : 'is-error'}`} role="status">
                {testResult.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                <div>
                  <strong>{testResult.ok ? 'Connection works' : 'Connection failed'}</strong>
                  <span>{testResult.message}</span>
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <div className="modal-footer wizard-footer">
          {connection && onDelete ? (
            <button
              className="btn btn-danger"
              onClick={() => void onDelete(connection.id)}
              disabled={testing || saving}
            >
              <Trash2 size={14} /> Delete
            </button>
          ) : null}
          {canDuplicateAsReadWrite ? (
            <button
              className="btn"
              onClick={duplicateAsReadWrite}
              disabled={testing || saving}
              title="Create a second profile for maintenance. It needs its own read-write credential."
            >
              <Copy size={14} /> Duplicate as read-write
            </button>
          ) : null}
          <div className="grow" />
          {step !== 'engine' ? (
            <button className="btn" onClick={back} disabled={saving}>
              <ChevronLeft size={14} /> Back
            </button>
          ) : null}
          {step !== 'review' ? (
            <>
              <button className="btn" onClick={() => void test()} disabled={testing || saving}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button className="btn btn-primary" onClick={next} disabled={saving}>
                Next <ChevronRight size={14} />
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving || testing}>
              {saving ? 'Saving…' : 'Save connection'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
