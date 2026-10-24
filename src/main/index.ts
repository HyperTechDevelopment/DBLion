import { app, BrowserWindow, ipcMain, shell, type Event as ElectronEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { isAllowedAppNavigation, isAllowedExternalUrl } from './navigation'

interface CloseState {
  allow: boolean
  prompted: boolean
}

/**
 * Close is a two-step flow: the window asks the renderer to show the themed
 * confirmation, and only a positive answer (or a dead renderer) lets the window
 * close. `allow` disables the guard for the second close attempt.
 */
const closeStates = new WeakMap<BrowserWindow, CloseState>()

/** Packaged builds get the icon from extraResources; dev reads it from the repo root. */
const appIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '../../icon.ico')

ipcMain.on('app:close-response', (event, confirmed: boolean) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  const state = closeStates.get(window)
  if (!state) return
  state.prompted = false
  if (confirmed) {
    state.allow = true
    window.close()
  }
})

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#11111b',
    title: 'DBLion',
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window.show())

  const closeState: CloseState = { allow: false, prompted: false }
  closeStates.set(window, closeState)
  window.on('close', (event) => {
    // A crashed renderer has no dialog to answer, so it must not trap the app.
    if (closeState.allow || window.webContents.isDestroyed()) return
    event.preventDefault()
    if (closeState.prompted) return
    closeState.prompted = true
    window.webContents.send('app:close-requested')
  })
  window.webContents.on('render-process-gone', () => {
    closeState.allow = true
    if (!window.isDestroyed()) window.close()
  })

  const rendererFile = path.join(__dirname, '../renderer/index.html')
  const rendererUrl = pathToFileURL(rendererFile).href

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Only protocols a browser can handle. A file: or custom scheme here would
    // invoke an OS handler (or load a local document with the preload bridge).
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const blockUnexpectedNavigation = (event: ElectronEvent, url: string): void => {
    // The preload bridge is attached to every document loaded in this window,
    // so only the app's own file may be navigated to.
    if (!isAllowedAppNavigation(url, rendererUrl, process.env.ELECTRON_RENDERER_URL)) {
      event.preventDefault()
    }
  }
  window.webContents.on('will-navigate', blockUnexpectedNavigation)
  window.webContents.on('will-redirect', blockUnexpectedNavigation)

  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })

  if (process.env.DBLION_DEBUG) {
    window.webContents.on('console-message', (_event, _level, message) => {
      console.log('[renderer]', message)
    })
    window.webContents.on('did-fail-load', (_event, code, description) => {
      console.error('[did-fail-load]', code, description)
    })
  }

  if (process.env.DBLION_SELFTEST) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        const base = process.env.DBLION_SELFTEST as string
        const settle = async (): Promise<void> => {
          await window.webContents.executeJavaScript(
            `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
          )
          await delay(160)
        }
        const capture = async (suffix: string): Promise<void> => {
          await settle()
          await fs.writeFile(`${base}-${suffix}.png`, (await window.webContents.capturePage()).toPNG())
        }
        const log = async (message: string): Promise<void> => {
          await fs.appendFile(`${base}-log.txt`, `${message}\n`)
        }
        try {
          await delay(2600)
          await capture('main')
          const sandboxed = (
            window.webContents as unknown as {
              getLastWebPreferences?: () => { sandbox?: boolean }
            }
          ).getLastWebPreferences?.()?.sandbox
          const publicState = await window.webContents.executeJavaScript(
            `window.dblion.getState().then((state) => ({ passwords: state.connections.filter((item) => item.password).length, keys: state.profiles.filter((item) => item.apiKey).length }))`
          )
          await log(`sandbox: ${sandboxed}`)
          await log(`public state secrets: ${JSON.stringify(publicState)}`)
          // Temporary paths only: never embed the developer's home or project path.
          const selftestDb = JSON.stringify(
            path.join(app.getPath('temp'), 'dblion-selftest-6000.db')
          )
          const selftestDiffDb = JSON.stringify(
            path.join(app.getPath('temp'), 'dblion-selftest-6000-b.db')
          )
          const sqliteLimit = await window.webContents.executeJavaScript(`
            (async () => {
              try {
              const file = ${selftestDb};
              const state = await window.dblion.saveConnection({
                id: '', name: 'Limit test', kind: 'sqlite', file
              });
              const connection = state.connections.find((item) => item.name === 'Limit test');
              if (!connection) return { error: 'connection not found' };
              const state2 = await window.dblion.saveConnection({
                id: '', name: 'Diff test', kind: 'sqlite',
                file: ${selftestDiffDb}
              });
              const diffConnection = state2.connections.find((item) => item.name === 'Diff test');
              if (!diffConnection) return { error: 'diff connection not found' };
              const connected = await window.dblion.connect(connection.id);
              await window.dblion.connect(diffConnection.id);
              const result = await window.dblion.query(connection.id, 'select * from big', [], false);
              const page = await window.dblion.tablePage({
                connectionId: connection.id, table: 'big', limit: 10, offset: 0
              });
              const first = page.rows[0];
              const preview = await window.dblion.previewRowUpdate({
                connectionId: connection.id,
                table: 'big',
                identity: { id: first.id },
                changes: { value: 'edited' },
                expected: { value: first.value },
                allowWrites: true
              });
              const plan = await window.dblion.explain({
                connectionId: connection.id,
                sql: 'select * from big where id > 10',
                analyze: false
              });
              const csvPreview = await window.dblion.previewCsvImport({
                connectionId: connection.id,
                table: 'big',
                csvText: 'id,value\\n7001,csv-row-1\\n7002,csv-row-2\\n',
                mapping: {},
                hasHeader: true,
                allowWrites: true
              });
              let dangerousBlocked = false;
              try {
                await window.dblion.query(connection.id, 'select pg_sleep(1)', [], false);
              } catch {
                dangerousBlocked = true;
              }
              let dangerousExplainBlocked = false;
              try {
                await window.dblion.explain({
                  connectionId: connection.id, sql: 'select pg_sleep(1)', analyze: false
                });
              } catch {
                dangerousExplainBlocked = true;
              }
              const literalResult = await window.dblion.query(
                connection.id, "select 'pg_sleep(1)' as text", [], false
              );
              const catalog = await window.dblion.schemaCatalog(connection.id);
              const tableDdl = await window.dblion.objectDdl(connection.id, {
                name: 'big', type: 'table'
              });
              const diff = await window.dblion.diffSchemas(connection.id, diffConnection.id);
              const savedMigration = await window.dblion.saveMigration({
                name: 'selftest-diff', sql: diff.migrationSql, dialect: 'sqlite'
              });
              const migrations = await window.dblion.listMigrations();
              await window.dblion.transaction(connection.id, 'begin');
              await window.dblion.transaction(connection.id, 'commit');
              await window.dblion.disconnect(connection.id);
              await window.dblion.disconnect(diffConnection.id);
              await window.dblion.deleteConnection(connection.id);
              await window.dblion.deleteConnection(diffConnection.id);
              return {
                ok: connected.ok,
                rows: result.rows.length,
                truncated: result.truncated,
                rowCount: result.rowCount,
                pageRows: page.rows.length,
                pageColumns: page.columns.length,
                editable: page.editable,
                previewSql: preview.sql,
                previewWarningCount: preview.warnings.length,
                planRoots: plan.roots.length,
                planOperation: plan.roots[0]?.operation,
                planWarnings: plan.warnings.length,
                csvRows: csvPreview.rowCount,
                csvColumns: csvPreview.columns,
                csvWarnings: csvPreview.warnings.length,
                catalogObjects: catalog.objects.length,
                ddlBytes: tableDdl.sql.length,
                diffRows: diff.rows.length,
                diffAdded: diff.rows.filter((row) => row.status === 'added').length,
                migrationSaved: savedMigration.name,
                migrationCount: migrations.length,
                dangerousBlocked,
                dangerousExplainBlocked,
                literalAllowed: literalResult.rows[0]?.text === 'pg_sleep(1)'
              };
              } catch (error) {
                return {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined
                };
              }
            })()
          `)
          await log(`sqlite server limit: ${JSON.stringify(sqliteLimit)}`)
          const auditEntries = await window.webContents.executeJavaScript(
            `window.dblion.auditList(20).then((entries) => entries.length)`
          )
          await log(`audit entries: ${auditEntries}`)
          await window.webContents.executeJavaScript(
            `document.querySelector('.query-tab-add')?.click(); true`
          )
          await delay(450)
          const queryTabCount = await window.webContents.executeJavaScript(
            `document.querySelectorAll('.query-tab').length`
          )
          await log(`query tabs after add: ${queryTabCount}`)
          await capture('query-tabs')
          await window.webContents.executeJavaScript(
            `document.querySelectorAll('.query-tab')[0]?.click(); true`
          )
          await delay(350)
          const activeQueryTab = await window.webContents.executeJavaScript(
            `document.querySelector('.query-tab.active .query-tab__title')?.textContent || ''`
          )
          await log(`active query tab: ${activeQueryTab}`)
          await window.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('History'))?.click(); true`
          )
          await delay(500)
          const historyPanel = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.query-history'))`
          )
          await log(`history panel: ${historyPanel}`)
          await capture('query-history')
          await window.webContents.executeJavaScript(
            `document.querySelector('.query-history [aria-label="Close history"]')?.click(); true`
          )
          await window.webContents.executeJavaScript(
            `window.dblion.addQueryHistory({ sql: 'select 42 as answer', connectionName: 'selftest', durationMs: 12, rowCount: 1, source: 'editor' }).then(() => true)`
          )
          const historyCount = await window.webContents.executeJavaScript(
            `window.dblion.getState().then((state) => state.queryHistory.length)`
          )
          await log(`persisted history entries: ${historyCount}`)
          await window.webContents.executeJavaScript(
            `window.dblion.clearQueryHistory().then(() => true)`
          )
          await window.webContents.executeJavaScript(
            `document.querySelector('.theme-pill--button')?.click(); true`
          )
          await delay(500)
          await capture('theme-menu')
          await window.webContents.executeJavaScript(
            `document.querySelector('.theme-menu__item.active')?.click(); true`
          )
          await delay(500)
          const settingsFound = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('[aria-label="Open settings"]'))`
          )
          await log(`settings button: ${settingsFound}`)
          await window.webContents.executeJavaScript(
            `document.querySelector('[aria-label="Open settings"]')?.click(); true`
          )
          await delay(1800)
          const modalFound = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.modal--settings'))`
          )
          await log(`settings modal: ${modalFound}`)
          await capture('ai')
          const modelOptions = await window.webContents.executeJavaScript(
            `document.querySelectorAll('.model-option').length`
          )
          await log(`model options: ${modelOptions}`)
          await window.webContents.executeJavaScript(
            `document.querySelector('#profile-model')?.scrollIntoView({ block: 'center' }); true`
          )
          await delay(500)
          await capture('ai-models')
          await window.webContents.executeJavaScript(
            `document.querySelector('.profile-form__scroll')?.scrollTo({ top: 99999 }); true`
          )
          await delay(700)
          await capture('ai-behaviour')
          await window.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Skills')?.click()`
          )
          await delay(1400)
          await capture('skills')
          await window.webContents.executeJavaScript(
            `document.querySelector('button[aria-label="Close settings"]')?.click()`
          )
          await delay(800)
          const modalAfterClose = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.modal--settings'))`
          )
          await log(`settings modal after close: ${modalAfterClose}`)
          const typeInComposer = (value: string): string => `
            (() => {
              const el = document.querySelector('[data-testid="chat-input"]');
              if (!el) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
              setter.call(el, ${JSON.stringify(value)});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.focus();
              return true;
            })()
          `
          await window.webContents.executeJavaScript(typeInComposer('/'))
          await delay(1000)
          const slashOpen = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.slash-menu'))`
          )
          await log(`slash menu open: ${slashOpen}`)
          await capture('slash')
          await window.webContents.executeJavaScript(typeInComposer('/sql'))
          await delay(900)
          await capture('slash-filter')

          await window.webContents.executeJavaScript(
            `document.querySelector('[aria-label="Open settings"]')?.click(); true`
          )
          await delay(1200)
          await window.webContents.executeJavaScript(
            `document.querySelector('[data-testid="provider-anthropic"]')?.click(); true`
          )
          await delay(400)
          await window.webContents.executeJavaScript(
            `document.querySelector('[data-testid="save-profile"]')?.click(); true`
          )
          await delay(1400)
          const profileCount = await window.webContents.executeJavaScript(
            `document.querySelectorAll('[data-testid="profile-card"]').length`
          )
          await log(`profile cards: ${profileCount}`)
          const secretRedaction = await window.webContents.executeJavaScript(`
            (async () => {
              const before = await window.dblion.getState();
              const profile = before.profiles[0];
              if (!profile) return null;
              await window.dblion.saveProfile({ ...profile, apiKey: 'sk-selftest-secret' });
              const after = await window.dblion.getState();
              return {
                keys: after.profiles.filter((item) => item.apiKey).length,
                hasKeys: after.profiles.filter((item) => item.hasApiKey).length,
                keyType: typeof after.profiles[0]?.apiKey
              };
            })()
          `)
          await log(`secret redaction: ${JSON.stringify(secretRedaction)}`)
          await capture('profile-saved')
          await window.webContents.executeJavaScript(
            `document.querySelector('[aria-label="Close settings"]')?.click(); true`
          )
          await delay(700)
          await capture('main-profile')
          const chatModel = await window.webContents.executeJavaScript(
            `document.querySelector('.ai-model-select')?.value || ''`
          )
          await log(`chat model selector: ${chatModel}`)

          await window.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New connection')?.click(); true`
          )
          await delay(1200)
          const connectionModal = await window.webContents.executeJavaScript(
            `Boolean(document.querySelector('.modal--connection'))`
          )
          await log(`connection modal: ${connectionModal}`)
          const activeStep = `document.querySelector('.wizard-step.active .wizard-step__label')?.textContent || ''`
          const stepTitle = `document.querySelector('.wizard-section__head h3')?.textContent || ''`
          await log(`connection initial step: ${await window.webContents.executeJavaScript(activeStep)}`)
          await log(`connection selected engine: ${await window.webContents.executeJavaScript(
            `document.querySelector('.engine-card.active .engine-card__label')?.textContent || ''`
          )}`)
          await capture('connection-engine')

          const clickNext = `([...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Next'))?.click(), true)`
          await window.webContents.executeJavaScript(clickNext)
          await delay(1300)
          await log(`connection step after first next: ${await window.webContents.executeJavaScript(activeStep)}`)
          await capture('connection-general')
          await window.webContents.executeJavaScript(`
            (() => {
              const el = document.querySelector('#connection-host');
              if (!el) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(el, 'localhost');
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            })()
          `)
          await delay(500)
          await window.webContents.executeJavaScript(clickNext)
          await delay(1300)
          await log(`connection step after second next: ${await window.webContents.executeJavaScript(activeStep)}`)
          await capture('connection-options')
          await window.webContents.executeJavaScript(clickNext)
          await delay(1300)
          await log(`connection step after third next: ${await window.webContents.executeJavaScript(activeStep)}`)
          await log(`connection review title: ${await window.webContents.executeJavaScript(stepTitle)}`)
          const reviewText = await window.webContents.executeJavaScript(
            `document.querySelector('.wizard-content')?.innerText || ''`
          )
          await log(`connection review content: ${String(reviewText).replace(/\\s+/g, ' ').slice(0, 1200)}`)
          await window.webContents.executeJavaScript(`window.confirm = () => true; true`)
          await window.webContents.executeJavaScript(
            `document.querySelector('[aria-label="Close dialog"]')?.click(); true`
          )
          console.log('[selftest] written', base)
        } catch (error) {
          console.error('[selftest-error]', error)
          await fs
            .appendFile(`${base}-log.txt`, `error: ${error instanceof Error ? error.stack : String(error)}\n`)
            .catch(() => undefined)
        }
      }, 500)
    })
  }

  if (process.env.DBLION_SCREENSHOT) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await window.webContents.capturePage()
          await fs.writeFile(process.env.DBLION_SCREENSHOT as string, image.toPNG())
          console.log('[screenshot]', process.env.DBLION_SCREENSHOT)
        } catch (error) {
          console.error('[screenshot-error]', error)
        }
      }, 2500)
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(rendererFile)
  }
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.dblion.app')
  }
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // An OS-driven quit must not wait for a dialog.
  for (const window of BrowserWindow.getAllWindows()) {
    const state = closeStates.get(window)
    if (state) state.allow = true
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
