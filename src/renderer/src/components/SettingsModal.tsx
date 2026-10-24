import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  LibraryBig,
  Palette,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  X
} from 'lucide-react'
import type {
  AIProfile,
  AiModelInfo,
  AppSettings,
  PersistedState,
  SkillInfo
} from '@shared/types'
import { THEMES } from '../themes'
import AiProvidersPane from './settings/AiProvidersPane'

export type SettingsTab = 'ai' | 'skills' | 'appearance' | 'safety'

interface Props {
  open: boolean
  state: PersistedState
  initialTab?: SettingsTab
  onClose: () => void
  onSaveProfile: (profile: AIProfile) => Promise<AIProfile>
  onDeleteProfile: (id: string) => Promise<void>
  onActivateProfile: (id: string) => Promise<void>
  onListModels: (profile: AIProfile) => Promise<AiModelInfo[]>
  onPatchSettings: (patch: Partial<AppSettings>) => Promise<void>
  onThemeChange: (theme: string) => void
}

const NAV: { id: SettingsTab; label: string; icon: typeof Bot }[] = [
  { id: 'ai', label: 'AI providers', icon: Bot },
  { id: 'skills', label: 'Skills', icon: LibraryBig },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'safety', label: 'Safety', icon: ShieldCheck }
]

export default function SettingsModal({
  open,
  state,
  initialTab,
  onClose,
  onSaveProfile,
  onDeleteProfile,
  onActivateProfile,
  onListModels,
  onPatchSettings,
  onThemeChange
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'ai')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillQuery, setSkillQuery] = useState('')
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [profileDirty, setProfileDirty] = useState(false)

  function requestClose(): void {
    if (tab === 'ai' && profileDirty) {
      if (!window.confirm('Discard the unsaved profile changes?')) return
    }
    onClose()
  }

  function switchTab(next: SettingsTab): void {
    if (next === tab) return
    if (tab === 'ai' && profileDirty) {
      if (!window.confirm('Discard the unsaved profile changes?')) return
    }
    setTab(next)
    setMessage(null)
    if (tab === 'ai') setProfileDirty(false)
  }

  useEffect(() => {
    if (!open) return
    setTab(initialTab ?? 'ai')
    setMessage(null)
    setProfileDirty(false)
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, profileDirty, onClose])

  useEffect(() => {
    if (!open || tab !== 'skills') return
    setSkillsLoading(true)
    window.dblion
      .listSkills()
      .then(setSkills)
      .catch((error) =>
        setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
      )
      .finally(() => setSkillsLoading(false))
  }, [open, tab])

  if (!open) return null

  async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
    try {
      await onPatchSettings(patch)
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }

  async function toggleSkill(id: string): Promise<void> {
    const enabled = new Set(state.settings.enabledSkillIds ?? [])
    if (enabled.has(id)) enabled.delete(id)
    else enabled.add(id)
    await patchSettings({ enabledSkillIds: [...enabled] })
  }

  const filteredSkills = skills.filter((skill) => {
    const query = skillQuery.toLowerCase().trim()
    if (!query) return true
    return `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query)
  })

  const enabledCount = (state.settings.enabledSkillIds ?? []).length

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <div
        className="modal modal--settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-header">
          <div className="modal-icon">
            <Settings2 size={16} />
          </div>
          <div>
            <div className="modal-title" id="settings-title">
              Settings
            </div>
            <div className="modal-subtitle">Providers, skills, appearance and safety in one place.</div>
          </div>
          <button className="icon-btn" onClick={requestClose} title="Close" aria-label="Close settings">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body modal-body--settings">
          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Settings sections">
              {NAV.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    className={tab === item.id ? 'active' : ''}
                    onClick={() => switchTab(item.id)}
                    aria-current={tab === item.id}
                  >
                    <Icon size={15} />
                    <span>{item.label}</span>
                    {item.id === 'skills' && enabledCount > 0 ? (
                      <span className="nav-count">{enabledCount}</span>
                    ) : null}
                  </button>
                )
              })}
            </nav>

            <div className="settings-pane">
              {message ? (
                <div className={`notice ${message.error ? 'notice--error' : ''}`} role="status">
                  {message.error ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                  <span>{message.text}</span>
                  <button
                    className="icon-btn"
                    onClick={() => setMessage(null)}
                    aria-label="Dismiss message"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : null}

              {tab === 'ai' ? (
                <AiProvidersPane
                  profiles={state.profiles}
                  activeProfileId={state.settings.activeProfileId}
                  onSaveProfile={onSaveProfile}
                  onDeleteProfile={onDeleteProfile}
                  onActivateProfile={onActivateProfile}
                  onListModels={onListModels}
                  onDirtyChange={setProfileDirty}
                />
              ) : null}

              {tab === 'skills' ? (
                <>
                  <div className="settings-pane__head">
                    <div>
                      <span className="eyebrow">Instructions</span>
                      <h3>User skills</h3>
                      <p className="hint">
                        DBLion scans `~/.agents/skills`, `~/.claude/skills`,
                        `~/.commandcode/skills` and OpenCode folders. Selected skills are injected
                        into the AI system prompt.
                      </p>
                    </div>
                  </div>
                  <div className="list-toolbar">
                    <div className="search-box">
                      <Search size={14} />
                      <input
                        value={skillQuery}
                        onChange={(event) => setSkillQuery(event.target.value)}
                        placeholder="Filter skills…"
                        aria-label="Filter skills"
                      />
                    </div>
                    <button
                      className="btn"
                      onClick={async () => {
                        setSkillsLoading(true)
                        try {
                          setSkills(await window.dblion.listSkills(true))
                        } finally {
                          setSkillsLoading(false)
                        }
                      }}
                    >
                      <RefreshCw size={14} /> Rescan
                    </button>
                  </div>
                  <label className="switch-row">
                    <span className={`switch ${state.settings.autoSkills ? 'is-on' : ''}`}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={state.settings.autoSkills}
                        onChange={(event) => void patchSettings({ autoSkills: event.target.checked })}
                        aria-checked={state.settings.autoSkills}
                      />
                      <span className="switch__thumb" />
                    </span>
                    Auto-select relevant skills for each message
                  </label>

                  <div className="list-surface">
                    {skillsLoading ? (
                      <div className="list-loading">
                        <span className="spinner" /> Scanning skill folders…
                      </div>
                    ) : filteredSkills.length === 0 ? (
                      <div className="empty-state empty-state--compact">
                        <div className="empty-state__icon">
                          <LibraryBig size={18} />
                        </div>
                        <strong>No skills found</strong>
                        <span>Install a SKILL.md in a supported folder, then rescan.</span>
                      </div>
                    ) : (
                      filteredSkills.map((skill) => (
                        <label className="list-row" key={skill.id}>
                          <input
                            type="checkbox"
                            checked={(state.settings.enabledSkillIds ?? []).includes(skill.id)}
                            onChange={() => void toggleSkill(skill.id)}
                            aria-label={`Enable ${skill.name}`}
                          />
                          <span className="list-row__icon">
                            <LibraryBig size={14} />
                          </span>
                          <span className="list-row__body">
                            <span className="list-row__title">{skill.name}</span>
                            <span className="list-row__meta">
                              {skill.source} · {skill.description}
                            </span>
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                  <div className="settings-foot-note">
                    {enabledCount} skill(s) attached to the AI · {filteredSkills.length} shown
                  </div>
                </>
              ) : null}

              {tab === 'appearance' ? (
                <>
                  <div className="settings-pane__head">
                    <div>
                      <span className="eyebrow">Theme</span>
                      <h3>Appearance</h3>
                      <p className="hint">Themes apply to the shell, editor, results and graph.</p>
                    </div>
                  </div>
                  <div className="theme-grid">
                    {THEMES.map((theme) => (
                      <button
                        key={theme.id}
                        className={`theme-card ${state.settings.theme === theme.id ? 'active' : ''}`}
                        onClick={() => {
                          onThemeChange(theme.id)
                          void patchSettings({ theme: theme.id })
                        }}
                        aria-pressed={state.settings.theme === theme.id}
                      >
                        <div className="theme-swatches">
                          <span className="theme-swatch" style={{ background: theme.colors.bg }} />
                          <span className="theme-swatch" style={{ background: theme.colors.panel }} />
                          <span className="theme-swatch" style={{ background: theme.colors.accent }} />
                          <span className="theme-swatch" style={{ background: theme.colors.accent2 }} />
                          <span className="theme-swatch" style={{ background: theme.colors.green }} />
                        </div>
                        <div className="theme-card__title">{theme.label}</div>
                        <div className="theme-card__meta">{theme.mode}</div>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

              {tab === 'safety' ? (
                <>
                  <div className="settings-pane__head">
                    <div>
                      <span className="eyebrow">Guardrails</span>
                      <h3>Safety</h3>
                      <p className="hint">
                        Writes require the toolbar switch, a non-read AI mode and a native
                        confirmation. Read-only is the default.
                      </p>
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="ai-mode">AI permission mode</label>
                    <select
                      id="ai-mode"
                      className="select"
                      value={state.settings.aiMode}
                      onChange={(event) =>
                        void patchSettings({
                          aiMode: event.target.value as AppSettings['aiMode']
                        })
                      }
                    >
                      <option value="read">read — block every write</option>
                      <option value="edit">edit — DML with confirmation</option>
                      <option value="full">full — DDL and destructive tools</option>
                    </select>
                  </div>

                  <label className="switch-row">
                    <span className={`switch ${state.settings.readOnly ? 'is-on' : ''}`}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={state.settings.readOnly}
                        onChange={(event) => void patchSettings({ readOnly: event.target.checked })}
                        aria-checked={state.settings.readOnly}
                      />
                      <span className="switch__thumb" />
                    </span>
                    Global read-only mode
                  </label>
                  <label className="switch-row">
                    <span className={`switch ${state.settings.aiAutocomplete ? 'is-on' : ''}`}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={state.settings.aiAutocomplete}
                        onChange={(event) =>
                          void patchSettings({ aiAutocomplete: event.target.checked })
                        }
                        aria-checked={state.settings.aiAutocomplete}
                      />
                      <span className="switch__thumb" />
                    </span>
                    AI inline autocomplete in the SQL editor
                  </label>
                  <label className="switch-row">
                    <span className={`switch ${state.settings.showAiPanel ? 'is-on' : ''}`}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={state.settings.showAiPanel}
                        onChange={(event) =>
                          void patchSettings({ showAiPanel: event.target.checked })
                        }
                        aria-checked={state.settings.showAiPanel}
                      />
                      <span className="switch__thumb" />
                    </span>
                    Show AI panel by default
                  </label>
                  <label className="switch-row">
                    <span className={`switch ${state.settings.skipDisconnectConfirm ? '' : 'is-on'}`}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={!state.settings.skipDisconnectConfirm}
                        onChange={(event) =>
                          void patchSettings({ skipDisconnectConfirm: !event.target.checked })
                        }
                        aria-checked={!state.settings.skipDisconnectConfirm}
                      />
                      <span className="switch__thumb" />
                    </span>
                    Ask before disconnecting from a database
                  </label>

                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="max-rows">Max rows per result</label>
                      <input
                        id="max-rows"
                        className="input"
                        type="number"
                        min={100}
                        step={100}
                        value={state.settings.maxRows}
                        onChange={(event) =>
                          void patchSettings({
                            maxRows: Math.max(100, Number(event.target.value) || 100)
                          })
                        }
                      />
                      <div className="field-hint">
                        Read queries are wrapped with a server-side limit.
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="query-timeout">Query timeout (seconds)</label>
                      <input
                        id="query-timeout"
                        className="input"
                        type="number"
                        min={1}
                        step={5}
                        value={Math.round(state.settings.queryTimeoutMs / 1000)}
                        onChange={(event) =>
                          void patchSettings({
                            queryTimeoutMs: Math.max(1, Number(event.target.value)) * 1000
                          })
                        }
                      />
                      <div className="field-hint">Postgres and MySQL enforce this on the server.</div>
                    </div>
                  </div>

                  <div className="callout callout--info">
                    <ShieldCheck size={15} />
                    <span>
                      Every write asks for native confirmation. The schema context sent to the model
                      contains table and column names, not row data.
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={requestClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
