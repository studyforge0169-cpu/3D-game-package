/**
 * Standardized machine-readable error contract (docs/ai-integration.md).
 *
 * Every CLI failure in --json mode emits:
 *   { "success": false, "error": { "code", "message", ...context } }
 * with a stable exit code per error class, so AI agents never parse prose.
 */

export type ErrorCode =
  | 'LICENSE_UNKNOWN'        // per-asset license could not be verified → download blocked
  | 'LICENSE_RESTRICTED'     // license forbids automated download / non-free
  | 'DOWNLOAD_UNAVAILABLE'   // source permits no automated download (manual tier / robots)
  | 'PROVIDER_UNAVAILABLE'   // unknown provider id / provider down
  | 'RATE_LIMITED'           // provider rate limit hit (never circumvented)
  | 'AUTH_REQUIRED'          // needs the user's API key/token
  | 'INVALID_ASSET'          // asset reference malformed or not found
  | 'CONVERSION_FAILED'      // inspect/convert/optimize failure
  | 'EXPORT_FAILED'          // engine export failure
  | 'DISK_SPACE'             // insufficient disk space
  | 'DUPLICATE'              // informational: asset already in library
  | 'NETWORK_ERROR'          // transport failure
  // documented extensions:
  | 'INVALID_USAGE'          // bad CLI arguments
  | 'CONFIRMATION_REQUIRED'  // --require-confirmation without a TTY; use --yes or --dry-run
  | 'NOT_FOUND'              // local file/path missing
  | 'REPOSITORY_CAPACITY'    // mirror paused: repo size limit reached (never bypassed silently)
  | 'UNKNOWN_ERROR';

export const EXIT_CODES: Record<ErrorCode, number> = {
  LICENSE_UNKNOWN: 3,
  LICENSE_RESTRICTED: 3,
  DOWNLOAD_UNAVAILABLE: 4,
  PROVIDER_UNAVAILABLE: 4,
  RATE_LIMITED: 4,
  AUTH_REQUIRED: 4,
  INVALID_ASSET: 1,
  CONVERSION_FAILED: 2,
  EXPORT_FAILED: 2,
  DISK_SPACE: 4,
  DUPLICATE: 0,
  NETWORK_ERROR: 4,
  INVALID_USAGE: 1,
  CONFIRMATION_REQUIRED: 5,
  NOT_FOUND: 1,
  REPOSITORY_CAPACITY: 6,
  UNKNOWN_ERROR: 1,
};

export interface StructuredError {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    exit_code: number;
    command?: string;
    asset_id?: string;
    source?: string;
    path?: string;
    hint?: string;
  };
}

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    public context: { command?: string; asset_id?: string; source?: string; path?: string; hint?: string } = {},
  ) {
    super(message);
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toJSON(command?: string): StructuredError {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        exit_code: this.exitCode,
        command: command ?? this.context.command,
        asset_id: this.context.asset_id,
        source: this.context.source,
        path: this.context.path,
        ...(this.context.hint ? { hint: this.context.hint } : {}),
      },
    };
  }
}

/** Map an error (unknown shape) to the contract, choosing the best code. */
export function toStructuredError(e: unknown, command?: string): CliError {
  if (e instanceof CliError) return e;
  const msg = String((e as Error)?.message ?? e);
  let code: ErrorCode = 'UNKNOWN_ERROR';
  if (/\bgit\b|fatal:|exit code 128/i.test(msg)) code = 'EXPORT_FAILED';
  if (/usage:|expects a|missing required|unknown (command|config key|category|key provider|engine|subcommand)/i.test(msg)) code = 'INVALID_USAGE';
  else if (/must look like <provider>:<asset-id>|asset reference/i.test(msg)) code = 'INVALID_ASSET';
  else if (/file not found/i.test(msg)) code = 'NOT_FOUND';
  else if (/asset not found|unknown provider/i.test(msg)) code = 'INVALID_ASSET';
  else if (/not supported natively|cannot parse|conversion failed/i.test(msg)) code = 'CONVERSION_FAILED';
  else if (/license[^.]{0,40}(is )?unknown|could not be verified|^LICENSE_UNKNOWN/i.test(msg)) code = 'LICENSE_UNKNOWN';
  else if (/robots|automated access is unavailable/i.test(msg)) code = 'DOWNLOAD_UNAVAILABLE';
  else if (/api key|token|configure/i.test(msg)) code = 'AUTH_REQUIRED';
  else if (/network|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(msg)) code = 'NETWORK_ERROR';
  else if (/rate limit|429|too many requests/i.test(msg)) code = 'RATE_LIMITED';
  else if (/disk/i.test(msg)) code = 'DISK_SPACE';
  return new CliError(code, msg, { command });
}

/** Translate core DownloadTask states/errorCodes into the contract. */
export function errorForTask(state: string, errorCode?: string, errorMessage?: string): CliError {
  const msg = errorMessage ?? 'download failed';
  switch (state) {
    case 'blocked_license':
      return new CliError('LICENSE_UNKNOWN', msg);
    case 'skipped_duplicate':
      return new CliError('DUPLICATE', msg);
    case 'corrupt':
      return new CliError('DOWNLOAD_UNAVAILABLE', `downloaded file failed verification: ${msg}`);
    case 'canceled':
      return new CliError('DOWNLOAD_UNAVAILABLE', 'download canceled');
    case 'failed':
    default: {
      switch (errorCode) {
        case 'LICENSE_UNKNOWN_BLOCK': return new CliError('LICENSE_UNKNOWN', msg);
        case 'DISK_FULL': return new CliError('DISK_SPACE', msg);
        case 'AUTH_REQUIRED': return new CliError('AUTH_REQUIRED', msg, { hint: 'Add your key with: asset-hub key set <provider> <key>' });
        case 'MANUAL':
        case 'AUTOMATION_BLOCKED':
        case 'ROBOTS_DENIED':
          return new CliError('DOWNLOAD_UNAVAILABLE', 'Automated access is unavailable for this source. Open the official asset page to obtain it manually.');
        case 'HASH_MISMATCH':
        case 'CORRUPT': return new CliError('DOWNLOAD_UNAVAILABLE', `integrity verification failed: ${msg}`);
        case 'RATE_LIMITED': return new CliError('RATE_LIMITED', msg);
        default: return new CliError('NETWORK_ERROR', msg);
      }
    }
  }
}
