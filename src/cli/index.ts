#!/usr/bin/env node
/**
 * asset-hub — unified legal 3D game-asset acquisition CLI.
 *
 *   asset-hub search "medieval castle"
 *   asset-hub info polyhaven:castle_ruins
 *   asset-hub download polyhaven:castle_ruins --output ./GameAssets
 *   asset-hub download-list assets.txt
 *   asset-hub sources | licenses | list | attributions | update
 *   asset-hub inspect model.glb | convert model.fbx --format glb | optimize model.glb
 *   asset-hub export <id> --engine unreal --output ./MyGame
 *
 * Everything runs on the same core as the desktop app; no network access
 * happens unless a command needs it, and every provider operates only
 * through its officially permitted access method.
 */

import './warnings'; // keep first: silences node:sqlite ExperimentalWarning
import { Hub } from '../core/services/hub';
import * as pkg from '../../package.json';
import {
  CliArgs, CommandCtx, UserError,
  cmdSearch, cmdInfo, cmdDownload, cmdBatch, cmdSources, cmdLicenses,
  cmdInspect, cmdConvert, cmdOptimize, cmdExport, cmdUpdate, cmdList,
  cmdAttributions, cmdConfig, cmdKey,
} from './commands';
import { CliIo } from './output';

// ---------------------------------------------------------------- arg parsing

const VALUE_FLAGS = new Set([
  'provider', 'license', 'format', 'kind', 'category', 'topic', 'sort', 'limit', 'page',
  'max-poly', 'min-poly', 'min-res', 'max-size', 'option', 'output', 'out', 'engine',
  'project', 'source', 'on-conflict', 'id', 'ids', 'tag', 'texture-max', 'texture-format',
  'texture-quality', 'lods', 'collision', 'decimate', 'axis', 'home', 'library',
  'concurrency',
]);

const COMMANDS: Record<string, string> = {
  search: 'search "<terms>" [filters] — unified multi-source search',
  info: '<provider:asset-id> — full asset, license and download-option details',
  download: '<provider:asset-id> [--output DIR] [--category CAT] [--option ID] — download into the library',
  batch: '<file> — queue a list of provider:asset-id lines (alias: download-list)',
  sources: '— list all providers and what they support',
  licenses: '— list the license registry and its permissions',
  list: '— list the local library (filters: --category --provider --tag --favorite)',
  attributions: '[--output DIR] [--ids id1,id2] — (re)generate ATTRIBUTIONS.txt/.md',
  update: '[--id <library-id>] [--dry-run] — re-check licenses of library assets',
  inspect: '<model-file> — mesh/texture/animation stats for GLB/GLTF/OBJ/STL/PLY',
  convert: '<file> --format glb|gltf|obj [options] — convert/optimize a model file',
  optimize: '<file> — one-command game-ready optimization preset',
  export: '<ids…> --engine unreal|unity|godot|blender --output DIR — engine-ready export',
  config: 'path | list | get <key> | set <key> <value> — manage settings',
  key: 'list | set <provider> <key> | remove <provider> — manage API keys (OS credential storage)',
};

function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') || (tok.startsWith('-') && tok.length === 2)) {
      const name = tok.replace(/^--?/, '').replace(/-/g, '-');
      const eq = name.indexOf('=');
      let key = name;
      let inlineValue: string | undefined;
      if (eq >= 0) {
        key = name.slice(0, eq);
        inlineValue = name.slice(eq + 1);
      }
      if (VALUE_FLAGS.has(key)) {
        const value = inlineValue !== undefined ? inlineValue : argv[++i];
        if (value === undefined) throw new UserError(`flag --${key} expects a value`);
        const list = flags.get(key) ?? [];
        list.push(value);
        flags.set(key, list);
      } else {
        if (inlineValue !== undefined) throw new UserError(`flag --${key} does not take a value`);
        booleans.add(key);
      }
    } else {
      positionals.push(tok);
    }
  }
  const command = positionals.shift() ?? '';
  return { command, positionals, flags, booleans };
}

