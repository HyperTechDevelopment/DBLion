import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Database,
  Palette,
  PanelRight,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import type { AIMode, ConnectionConfig } from '@shared/types'
import { accessModeLabel, accessModeOf, isReadOnlyAccess, readOnlyEnforcementNote } from '@shared/access'
import { THEMES } from '../themes'
import brandIcon from '../assets/icon.ico'

interface Props {
  connections: ConnectionConfig[]
  activeConnectionId?: string
  connected: Record<string, boolean>
  theme: string
  aiVisible: boolean
  aiMode: AIMode
  onConnectionChange: (id: string) => void
  onThemeChange: (theme: string) => void
  onAiModeChange: (mode: AIMode) => void
  onToggleAi: () => void
  onOpenSettings: () => void
}

const MODES: { id: AIMode; label: string; hint: string }[] = [
  { id: 'read', label: 'Read', hint: 'Block every write' },
  { id: 'edit', label: 'Edit', hint: 'DML with confirmation' },
  { id: 'full', label: 'Full', hint: 'DDL and destructive tools' }
]

export default function TopBar({
  connections,
  activeConnectionId,
  connected,
  theme,
  aiVisible,
  aiMode,
  onConnectionChange,
  onThemeChange,
  onAiModeChange,
  onToggleAi,
  onOpenSettings
}: Props) {
  const isLive = activeConnectionId ? connected[activeConnectionId] : false
  const activeConnection = connections.find((connection) => connection.id === activeConnectionId)
  const [themeOpen, setThemeOpen] = useState(false)
  const themeRef = useRef<HTMLDivElement | null>(null)
  const activeTheme = THEMES.find((item) => item.id === theme) ?? THEMES[0]

  useEffect(() => {
    if (!themeOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!themeRef.current?.contains(event.target as Node)) setThemeOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setThemeOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [themeOpen])

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="brand-mark" aria-hidden="true">
          <img src={brandIcon} alt="" draggable={false} />
        </span>
        <div className="brand-copy">
          <div className="logo">
            DB<span>Lion</span>
          </div>
          <span className="brand-sub">AI database studio</span>
        </div>
      </div>

      <div className="topbar__context">
        <div className={`connection-pill ${isLive ? 'is-live' : ''}`}>
          <Database size={15} />
          <select
            className="connection-select"
            value={activeConnectionId ?? ''}
            onChange={(event) => onConnectionChange(event.target.value)}
            aria-label="Active database connection"
          >
            <option value="">Select a connection…</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} · {connection.kind}
              </option>
            ))}
          </select>
          <span className={`state-dot ${isLive ? 'is-on' : ''}`} aria-hidden="true" />
          <span className="connection-state">{isLive ? 'live' : 'offline'}</span>
        </div>
        {activeConnection ? (
          <span
            className={`access-badge ${isReadOnlyAccess(activeConnection) ? 'access-badge--ro' : 'access-badge--rw'}`}
            title={
              isReadOnlyAccess(activeConnection)
                ? `Read-only connection. ${readOnlyEnforcementNote(activeConnection.kind)}`
                : `Read-write connection. ${readOnlyEnforcementNote(activeConnection.kind)} Writes still need the toolbar toggle, AI mode and a native confirmation.`
            }
          >
            <ShieldCheck size={12} />
            {accessModeLabel(accessModeOf(activeConnection))}
          </span>
        ) : null}
        {activeConnection ? (
          <span className="topbar__hint">
            <Sparkles size={12} />
            {activeConnection.kind}
          </span>
        ) : null}
      </div>

      <div className="topbar__actions">
        <div className={`mode-switch mode-switch--${aiMode}`} role="group" aria-label="AI permission mode">
          <ShieldAlert size={14} />
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={aiMode === item.id ? 'active' : ''}
              aria-pressed={aiMode === item.id}
              title={`${item.label}: ${item.hint}`}
              onClick={() => onAiModeChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="theme-picker" ref={themeRef}>
          <button
            type="button"
            className="theme-pill theme-pill--button"
            onClick={() => setThemeOpen((value) => !value)}
            aria-haspopup="listbox"
            aria-expanded={themeOpen}
            aria-label="Theme"
            title="Theme"
          >
            <Palette size={14} />
            <span className="theme-pill__label">{activeTheme.label}</span>
            <ChevronDown size={12} className={themeOpen ? 'rotated' : ''} />
          </button>
          {themeOpen ? (
            <div className="theme-menu" role="listbox" aria-label="Theme">
              {THEMES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === theme}
                  className={`theme-menu__item ${item.id === theme ? 'active' : ''}`}
                  onClick={() => {
                    onThemeChange(item.id)
                    setThemeOpen(false)
                  }}
                >
                  <span className="theme-swatches">
                    <span className="theme-swatch" style={{ background: item.colors.bg }} />
                    <span className="theme-swatch" style={{ background: item.colors.panel }} />
                    <span className="theme-swatch" style={{ background: item.colors.accent }} />
                    <span className="theme-swatch" style={{ background: item.colors.accent2 }} />
                    <span className="theme-swatch" style={{ background: item.colors.green }} />
                  </span>
                  <span className="theme-menu__copy">
                    <strong>{item.label}</strong>
                    <small>{item.mode}</small>
                  </span>
                  {item.id === theme ? <Check size={13} /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button
          className={`icon-btn ${aiVisible ? 'is-active' : ''}`}
          onClick={onToggleAi}
          title={aiVisible ? 'Hide AI panel' : 'Show AI panel'}
          aria-label={aiVisible ? 'Hide AI panel' : 'Show AI panel'}
          aria-pressed={aiVisible}
        >
          <PanelRight size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Open settings"
        >
          <Settings size={17} />
        </button>
      </div>
    </header>
  )
}
