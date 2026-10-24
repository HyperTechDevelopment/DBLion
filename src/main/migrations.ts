import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MigrationInfo, MigrationSaveRequest } from '@shared/types'

function migrationDir(): string {
  return path.join(app.getPath('userData'), 'migrations')
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid migration id.')
  return id
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return normalized || 'migration'
}

function hash(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

async function pathFor(id: string): Promise<string> {
  return path.join(migrationDir(), `${safeId(id)}.sql`)
}

export async function listMigrations(): Promise<MigrationInfo[]> {
  try {
    const entries = await fs.readdir(migrationDir(), { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    const result: MigrationInfo[] = []
    for (const file of files) {
      const id = file.name.slice(0, -4)
      if (!/^[A-Za-z0-9._-]+$/.test(id)) continue
      const full = path.join(migrationDir(), file.name)
      const [sql, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)])
      const header = /^--\s*name:\s*(.+)$/m.exec(sql)?.[1]?.trim()
      const dialect = /^--\s*dialect:\s*(.+)$/m.exec(sql)?.[1]?.trim()
      result.push({
        id,
        name: header ?? id.replace(/^\d+-/, ''),
        createdAt: stat.mtimeMs,
        dialect,
        hash: hash(sql),
        sql
      })
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function saveMigration(request: MigrationSaveRequest): Promise<MigrationInfo> {
  const name = request.name.trim() || 'migration'
  const sql = request.sql.trim()
  if (!sql) throw new Error('Migration SQL is empty.')
  if (Buffer.byteLength(sql, 'utf8') > 2_000_000) {
    throw new Error('Migration exceeds the 2 MB limit.')
  }
  await fs.mkdir(migrationDir(), { recursive: true })
  const id = `${Date.now()}-${slug(name)}`
  const header = [
    `-- name: ${name}`,
    `-- created: ${new Date().toISOString()}`,
    request.dialect ? `-- dialect: ${request.dialect}` : '',
    request.connectionId ? `-- connection: ${request.connectionId}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const body = `${header}\n\n${sql}\n`
  const file = await pathFor(id)
  await fs.writeFile(file, body, 'utf8')
  return {
    id,
    name,
    createdAt: Date.now(),
    dialect: request.dialect,
    hash: hash(body),
    sql: body
  }
}

export async function readMigration(id: string): Promise<MigrationInfo | null> {
  try {
    const file = await pathFor(id)
    const [sql, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
    const name = /^--\s*name:\s*(.+)$/m.exec(sql)?.[1]?.trim() ?? id.replace(/^\d+-/, '')
    const dialect = /^--\s*dialect:\s*(.+)$/m.exec(sql)?.[1]?.trim()
    return {
      id,
      name,
      createdAt: stat.mtimeMs,
      dialect,
      hash: hash(sql),
      sql
    }
  } catch {
    return null
  }
}
