// Resolves the `@shared/*` TS path alias (see electron.vite.config.ts) and the
// extensionless relative imports used across src/ for plain Node runs of the
// automated tests, so they import the real production modules instead of
// copies.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function existingTs(candidate) {
  const file = fileURLToPath(candidate)
  if (existsSync(file) && !file.endsWith(path.sep)) return candidate
  const withExtension = new URL(`${candidate.href}.ts`)
  if (existsSync(fileURLToPath(withExtension))) return withExtension
  const asIndex = new URL(`${candidate.href}/index.ts`)
  if (existsSync(fileURLToPath(asIndex))) return asIndex
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@shared/')) {
    const base = path.join(projectRoot, 'src', 'shared', specifier.slice('@shared/'.length))
    const target = existsSync(`${base}.ts`) ? `${base}.ts` : base
    return { url: pathToFileURL(target).href, shortCircuit: true }
  }
  if (specifier.startsWith('.') || specifier.startsWith('file:')) {
    try {
      return await nextResolve(specifier, context)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL) throw error
      const candidate = existingTs(new URL(specifier, context.parentURL))
      if (candidate) return { url: candidate.href, shortCircuit: true }
      throw error
    }
  }
  return nextResolve(specifier, context)
}