function helpText(): string {
  const lines = [
    `${pkg.productName ?? pkg.name} v${pkg.version} — unified legal 3D game-asset CLI`,
    '',
    'Usage: asset-hub <command> [arguments]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([c, d]) => `  ${c.padEnd(14)} ${d}`),
    '',
    'Search filters: --cc0  --commercial  --free  --no-attribution  --license <id>',
    '                --format <ext>  --kind <model|texture|material|hdri>  --topic <t>',
    '                --max-poly <n>  --min-poly <n>  --min-res <n>  --max-size <MB>',
    '                --pbr  --rigged  --animated  --sort <key>  --limit <n>  --page <n>',
    '                --provider <id,id2> (repeatable, restricts sources)',
    '',
    'Global flags:   --json          machine-readable output',
    '                --library DIR   library root for this invocation',
    '                --home DIR      data directory (config/db/logs)',
    '                --fixtures      offline demo mode (bundled fixture provider)',
    '                --verbose       debug logging',
    '',
    'Examples:',
    '  asset-hub search "medieval castle" --cc0',
    '  asset-hub download polyhaven:castle_ruins --output ./GameAssets',
    '  asset-hub download-list assets.txt',
    '  asset-hub export 7f3c… --engine unity --output ./MyGame',
    '',
    'Legal: per-asset licenses are always checked; unknown licenses block downloads;',
    '       sources without permitted automation open their official page instead.',
  ];
  return lines.join('\n');
}

// --------------------------------------------------------------------- entry

export async function runCli(
  argv: string[],
  io: CliIo,
  opts: { installSignalHandlers?: boolean } = {},
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    io.out(helpText());
    return 1;
  }

  const json = args.booleans.has('json');
  const fixtures = args.booleans.has('fixtures') || process.env.UGAH_FIXTURES === '1';
  const home = args.flags.get('home')?.[0] ?? undefined;
  const library = args.flags.get('library')?.[0] ?? undefined;
  if (args.booleans.has('verbose')) process.env.UGAH_LOG_LEVEL = 'debug';

  if (args.booleans.has('version')) {
    io.out(`${pkg.name} ${pkg.version}`);
    return 0;
  }
  if (!args.command || args.command === 'help' || args.booleans.has('help')) {
    io.out(helpText());
    return args.command && args.command !== 'help' ? 1 : 0;
  }

  let hub: Hub | undefined;
  // CLI stays quiet on the console unless --verbose; logs still go to the file.
  if (args.booleans.has('verbose')) process.env.UGAH_LOG_LEVEL = 'debug';
  else if (!process.env.UGAH_LOG_LEVEL) process.env.UGAH_LOG_LEVEL = 'error';
  const ctx: CommandCtx = {
    args,
    io,
    json,
    getHub: async () => {
      if (!hub) {
        const outputFlag = args.flags.get('output')?.[0];
        const libDir = library ?? (['download', 'batch', 'download-list'].includes(args.command) ? outputFlag : undefined);
        hub = new Hub({
          userDataDir: home,
          libraryDir: libDir,
          persistLibraryDir: false, // CLI overrides never hijack the saved config
          mockMode: fixtures,
          installSignalHandlers: opts.installSignalHandlers ?? false,
        });
        await hub.init();
      }
      return hub;
    },
  };

  const aliases: Record<string, string> = { 'download-list': 'batch' };
  const command = aliases[args.command] ?? args.command;
  const handlers: Record<string, (c: CommandCtx) => Promise<number>> = {
    search: cmdSearch,
    info: cmdInfo,
    download: cmdDownload,
    batch: cmdBatch,
    sources: cmdSources,
    licenses: cmdLicenses,
    inspect: cmdInspect,
    convert: cmdConvert,
    optimize: cmdOptimize,
    export: cmdExport,
    update: cmdUpdate,
    list: cmdList,
    attributions: cmdAttributions,
    config: cmdConfig,
    key: cmdKey,
  };
  const handler = handlers[command];
  if (!handler) {
    io.err(`unknown command "${args.command}"`);
    io.out(helpText());
    return 1;
  }

  let code: number;
  try {
    code = await handler(ctx);
  } catch (e) {
    if (e instanceof UserError) {
      io.err(`error: ${e.message}`);
      code = e.code;
    } else {
      io.err(`error: ${String((e as Error).message ?? e)}`);
      code = 1;
    }
  } finally {
    hub?.shutdownForProcessExit();
  }
  return code;
}

/** Real process entry (module executed directly). */
async function main(): Promise<void> {
  // Graceful `| head` handling: broken pipes end quietly instead of crashing.
  const swallowEpipe = (e: NodeJS.ErrnoException): void => {
    if (e.code === 'EPIPE') return;
    throw e;
  };
  process.stdout.on('error', swallowEpipe);
  process.stderr.on('error', swallowEpipe);
  const io: CliIo = {
    out: (line = '') => process.stdout.write(line + '\n'),
    err: (line = '') => process.stderr.write(line + '\n'),
  };
  process.exitCode = await runCli(process.argv.slice(2), io, { installSignalHandlers: true });
}

if (require.main === module) {
  void main().catch((e) => {
    process.stderr.write(`fatal: ${String((e as Error).message ?? e)}\n`);
    process.exitCode = 1;
  });
}
