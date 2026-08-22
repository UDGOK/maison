/**
 * Scanner prefix / suffix handling (v0.4 J).
 *
 * Many Bluetooth HID scanners (Socket Mobile S740, Zebra CS6080, Inateck BCST-70…) can be
 * programmed to send a prefix (e.g. `~` or STX) and a suffix (Enter, Tab, `\r\n`, a custom
 * character). The wedge parser already accepts Enter or Tab as the terminator; anything
 * else configured here is stripped from the decoded burst before it is resolved.
 */

export interface ScannerConfig {
  /** literal characters sent before the code (empty = none) */
  prefix: string
  /** literal characters sent after the code, before the terminator (empty = none) */
  suffix: string
  /** which key ends a burst: Enter (default), Tab, or both */
  terminator: 'enter' | 'tab' | 'both'
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = { prefix: '', suffix: '', terminator: 'both' }

/** Unescape the common control-character spellings used in scanner manuals. */
export function unescapeAffix(s: string): string {
  return (s || '')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/<STX>/gi, '')
    .replace(/<ETX>/gi, '')
    .replace(/<CR>/gi, '\r')
    .replace(/<LF>/gi, '\n')
    .replace(/<TAB>/gi, '\t')
}

/** Remove the configured prefix / suffix (and stray CR/LF) from a raw scanned burst. */
export function stripAffixes(raw: string, cfg: Partial<ScannerConfig> = {}): string {
  let code = raw ?? ''
  const prefix = unescapeAffix(cfg.prefix || '')
  const suffix = unescapeAffix(cfg.suffix || '')
  if (prefix && code.startsWith(prefix)) code = code.slice(prefix.length)
  if (suffix && code.endsWith(suffix)) code = code.slice(0, -suffix.length)
  return code.replace(/[\r\n\t]+$/g, '').replace(/^[\r\n\t]+/g, '').trim()
}

/** Does `key` end a burst under this config? */
export function isTerminator(key: string, cfg: Partial<ScannerConfig> = {}): boolean {
  const t = cfg.terminator || 'both'
  if (key === 'Enter') return t === 'enter' || t === 'both'
  if (key === 'Tab') return t === 'tab' || t === 'both'
  return false
}

export function normalizeScannerConfig(raw: Partial<ScannerConfig> | null | undefined): ScannerConfig {
  const t = raw?.terminator
  return {
    prefix: String(raw?.prefix ?? ''),
    suffix: String(raw?.suffix ?? ''),
    terminator: t === 'enter' || t === 'tab' || t === 'both' ? t : 'both'
  }
}
