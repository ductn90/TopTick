import { join } from 'node:path'
import type { MainLogger } from 'electron-log'

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

const MAX_LOG_BYTES = 1024 * 1024

/**
 * File logger for the Electron main process. `electron-log/main` is passed in by
 * `src/main/index.ts` so this module never loads electron at runtime.
 */
export function createMainLogger(electronLog: MainLogger, userDataDir: string): Logger {
  electronLog.transports.file.resolvePathFn = () => join(userDataDir, 'logs', 'main.log')
  electronLog.transports.file.maxSize = MAX_LOG_BYTES
  electronLog.initialize()
  return {
    debug: (...args) => electronLog.debug(...args),
    info: (...args) => electronLog.info(...args),
    warn: (...args) => electronLog.warn(...args),
    error: (...args) => electronLog.error(...args)
  }
}

/** Console logger for scripts (`compare-live`); `debug` is printed only when `verbose`. */
export function createConsoleLogger(verbose = false): Logger {
  return {
    debug: (...args) => {
      if (verbose) console.debug('[debug]', ...args)
    },
    info: (...args) => console.info('[info]', ...args),
    warn: (...args) => console.warn('[warn]', ...args),
    error: (...args) => console.error('[error]', ...args)
  }
}

/** Logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}
