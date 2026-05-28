import { enterpriseEnv } from '../config/env'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type StructuredLog = {
  level: LogLevel
  message: string
  timestamp: string
  service: 'dashboard-web'
  version: string
  context?: Record<string, unknown>
}

const writeLog = (entry: StructuredLog) => {
  const payload = JSON.stringify(entry)
  if (entry.level === 'error') {
    console.error(payload)
    return
  }

  if (entry.level === 'warn') {
    console.warn(payload)
    return
  }

  console.info(payload)
}

export const logger = {
  log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    writeLog({
      level,
      message,
      context,
      service: 'dashboard-web',
      timestamp: new Date().toISOString(),
      version: enterpriseEnv.appVersion,
    })
  },
  debug(message: string, context?: Record<string, unknown>) {
    this.log('debug', message, context)
  },
  info(message: string, context?: Record<string, unknown>) {
    this.log('info', message, context)
  },
  warn(message: string, context?: Record<string, unknown>) {
    this.log('warn', message, context)
  },
  error(message: string, context?: Record<string, unknown>) {
    this.log('error', message, context)
  },
}
