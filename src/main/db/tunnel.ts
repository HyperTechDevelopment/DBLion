import net from 'node:net'
import { Client } from 'ssh2'
import type { ConnectionConfig, DbKind } from '@shared/types'

const DEFAULT_PORTS: Record<DbKind, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  firebird: 3050,
  sqlite: 0,
  mongodb: 27017,
  redis: 6379
}

export interface Tunnel {
  config: ConnectionConfig
  close: () => Promise<void>
}

export async function openTunnel(config: ConnectionConfig): Promise<Tunnel> {
  if (!config.ssh || !config.host || config.kind === 'sqlite') {
    return { config, close: async () => undefined }
  }

  const ssh = new Client()
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      ssh.removeListener('ready', onReady)
      reject(new Error(`SSH tunnel failed: ${error.message}`))
    }
    const onReady = (): void => {
      ssh.removeListener('error', onError)
      resolve()
    }
    ssh.once('ready', onReady)
    ssh.once('error', onError)
    ssh.connect({
      host: config.ssh!.host,
      port: config.ssh!.port ?? 22,
      username: config.ssh!.user,
      password: config.ssh!.password,
      privateKey: config.ssh!.privateKey,
      passphrase: config.ssh!.passphrase,
      readyTimeout: 15000,
      keepaliveInterval: 10000
    })
  })

  const targetPort = config.port ?? DEFAULT_PORTS[config.kind]
  if (!targetPort) {
    ssh.end()
    throw new Error('SSH tunnel requires a target database port.')
  }

  const server = net.createServer((socket) => {
    ssh.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      config.host!,
      targetPort,
      (error, stream) => {
        if (error) {
          socket.destroy()
          return
        }
        socket.on('error', () => stream.destroy())
        stream.on('error', () => socket.destroy())
        stream.on('close', () => socket.destroy())
        socket.pipe(stream).pipe(socket)
      }
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const localPort = typeof address === 'object' && address ? address.port : 0
  if (!localPort) {
    server.close()
    ssh.end()
    throw new Error('SSH tunnel could not allocate a local port.')
  }

  return {
    config: { ...config, host: '127.0.0.1', port: localPort },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      ssh.end()
    }
  }
}
