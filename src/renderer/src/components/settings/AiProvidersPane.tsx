import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Star,
  Trash2,
  Wand2
} from 'lucide-react'
import type { AIProfile, AIProviderId, AiModelInfo } from '@shared/types'
import {
  PROVIDERS,
  PROVIDER_META,
  createDefaultProfile,
  providerLabel
} from '../../providers'

interface Props {
  profiles: AIProfile[]
  activeProfileId?: string
  onSaveProfile: (profile: AIProfile) => Promise<AIProfile>
  onDeleteProfile: (id: string) => Promise<void>
  onActivateProfile: (id: string) => Promise<void>
  onListModels: (profile: AIProfile) => Promise<AiModelInfo[]>
  onDirtyChange?: (dirty: boolean) => void
}

const CONTEXT_PRESETS = [
  { value: 32000, label: '32k' },
  { value: 128000, label: '128k' },
  { value: 200000, label: '200k' },
  { value: 1000000, label: '1M' }
]

function ProviderIcon({ provider, size = 16 }: { provider: AIProviderId; size?: number }) {
  const Icon =
    provider === 'anthropic'
      ? BrainCircuit
      : provider === 'ollama'
        ? Server
        : provider === 'openrouter'
          ? Cloud
          : provider === 'custom'
            ? Wand2
            : Bot
  return <Icon size={size} />
}

