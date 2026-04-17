export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug?(msg: string): void
}

export function createConsoleLogger(prefix?: string): Logger {
  const p = prefix ? `[${prefix}] ` : ""
  return {
    info: (msg) => console.log(`${p}${msg}`),
    warn: (msg) => console.warn(`${p}${msg}`),
    error: (msg) => console.error(`${p}${msg}`),
    debug: (msg) => console.debug(`${p}${msg}`),
  }
}
