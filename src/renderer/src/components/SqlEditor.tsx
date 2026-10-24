import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Editor, { loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import {
  AlertTriangle,
  Check,
  Gauge,
  Layers,
  Network,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  TimerOff
} from 'lucide-react'
import type { AIProfile, SchemaPayload } from '@shared/types'
import { monacoThemeDefinition } from '../themes'

export interface SqlEditorHandle {
  insertText: (text: string) => void
  getSelectionText: () => string
  focus: () => void
}

loader.config({ monaco })

const KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'OUTER JOIN',
  'FULL JOIN',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'WITH',
  'AS',
  'ON',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS NULL',
  'IN',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'DISTINCT',
  'UNION',
  'UNION ALL',
  'RETURNING',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
  'INDEX',
  'EXPLAIN',
  'ANALYZE'
]

interface ColumnContext {
  table: string
  columns: string[]
}

function parseSchemaContext(context: string | undefined): ColumnContext[] {
  if (!context) return []
  const result: ColumnContext[] = []
  for (const line of context.split(/\r?\n/)) {
    const match = /^([\w."`[\]-]+)\((.+)\)\s*$/.exec(line.trim())
    if (!match) continue
    const columns = match[2]
      .split(',')
      .map((column) => column.trim().split(':')[0]?.trim())
      .filter(Boolean) as string[]
    result.push({ table: match[1].replace(/["`[\]]/g, ''), columns })
  }
  return result
}

interface Props {
  value: string
  onChange: (value: string) => void
  theme: string
  schema: SchemaPayload | null
  connectionId?: string
  profile: AIProfile | null
  aiAutocomplete: boolean
  allowWrites: boolean
  readOnlyConnection: boolean
  running: boolean
  connected: boolean
  onRun: (text?: string) => void
  onCancel: () => void
  canCancel: boolean
  onExplain: () => void
  onExplainPlan?: () => void
  explainSupported?: boolean
  onRefreshSchema: () => void
  onOpenGraph: () => void
  onToggleWrites: () => void
  canTransact: boolean
  transactionActive: boolean
  onTransaction: (action: 'begin' | 'commit' | 'rollback') => void
  sessionsSupported: boolean
  onOpenSessions: () => void
  onOpenSchemaTools: () => void
}

const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor({
  value,
  onChange,
  theme,
  schema,
  connectionId,
  profile,
  aiAutocomplete,
  allowWrites,
  readOnlyConnection,
  running,
  connected,
  onRun,
  onCancel,
  canCancel,
  onExplain,
  onExplainPlan,
  explainSupported,
  onRefreshSchema,
  onOpenGraph,
  onToggleWrites,
  canTransact,
  transactionActive,
  onTransaction,
  sessionsSupported,
  onOpenSessions,
  onOpenSchemaTools
}, ref) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const schemaRef = useRef(schema)
  const connectionIdRef = useRef(connectionId)
  const profileRef = useRef(profile)
  const aiAutocompleteRef = useRef(aiAutocomplete)
  const onRunRef = useRef(onRun)
  const onExplainRef = useRef(onExplain)
  const completionRef = useRef<monaco.IDisposable | null>(null)
  const inlineRef = useRef<monaco.IDisposable | null>(null)

  schemaRef.current = schema
  connectionIdRef.current = connectionId
  profileRef.current = profile
  aiAutocompleteRef.current = aiAutocomplete
  onRunRef.current = onRun
  onExplainRef.current = onExplain

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      const editor = editorRef.current
      if (!editor) return
      const selection = editor.getSelection()
      if (!selection) return
      const model = editor.getModel()
      const current = model?.getValue() ?? ''
      const separator = current.trim().length > 0 ? '\n\n' : ''
      editor.executeEdits('dblion-insert', [
        {
          range: selection,
          text: `${separator}${text.trim()}\n`,
          forceMoveMarkers: true
        }
      ])
      editor.focus()
    },
    getSelectionText() {
      const editor = editorRef.current
      const model = editor?.getModel()
      const selection = editor?.getSelection()
      if (!model || !selection || selection.isEmpty()) return ''
      return model.getValueInRange(selection).trim()
    },
    focus() {
      editorRef.current?.focus()
    }
  }))

  useEffect(() => {
    monaco.editor.defineTheme(`dblion-${theme}`, monacoThemeDefinition(theme))
    monaco.editor.setTheme(`dblion-${theme}`)
  }, [theme])

  useEffect(() => {
    return () => {
      completionRef.current?.dispose()
      inlineRef.current?.dispose()
    }
  }, [])

  function runCurrent(): void {
    const editor = editorRef.current
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    const selected =
      model && selection && !selection.isEmpty() ? model.getValueInRange(selection).trim() : ''
    onRunRef.current(selected || undefined)
  }

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    monaco.editor.defineTheme(`dblion-${theme}`, monacoThemeDefinition(theme))
    monaco.editor.setTheme(`dblion-${theme}`)

    editor.addAction({
      id: 'dblion.run-query',
      label: 'DBLion: Run query',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => runCurrent()
    })
    editor.addAction({
      id: 'dblion.explain-query',
      label: 'DBLion: Explain with AI',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => onExplainRef.current()
    })

    completionRef.current?.dispose()
    completionRef.current = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' ', ',', '('],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position)
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        }
        const currentSchema = schemaRef.current
        const columns = parseSchemaContext(currentSchema?.context)
        const textBefore = model
          .getValueInRange({
            startLineNumber: Math.max(1, position.lineNumber - 8),
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          })
          .toLowerCase()
        const dotMatch = /([\w."`[\]]+)\.\s*$/.exec(textBefore)
        const suggestions: monaco.languages.CompletionItem[] = []

        if (dotMatch) {
          const qualifier = dotMatch[1].replace(/["`[\]]/g, '').toLowerCase()
          for (const table of columns) {
            const shortName = table.table.split('.').pop()?.toLowerCase() ?? ''
            if (table.table.toLowerCase() === qualifier || shortName === qualifier) {
              for (const column of table.columns) {
                suggestions.push({
                  label: column,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: column,
                  range,
                  detail: table.table,
                  sortText: `0_${column}`
                })
              }
            }
          }
          return { suggestions }
        }

        for (const keyword of KEYWORDS) {
          suggestions.push({
            label: keyword,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: keyword,
            range,
            sortText: `3_${keyword}`
          })
        }

        for (const table of currentSchema?.tables ?? []) {
          const qualified = table.schema ? `${table.schema}.${table.name}` : table.name
          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: qualified,
            range,
            detail: table.schema ?? 'table',
            sortText: `1_${table.name}`
          })
          if (table.schema) {
            suggestions.push({
              label: table.schema,
              kind: monaco.languages.CompletionItemKind.Folder,
              insertText: table.schema,
              range,
              sortText: `2_${table.schema}`
            })
          }
        }

        for (const table of columns) {
          for (const column of table.columns) {
            suggestions.push({
              label: column,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: column,
              range,
              detail: table.table,
              sortText: `2_${column}`
            })
          }
        }

        return { suggestions }
      }
    })

    inlineRef.current?.dispose()
    const languages = monaco.languages as unknown as {
      registerInlineCompletionsProvider?: (
        language: string,
        provider: unknown
      ) => monaco.IDisposable
    }
    if (languages.registerInlineCompletionsProvider) {
      let inFlight = false
      let lastPrefix = ''
      let lastCompletion = ''
      inlineRef.current = languages.registerInlineCompletionsProvider('sql', {
        provideInlineCompletions: async (
          model: monaco.editor.ITextModel,
          position: monaco.Position,
          _context: unknown,
          token: monaco.CancellationToken
        ) => {
          const currentProfile = profileRef.current
          if (!currentProfile || !aiAutocompleteRef.current || inFlight) return { items: [] }
          const prefix = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          })
          if (prefix.trim().length < 12) return { items: [] }
          if (prefix === lastPrefix && lastCompletion) {
            return {
              items: [
                {
                  insertText: lastCompletion,
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column
                  )
                }
              ]
            }
          }
          inFlight = true
          try {
            await new Promise((resolve) => setTimeout(resolve, 750))
            if (token.isCancellationRequested) return { items: [] }
            const prompt = [
              'Complete the SQL statement below. Return only the continuation text, with no explanation and no markdown fences.',
              'Keep the same dialect and style. Do not repeat the existing prefix.',
              '',
              prefix.slice(-6000)
            ].join('\n')
            const completion = await window.dblion.complete(
              currentProfile.id,
              prompt,
              connectionIdRef.current
            )
            if (token.isCancellationRequested || !completion) return { items: [] }
            const cleaned = completion
              .replace(/^```sql\s*/i, '')
              .replace(/^```\s*/i, '')
              .replace(/```$/i, '')
              .trim()
            if (!cleaned || cleaned.length > 2000) return { items: [] }
            lastPrefix = prefix
            lastCompletion = cleaned
            return {
              items: [
                {
                  insertText: cleaned,
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column
                  )
                }
              ]
            }
          } catch {
            return { items: [] }
          } finally {
            inFlight = false
          }
        },
        freeInlineCompletions: () => undefined
      })
    }
  }

  return (
    <div className="sql-editor">
      <div className="toolbar">
        <div className="toolbar__group">
          <button
            className="btn btn-primary"
            onClick={runCurrent}
            disabled={running || !connected}
            aria-label="Run query"
          >
            <Play size={14} /> Run
            <span className="kbd">Ctrl↵</span>
          </button>
          <button
            className="btn"
            onClick={onExplain}
            disabled={!profile || !value.trim()}
            title={
              !profile
                ? 'Select an AI profile first'
                : !value.trim()
                  ? 'Write or select SQL to explain'
                  : 'Explain the current SQL with AI'
            }
          >
            <Sparkles size={14} /> Explain
          </button>
          {onExplainPlan ? (
            <button
              className="btn"
              onClick={onExplainPlan}
              disabled={!connected || !explainSupported}
              title={
                explainSupported
                  ? 'Run EXPLAIN in the database (no AI)'
                  : 'This connection does not support EXPLAIN'
              }
            >
              <Gauge size={14} /> Plan
            </button>
          ) : null}
          {running && canCancel ? (
            <button className="btn btn-danger" onClick={onCancel} title="Cancel the running query">
              <Square size={13} /> Stop
            </button>
          ) : null}
        </div>
        {canTransact ? (
          <div className="toolbar__group">
            {transactionActive ? (
              <>
                <span className="chip chip--soft">TX</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => onTransaction('commit')}
                  title="Commit transaction"
                >
                  <Check size={13} /> Commit
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => onTransaction('rollback')}
                  title="Rollback transaction"
                >
                  <RotateCcw size={13} /> Rollback
                </button>
              </>
            ) : (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onTransaction('begin')}
                title="Begin an explicit transaction"
              >
                <Play size={13} /> Begin
              </button>
            )}
          </div>
        ) : null}
        {sessionsSupported ? (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onOpenSessions}
            disabled={!connected}
            title="List database sessions and cancel/kill queries"
          >
            <TimerOff size={13} /> Sessions
          </button>
        ) : null}
        <div className="toolbar__divider" />
        <div className="toolbar__group">
          <button className="btn btn-ghost" onClick={onRefreshSchema} disabled={!connected}>
            <RefreshCw size={14} /> Schema
          </button>
          <button className="btn btn-ghost" onClick={onOpenSchemaTools} disabled={!connected}>
            <Layers size={14} /> Catalog
          </button>
          <button className="btn btn-ghost" onClick={onOpenGraph} disabled={!connected}>
            <Network size={14} /> ER graph
          </button>
        </div>
        <div className="toolbar__spacer" />
        {readOnlyConnection ? (
          <span
            className="access-badge"
            title="This connection is read-only. Writes are rejected in the main process, not only here."
          >
            <ShieldCheck size={12} /> Read-only connection
          </span>
        ) : (
          <label
            className="switch-row"
            title="Allow write statements. Each write still asks for native confirmation."
          >
            <span className={`switch ${allowWrites ? 'is-on' : ''}`}>
              <input
                type="checkbox"
                role="switch"
                checked={allowWrites}
                onChange={onToggleWrites}
                aria-checked={allowWrites}
                aria-label="Allow writes"
              />
              <span className="switch__thumb" />
            </span>
            Writes
          </label>
        )}
      </div>
      {!readOnlyConnection && allowWrites ? (
        <div className="risk-banner" role="status">
          <AlertTriangle size={14} />
          <span>
            Writes enabled. Every write statement asks for native confirmation before execution.
          </span>
        </div>
      ) : null}
      <div className="editor-wrap">
        <Editor
          height="100%"
          defaultLanguage="sql"
          value={value}
          onChange={(next) => onChange(next ?? '')}
          onMount={handleMount}
          theme={`dblion-${theme}`}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 22,
            fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
            fontLigatures: true,
            wordWrap: 'on',
            automaticLayout: true,
            padding: { top: 16, bottom: 16 },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            renderLineHighlight: 'line',
            bracketPairColorization: { enabled: true },
            guides: { indentation: true },
            stickyScroll: { enabled: false },
            inlineSuggest: { enabled: true },
            suggest: { showWords: false }
          }}
        />
      </div>
    </div>
  )
})

export default SqlEditor
