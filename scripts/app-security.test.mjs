/**
 * Renderer boundary test.
 *
 * The preload bridge is available to every document loaded in the app window,
 * so navigation and external-link handling are security boundaries. These
 * checks exercise the policy directly and assert that the window applies it.
 *
 * Run with `npm run test:security`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { isAllowedAppNavigation, isAllowedExternalUrl } = await import(
  '../src/main/navigation.ts'
)

const results = []
function check(name, fn) {
  results.push({ name, run: fn })
}

const APP_URL = 'file:///C:/Program%20Files/DBLion/resources/app/out/renderer/index.html'

check('external links are limited to http, https and mailto', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/docs'), true)
  assert.equal(isAllowedExternalUrl('http://localhost:11434'), true)
  assert.equal(isAllowedExternalUrl('mailto:security@example.com'), true)

  assert.equal(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe'), false)
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isAllowedExternalUrl('ms-msdt:/id'), false)
  assert.equal(isAllowedExternalUrl('smb://server/share'), false)
  assert.equal(isAllowedExternalUrl('not a url'), false)
})

check('the window may only navigate to its own document', () => {
  assert.equal(isAllowedAppNavigation(APP_URL, APP_URL), true)
  assert.equal(isAllowedAppNavigation(`${APP_URL}#section`, APP_URL), true)

  assert.equal(isAllowedAppNavigation('file:///C:/Windows/Temp/evil.html', APP_URL), false)
  assert.equal(isAllowedAppNavigation('file:///C:/Program%20Files/DBLion/other.html', APP_URL), false)
  assert.equal(isAllowedAppNavigation('https://evil.example/', APP_URL), false)
  assert.equal(isAllowedAppNavigation('javascript:alert(1)', APP_URL), false)
})

check('the dev server origin is allowed, look-alike origins are not', () => {
  const dev = 'http://localhost:5173/'
  assert.equal(isAllowedAppNavigation('http://localhost:5173/index.html', APP_URL, dev), true)
  assert.equal(isAllowedAppNavigation('http://localhost:5173.evil.example/', APP_URL, dev), false)
  assert.equal(isAllowedAppNavigation('http://localhost:5174/', APP_URL, dev), false)
  assert.equal(isAllowedAppNavigation(APP_URL, APP_URL, dev), true)
})

check('the window applies the policy and keeps renderer isolation', async () => {
  const main = await fs.readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')

  assert.match(main, /sandbox:\s*true/, 'sandbox is on')
  assert.match(main, /contextIsolation:\s*true/, 'context isolation is on')
  assert.match(main, /nodeIntegration:\s*false/, 'node integration is off')
  assert.match(main, /setPermissionRequestHandler/, 'permission requests are handled')
  assert.match(main, /isAllowedExternalUrl\(url\)/, 'external URLs are filtered before openExternal')
  assert.match(main, /will-redirect/, 'redirects are checked too')
  assert.match(
    main,
    /isAllowedAppNavigation\(url, rendererUrl, process\.env\.ELECTRON_RENDERER_URL\)/,
    'navigation uses the computed app URL'
  )
  assert.match(main, /pathToFileURL\(rendererFile\)/, 'the app URL is derived from the loaded file')
  assert.doesNotMatch(main, /url\.startsWith\('file:\/\/'\)/, 'file: navigation is no longer blanket-allowed')
})

check('themes keep the token contract and unique ids', async () => {
  const { THEMES } = await import('../src/renderer/src/themes.ts')
  const keys = [
    'bg', 'panel', 'surface', 'surface2', 'border', 'borderStrong', 'text',
    'muted', 'accent', 'accent2', 'green', 'red', 'yellow', 'shadow'
  ]
  assert.ok(THEMES.length >= 14, `expected at least 14 themes, found ${THEMES.length}`)
  const ids = new Set()
  for (const theme of THEMES) {
    assert.ok(!ids.has(theme.id), `duplicate theme id ${theme.id}`)
    ids.add(theme.id)
    assert.ok(theme.mode === 'dark' || theme.mode === 'light', `${theme.id} mode`)
    for (const key of keys) {
      const value = theme.colors[key]
      assert.ok(typeof value === 'string' && value.length > 0, `${theme.id}.${key} is missing`)
      if (key !== 'shadow') {
        assert.match(value, /^#[0-9a-f]{6}$/i, `${theme.id}.${key} must be a hex colour`)
      }
    }
    assert.match(theme.colors.shadow, /^rgba\(/, `${theme.id}.shadow must be rgba`)
  }
  for (const id of ['gruvbox', 'rose-pine', 'one-dark', 'solarized-light']) {
    assert.ok(ids.has(id), `missing theme ${id}`)
  }
})

check('AI mode labels start with a capital letter', async () => {
  const topBar = await fs.readFile(
    path.join(projectRoot, 'src', 'renderer', 'src', 'components', 'TopBar.tsx'),
    'utf8'
  )
  assert.match(topBar, /label: 'Read'/)
  assert.match(topBar, /label: 'Edit'/)
  assert.match(topBar, /label: 'Full'/)
  assert.doesNotMatch(topBar, /label: 'read'/)
  assert.doesNotMatch(topBar, /label: 'edit'/)
})

check('closing the window asks for a themed confirmation', async () => {
  const main = await fs.readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')
  assert.match(main, /window\.on\('close'/, 'the close event is intercepted')
  assert.match(main, /event\.preventDefault\(\)/, 'the window does not close immediately')
  assert.match(main, /app:close-requested/, 'the renderer is asked to confirm')
  assert.match(main, /app:close-response/, 'the answer comes back from the renderer')
  assert.match(main, /state\.allow = true/, 'only a positive answer allows the close')
  assert.match(main, /render-process-gone/, 'a crashed renderer cannot trap the app')

  const preload = await fs.readFile(path.join(projectRoot, 'src', 'preload', 'index.ts'), 'utf8')
  assert.match(preload, /onCloseRequested/)
  assert.match(preload, /respondToClose/)

  const app = await fs.readFile(path.join(projectRoot, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.match(app, /onCloseRequested\(/)
  assert.match(app, /Close DBLion\?/)
  assert.match(app, /modal--close/)
  assert.match(app, /btn btn-danger/)
})

check('disconnect and delete use the themed confirmation', async () => {
  const app = await fs.readFile(path.join(projectRoot, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.match(app, /ConfirmDialog/)
  assert.match(app, /requestDisconnect/)
  assert.match(app, /requestDeleteConnection/)
  assert.match(app, /settings\?\.skipDisconnectConfirm/)

  const dialog = await fs.readFile(
    path.join(projectRoot, 'src', 'renderer', 'src', 'components', 'ConfirmDialog.tsx'),
    'utf8'
  )
  assert.match(dialog, /role="alertdialog"/)
  assert.match(dialog, /Don't ask again for disconnects/)
  assert.match(dialog, /confirm-check/)
  assert.match(dialog, /btn-danger/)

  const settings = await fs.readFile(
    path.join(projectRoot, 'src', 'renderer', 'src', 'components', 'SettingsModal.tsx'),
    'utf8'
  )
  assert.match(settings, /skipDisconnectConfirm/)
})

check('Explain is disabled without SQL in the editor', async () => {
  const editor = await fs.readFile(
    path.join(projectRoot, 'src', 'renderer', 'src', 'components', 'SqlEditor.tsx'),
    'utf8'
  )
  assert.match(editor, /disabled=\{!profile \|\| !value\.trim\(\)\}/)

  const app = await fs.readFile(path.join(projectRoot, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.match(app, /const target = \(selected \|\| sql\)\.trim\(\)/)
  assert.match(app, /if \(!target\) return/)
})

let failed = 0
let passed = 0
for (const { name, run } of results) {
  try {
    await run()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

console.log(`\n${passed}/${passed + failed} renderer-boundary checks passed`)
if (failed > 0) process.exitCode = 1