export default function AiProvidersPane({
  profiles,
  activeProfileId,
  onSaveProfile,
  onDeleteProfile,
  onActivateProfile,
  onListModels,
  onDirtyChange
}: Props) {
  const initial =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null
  const [selectedId, setSelectedId] = useState<string | null>(initial?.id ?? null)
  const [draft, setDraft] = useState<AIProfile>(initial ? { ...initial } : createDefaultProfile())
  const [models, setModels] = useState<AiModelInfo[]>(() => {
    const seed = initial ?? createDefaultProfile()
    return (seed.modelOptions ?? []).map((id) => ({ id }))
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageKind, setMessageKind] = useState<'ok' | 'error'>('ok')
  const [showKey, setShowKey] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const meta = PROVIDER_META[draft.provider]
  const current = profiles.find((profile) => profile.id === selectedId) ?? null
  const baseline = current ?? createDefaultProfile(draft.provider)
  const comparable = (profile: AIProfile): Omit<AIProfile, 'hasApiKey'> => {
    const { hasApiKey: _secretFlag, ...rest } = profile
    return rest
  }
  const dirty = JSON.stringify(comparable(draft)) !== JSON.stringify(comparable(baseline))
  const isActive = Boolean(draft.id && draft.id === activeProfileId)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  function patch(patchValue: Partial<AIProfile>): void {
    setDraft((value) => ({ ...value, ...patchValue }))
    setMessage(null)
  }

  function selectProfile(id: string): void {
    if (id === selectedId) return
    if (dirty && !window.confirm('Discard the unsaved changes in this profile?')) return
    const profile = profiles.find((item) => item.id === id)
    if (!profile) return
    setSelectedId(id)
    setDraft({ ...profile })
    setModels((profile.modelOptions ?? []).map((modelId) => ({ id: modelId })))
    setMessage(null)
    setConfirmDelete(false)
  }

  function startProvider(provider: AIProviderId): void {
    if (dirty && !window.confirm('Discard the unsaved changes in this profile?')) return
    setSelectedId(null)
    setDraft(createDefaultProfile(provider))
    setModels(PROVIDER_META[provider].models.map((modelId) => ({ id: modelId })))
    setMessage(null)
    setConfirmDelete(false)
  }

  function newProfile(): void {
    startProvider('openai')
  }

  function changeProvider(provider: AIProviderId): void {
    if (provider === draft.provider) return
    const next = PROVIDER_META[provider]
    const nameWasDefault = draft.name === meta.label
    setDraft((value) => ({
      ...value,
      provider,
      name: nameWasDefault ? next.label : value.name,
      baseUrl: next.baseUrl,
      model: next.model,
      modelOptions: [...next.models]
    }))
    setModels(next.models.map((modelId) => ({ id: modelId })))
    setMessageKind('ok')
    setMessage(`${next.label} defaults applied to Base URL and Model. Review them before saving.`)
  }

  function validate(): string | null {
    if (!draft.name.trim()) return 'Profile name is required.'
    if (!draft.model.trim()) return 'Model is required.'
    if (draft.contextWindow < 2000) return 'Context window must be at least 2000 tokens.'
    if (draft.maxTokens < 64) return 'Max output tokens must be at least 64.'
    if (draft.temperature < 0 || draft.temperature > 2) return 'Temperature must be between 0 and 2.'
    return null
  }

  async function save(activate = false): Promise<void> {
    const error = validate()
    if (error) {
      setMessageKind('error')
      setMessage(error)
      return
    }
    setBusy(true)
    try {
      const saved = await onSaveProfile({ ...draft, name: draft.name.trim(), model: draft.model.trim() })
      setDraft({ ...saved })
      setSelectedId(saved.id)
      if (activate) await onActivateProfile(saved.id)
      setMessageKind('ok')
      setMessage(activate ? 'Profile saved and set as active.' : 'Profile saved.')
    } catch (saveError) {
      setMessageKind('error')
      setMessage(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!draft.id || profiles.length <= 1) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy(true)
    try {
      await onDeleteProfile(draft.id)
      const remaining = profiles.filter((profile) => profile.id !== draft.id)
      const next = remaining[0] ?? null
      setSelectedId(next?.id ?? null)
      setDraft(next ? { ...next } : createDefaultProfile())
      setModels(
        next
          ? (next.modelOptions ?? []).map((modelId) => ({ id: modelId }))
          : PROVIDER_META.openai.models.map((modelId) => ({ id: modelId }))
      )
      setConfirmDelete(false)
      setMessageKind('ok')
      setMessage(next ? `Profile deleted. Editing “${next.name}”.` : 'Profile deleted.')
    } catch (deleteError) {
      setMessageKind('error')
      setMessage(deleteError instanceof Error ? deleteError.message : String(deleteError))
    } finally {
      setBusy(false)
    }
  }

  function duplicate(): void {
    setSelectedId(null)
    setDraft({ ...draft, id: '', name: `${draft.name} copy` })
    setModels((draft.modelOptions ?? []).map((modelId) => ({ id: modelId })))
    setMessageKind('ok')
    setMessage('Copy ready. Save to create the new profile.')
  }

  async function loadModels(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const list = await onListModels(draft)
      setModels(list)
      patch({ modelOptions: list.map((model) => model.id) })
      setMessageKind('ok')
      setMessage(`Loaded ${list.length} model(s) from ${providerLabel(draft.provider)}.`)
    } catch (loadError) {
      setMessageKind('error')
      setMessage(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="providers" data-testid="ai-providers-pane">
      <aside className="providers__list">
        <div className="providers__list-head">
          <div>
            <span className="eyebrow">AI</span>
            <h3>Profiles</h3>
          </div>
          <button
            className="icon-btn"
            onClick={newProfile}
            title="New profile"
            aria-label="New profile"
            data-testid="new-profile"
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="profile-cards">
          {profiles.map((profile) => {
            const active = profile.id === activeProfileId
            return (
              <button
                key={profile.id}
                type="button"
                className={`profile-card ${profile.id === selectedId ? 'active' : ''}`}
                onClick={() => selectProfile(profile.id)}
                aria-current={profile.id === selectedId}
                data-testid="profile-card"
              >
                <span className="profile-card__avatar">
                  <ProviderIcon provider={profile.provider} size={15} />
                </span>
                <span className="profile-card__body">
                  <span className="profile-card__name">
                    {profile.name}
                    {active ? <span className="badge badge--active">active</span> : null}
                  </span>
                  <span className="profile-card__meta">
                    {providerLabel(profile.provider)} · {profile.model || 'no model'}
                  </span>
                </span>
                <ChevronRight size={14} className="profile-card__chevron" />
              </button>
            )
          })}
          {profiles.length === 0 ? (
            <div className="empty-state empty-state--compact">
              <div className="empty-state__icon">
                <Sparkles size={18} />
              </div>
              <strong>No profiles yet</strong>
              <span>Create one to connect DBLion to a provider.</span>
            </div>
          ) : null}
        </div>

        <button className="btn btn-block" onClick={newProfile}>
          <Plus size={14} /> New profile
        </button>
      </aside>

      <div className="profile-form">
        <div className="profile-form__head">
          <div className="profile-form__identity">
            <div className="profile-avatar">
              <ProviderIcon provider={draft.provider} size={18} />
            </div>
            <div className="profile-form__identity-copy">
              <input
                className="profile-name-input"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                aria-label="Profile name"
                data-testid="profile-name"
              />
              <div className="profile-form__sub">
                {meta.label} · {draft.id ? (isActive ? 'active profile' : 'saved profile') : 'unsaved profile'}
                {dirty ? <span className="dirty-chip">unsaved</span> : null}
              </div>
            </div>
          </div>
          <div className="profile-form__actions">
            <button
              className="btn btn-primary"
              onClick={() => void save(true)}
              disabled={busy || isActive}
              data-testid="save-profile"
            >
              <Star size={13} /> Set active
            </button>
          </div>
        </div>

        <div className="profile-form__scroll">
          <section className="form-section">
            <div className="form-section__head">
              <span className="form-section__step">1</span>
              <div>
                <div className="form-section__title">Provider</div>
                <div className="form-section__hint">
                  Pick where requests go. Changing provider applies that provider's defaults.
                </div>
              </div>
            </div>
            <div className="provider-grid">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`provider-tile ${draft.provider === provider.id ? 'active' : ''}`}
                  onClick={() => changeProvider(provider.id)}
                  aria-pressed={draft.provider === provider.id}
                  data-testid={`provider-${provider.id}`}
                >
                  <span className="provider-tile__icon">
                    <ProviderIcon provider={provider.id} size={17} />
                  </span>
                  <span className="provider-tile__label">{provider.label}</span>
                  <span className="provider-tile__hint">{provider.hint}</span>
                </button>
              ))}
            </div>
            {meta.requiresKey && !draft.apiKey ? (
              <div className="callout callout--warn">
                <AlertCircle size={15} />
                <span>
                  {meta.label} needs an API key.
                  {meta.docsUrl ? (
                    <button
                      className="link-button"
                      onClick={() => window.open(meta.docsUrl, '_blank')}
                    >
                      Get a key
                    </button>
                  ) : null}
                </span>
              </div>
            ) : null}
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <span className="form-section__step">2</span>
              <div>
                <div className="form-section__title">Credentials</div>
                <div className="form-section__hint">
                  Keys are encrypted by the operating system and never sent to another provider.
                </div>
              </div>
            </div>
            <div className="field">
              <label htmlFor="profile-base-url">
                <Link2 size={12} /> Base URL
              </label>
              <div className="input-affix">
                <input
                  id="profile-base-url"
                  className="input"
                  value={draft.baseUrl}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                  placeholder={meta.baseUrl || 'Provider default'}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => patch({ baseUrl: meta.baseUrl })}
                  title="Reset to provider default"
                >
                  Reset
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="profile-api-key">
                <KeyRound size={12} /> API key
              </label>
              <div className="input-affix">
                <input
                  id="profile-api-key"
                  className="input"
                  type={showKey ? 'text' : 'password'}
                  value={draft.apiKey ?? ''}
                  onChange={(event) => patch({ apiKey: event.target.value })}
                  placeholder={meta.requiresKey ? 'sk-…' : 'optional'}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setShowKey((value) => !value)}
                  aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  title={showKey ? 'Hide API key' : 'Show API key'}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <div className="field-hint">
                {draft.apiKey || draft.hasApiKey ? (
                  <>
                    <CheckCircle2 size={12} /> Key set for this profile.
                  </>
                ) : meta.requiresKey ? (
                  'No key stored yet.'
                ) : (
                  'No key required for this provider.'
                )}
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <span className="form-section__step">3</span>
              <div>
                <div className="form-section__title">Model & context</div>
                <div className="form-section__hint">
                  The context window controls how much schema and history is sent.
                </div>
              </div>
            </div>
            <div className="field">
              <label htmlFor="profile-model">Model</label>
              <div className="row">
                <input
                  id="profile-model"
                  className="input"
                  value={draft.model}
                  onChange={(event) => patch({ model: event.target.value })}
                  placeholder="gpt-4o-mini"
                />
                <button className="btn" onClick={() => void loadModels()} disabled={busy}>
                  <RefreshCw size={14} /> {busy ? 'Loading…' : 'Load models'}
                </button>
              </div>
              {models.length > 0 ? (
                <div className="model-list">
                  <div className="model-list__head">
                    <span>{models.length} models available</span>
                    <span>scroll to browse</span>
                  </div>
                  <div className="model-list__scroll" role="listbox" aria-label="Available models">
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={draft.model === model.id}
                        className={`model-option ${draft.model === model.id ? 'active' : ''}`}
                        onClick={() => patch({ model: model.id })}
                      >
                        <span className="model-option__id">{model.id}</span>
                        {model.label && model.label !== model.id ? (
                          <span className="model-option__label">{model.label}</span>
                        ) : null}
                        {draft.model === model.id ? <CheckCircle2 size={13} /> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="field-hint">
                  Load models to pick from the provider list, or type a model ID above.
                </div>
              )}
            </div>
            <div className="field">
              <label>Context window</label>
              <div className="preset-row">
                {CONTEXT_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className={`preset ${draft.contextWindow === preset.value ? 'active' : ''}`}
                    onClick={() => patch({ contextWindow: preset.value })}
                  >
                    {preset.label}
                  </button>
                ))}
                <input
                  className="input preset-input"
                  type="number"
                  min={2000}
                  step={1000}
                  value={draft.contextWindow}
                  onChange={(event) => patch({ contextWindow: Number(event.target.value) })}
                  aria-label="Context window in tokens"
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="profile-max-tokens">Max output tokens</label>
                <input
                  id="profile-max-tokens"
                  className="input"
                  type="number"
                  min={64}
                  step={128}
                  value={draft.maxTokens}
                  onChange={(event) => patch({ maxTokens: Number(event.target.value) })}
                />
              </div>
              <div className="field">
                <label htmlFor="profile-timeout">Timeout (seconds)</label>
                <input
                  id="profile-timeout"
                  className="input"
                  type="number"
                  min={5}
                  step={5}
                  value={draft.timeoutSec}
                  onChange={(event) => patch({ timeoutSec: Number(event.target.value) })}
                />
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <span className="form-section__step">4</span>
              <div>
                <div className="form-section__title">Generation</div>
                <div className="form-section__hint">Lower temperature is better for SQL accuracy.</div>
              </div>
            </div>
            <div className="field">
              <label htmlFor="profile-temperature">Temperature · {draft.temperature.toFixed(2)}</label>
              <div className="range-row">
                <input
                  id="profile-temperature"
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={draft.temperature}
                  onChange={(event) => patch({ temperature: Number(event.target.value) })}
                  aria-describedby="temperature-help"
                />
                <input
                  className="input range-number"
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={draft.temperature}
                  onChange={(event) => patch({ temperature: Number(event.target.value) })}
                  aria-label="Temperature value"
                />
              </div>
              <div className="field-hint" id="temperature-help">
                0.0 deterministic · 1.0 creative · 2.0 exploratory
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <span className="form-section__step">5</span>
              <div>
                <div className="form-section__title">Behaviour</div>
                <div className="form-section__hint">What the model sees and how it answers.</div>
              </div>
            </div>
            <label className="switch-row">
              <span className={`switch ${draft.streaming ? 'is-on' : ''}`}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.streaming}
                  onChange={(event) => patch({ streaming: event.target.checked })}
                  aria-checked={draft.streaming}
                />
                <span className="switch__thumb" />
              </span>
              Stream responses
            </label>
            <label className="switch-row">
              <span className={`switch ${draft.sendSchema ? 'is-on' : ''}`}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.sendSchema}
                  onChange={(event) => patch({ sendSchema: event.target.checked })}
                  aria-checked={draft.sendSchema}
                />
                <span className="switch__thumb" />
              </span>
              Send schema context
            </label>
            <label className="switch-row">
              <span className={`switch ${draft.maskPII ? 'is-on' : ''}`}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={Boolean(draft.maskPII)}
                  onChange={(event) => patch({ maskPII: event.target.checked })}
                  aria-checked={Boolean(draft.maskPII)}
                  aria-describedby="mask-pii-help"
                  data-testid="mask-pii"
                />
                <span className="switch__thumb" />
              </span>
              Mask emails, CPF/CNPJ, cards and phone numbers in context
            </label>
            <div className="field-hint" id="mask-pii-help">
              Off by default. When on, schema and skill context are redacted before they leave
              this machine. Tradeoff: column names, defaults or comments that merely look like
              PII (long digit runs, phone-shaped values) are redacted too, which can make the
              model guess. The “Context” preview in the AI panel shows the masked text that will
              actually be sent — the schema metadata itself is still sent to the provider when
              “Send schema context” is on.
            </div>
            <div className="field">
              <label htmlFor="profile-instructions">Custom instructions</label>
              <textarea
                id="profile-instructions"
                className="textarea"
                value={draft.systemPrompt ?? ''}
                onChange={(event) => patch({ systemPrompt: event.target.value })}
                placeholder="Prefer explicit JOINs. Use snake_case aliases. Explain indexes when relevant."
              />
              <div className="field-hint">{(draft.systemPrompt ?? '').length} characters</div>
            </div>
          </section>

          <details className="advanced">
            <summary>Advanced</summary>
            <div className="advanced__body">
              <div className="kv-row">
                <span>Profile ID</span>
                <code>{draft.id || 'not saved yet'}</code>
              </div>
              <div className="kv-row">
                <span>Provider defaults</span>
                <code>{meta.baseUrl || 'provider default'}</code>
              </div>
              {meta.docsUrl ? (
                <button className="btn btn-ghost btn-sm" onClick={() => window.open(meta.docsUrl, '_blank')}>
                  Open provider console
                </button>
              ) : null}
            </div>
          </details>
        </div>

        {message ? (
          <div className={`notice ${messageKind === 'error' ? 'notice--error' : ''}`} role="status">
            {messageKind === 'error' ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
            <span>{message}</span>
          </div>
        ) : null}

        <div className="profile-form__foot">
          <button
            className={`btn btn-danger ${confirmDelete ? 'is-armed' : ''}`}
            onClick={() => void remove()}
            disabled={!draft.id || profiles.length <= 1 || busy}
            data-testid="delete-profile"
          >
            <Trash2 size={14} /> {confirmDelete ? 'Confirm delete' : 'Delete'}
          </button>
          <button className="btn" onClick={duplicate} disabled={busy || !draft.name.trim()}>
            <Copy size={14} /> Duplicate
          </button>
          <div className="grow" />
          <button className="btn" onClick={() => void loadModels()} disabled={busy}>
            <RefreshCw size={14} /> Test & load models
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save(false)}
            disabled={busy || !draft.name.trim() || !draft.model.trim()}
          >
            Save profile
          </button>
        </div>
      </div>
    </div>
  )
}
