/**
 * Structured leveled logger (spec §18).
 * - JSON lines to file + human lines to console.
 * - Credential scrubbing: anything that looks like a bearer token, api key
 *   param, or authorization header is redacted BEFORE any sink sees it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_PATTERNS: { re: RegExp; replacement: string }[] = [
  { re: /(Authorization\s*:\s*)(Bearer|Token|Basic)\s+\S+/gi, replacement: '$1$2 [REDACTED]' },
  { re: /(Api-Key|X-API-Key|X-Auth-Token)\s*[:=]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  { re: /(token|apikey|api_key|api-key|secret|password|credential)(["'\s:=]+)([A-Za-z0-9_\-\.]{8,})/gi, replacement: '$1$2[REDACTED]' },
  { re: /(api\.poly\.pizza[^"\s]*)([?&][A-Za-z0-9_\-]{16,})/gi, replacement: '$1[REDACTED]' },
];

export function redact(text: string): string {
  let out = text;
  for (const { re, replacement } of REDACT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export interface LogFields { [k: string]: unknown }

export class Logger {
  private minLevel: LogLevel = 'info';
  private fileStream?: (msg: string) => void;
  readonly logs: string[] = []; // bounded in-memory ring for crash reporting

  constructor(private readonly component: string) {}

  configure(opts: { minLevel?: LogLevel; file?: (msg: string) => void }): void {
    if (opts.minLevel) this.minLevel = opts.minLevel;
    if (opts.file) this.fileStream = opts.file;
  }

  private log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const rec = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg: redact(String(msg)),
      ...(fields ? { fields: scrub(fields) } : {}),
    };
    const line = JSON.stringify(rec);
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.fileStream?.(line);
    const consoleMsg = `${rec.ts} ${level.toUpperCase().padEnd(5)} [${this.component}] ${rec.msg}`;
    if (level === 'error') console.error(consoleMsg);
    else if (level === 'warn') console.warn(consoleMsg);
    else console.log(consoleMsg);
  }

  debug(msg: string, fields?: LogFields) { this.log('debug', msg, fields); }
  info(msg: string, fields?: LogFields) { this.log('info', msg, fields); }
  warn(msg: string, fields?: LogFields) { this.log('warn', msg, fields); }
  error(msg: string, fields?: LogFields) { this.log('error', msg, fields); }

  child(component: string): Logger {
    const c = new Logger(`${this.component}:${component}`);
    c.minLevel = this.minLevel;
    c.fileStream = this.fileStream;
    return c;
  }
}

function scrub(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') out[k] = redact(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = scrub(v as LogFields);
    else out[k] = v;
  }
  return out;
}

/** Shared root logger. */
export const rootLogger = new Logger('ugah');
