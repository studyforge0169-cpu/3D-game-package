/**
 * Minimal local MCP (Model Context Protocol) server — stdio transport,
 * zero dependencies. Exposes asset-hub as ~12 agent tools backed by the
 * exact same CLI + JSON contract documented in AGENTS.md.
 *
 * Start: asset-hub mcp        (register in Claude Desktop / any MCP client as
 *                              a stdio command)
 * Protocol: JSON-RPC 2.0, newline-delimited, MCP protocolVersion 2024-11-05.
 * Everything runs locally against the existing core; no cloud, no telemetry.
 */

import * as readline from 'node:readline';
import { runCli } from './index';
import * as pkg from '../../package.json';

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  args: (input: Record<string, unknown>) => string[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const numArg = (v: unknown): string | undefined => (typeof v === 'number' ? String(v) : undefined);

export const TOOLS: McpTool[] = [
  {
    name: 'search_assets',
    description: 'Unified search across all enabled 3D-asset providers. Returns structured results with per-asset license data.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'search terms, e.g. "medieval castle"' },
        cc0: { type: 'boolean' }, commercial: { type: 'boolean' }, free: { type: 'boolean' },
        license: { type: 'string' }, format: { type: 'string' }, kind: { type: 'string' },
        max_poly: { type: 'number' }, rigged: { type: 'boolean' }, animated: { type: 'boolean' },
        engine: { type: 'string', enum: ['unreal', 'unity', 'godot', 'blender'] },
        limit: { type: 'number' }, provider: { type: 'string' },
      },
    },
    args: (i) => ['search', String(i.query), ...(i.cc0 ? ['--cc0'] : []), ...(i.commercial ? ['--commercial'] : []),
      ...(i.free ? ['--free'] : []), ...(str(i.license) ? ['--license', str(i.license)!] : []),
      ...(str(i.format) ? ['--format', str(i.format)!] : []), ...(str(i.kind) ? ['--kind', str(i.kind)!] : []),
      ...(numArg(i.max_poly) ? ['--max-poly', numArg(i.max_poly)!] : []), ...(i.rigged ? ['--rigged'] : []),
      ...(i.animated ? ['--animated'] : []), ...(str(i.engine) ? ['--engine', str(i.engine)!] : []),
      ...(numArg(i.limit) ? ['--limit', numArg(i.limit)!] : []), ...(str(i.provider) ? ['--provider', str(i.provider)!] : [])],
  },
  {
    name: 'get_asset',
    description: 'Full details for one asset: metadata, license (verified, with commercial-use/attribution flags) and download options.',
    inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string', description: 'provider:asset-id' } } },
    args: (i) => ['info', String(i.ref)],
  },
  {
    name: 'check_license',
    description: 'Verify an asset\'s license from official provider data. Unknown licenses block downloads by design.',
    inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
    args: (i) => ['info', String(i.ref)],
  },
  {
    name: 'download_asset',
    description: 'Download an asset into the local library (license-checked, hash-verified, duplicate-safe).',
    inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, output: { type: 'string' }, category: { type: 'string' } } },
    args: (i) => ['download', String(i.ref), ...(str(i.output) ? ['--output', str(i.output)!] : []), ...(str(i.category) ? ['--category', str(i.category)!] : [])],
  },
  {
    name: 'inspect_asset',
    description: 'Mesh statistics (triangles, vertices, materials, animations, bounds) for a local model file.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    args: (i) => ['inspect', String(i.path)],
  },
  {
    name: 'convert_asset',
    description: 'Convert a local model file (glb/gltf/obj/stl/ply native; fbx/blend/dae via configured external tools).',
    inputSchema: { type: 'object', required: ['path', 'format'], properties: { path: { type: 'string' }, format: { type: 'string', enum: ['glb', 'gltf', 'obj'] }, out: { type: 'string' } } },
    args: (i) => ['convert', String(i.path), '--format', String(i.format), ...(str(i.out) ? ['--out', str(i.out)!] : [])],
  },
  {
    name: 'optimize_asset',
    description: 'One-command game-ready optimization (weld, normals, prune, texture compression).',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, out: { type: 'string' } } },
    args: (i) => ['optimize', String(i.path), ...(str(i.out) ? ['--out', str(i.out)!] : [])],
  },
  {
    name: 'recommend_assets',
    description: 'Ranked asset candidates for a natural-language request, with transparent scoring factors. Never downloads.',
    inputSchema: { type: 'object', required: ['request'], properties: { request: { type: 'string' }, engine: { type: 'string', enum: ['unreal', 'unity', 'godot', 'blender'] } } },
    args: (i) => ['recommend', String(i.request), ...(str(i.engine) ? ['--engine', str(i.engine)!] : [])],
  },
  {
    name: 'acquire_asset',
    description: 'Full pipeline for a natural-language request: search → license verify → download → inspect → convert/optimize → engine export → attribution. Use dry_run first.',
    inputSchema: {
      type: 'object', required: ['request'],
      properties: {
        request: { type: 'string' }, engine: { type: 'string', enum: ['unreal', 'unity', 'godot', 'blender'] },
        project: { type: 'string' }, output: { type: 'string' },
        dry_run: { type: 'boolean' }, optimize: { type: 'boolean' }, yes: { type: 'boolean' },
      },
    },
    args: (i) => ['acquire', String(i.request), ...(str(i.engine) ? ['--engine', str(i.engine)!] : []),
      ...(str(i.project) ? ['--project', str(i.project)!] : []), ...(str(i.output) ? ['--output', str(i.output)!] : []),
      ...(i.dry_run ? ['--dry-run'] : []), ...(i.optimize ? ['--optimize'] : []), ...(i.yes ? ['--yes'] : [])],
  },
  {
    name: 'import_asset',
    description: 'Import a provider asset (provider:asset-id) or a local file (needs license + provider) into a game project.',
    inputSchema: {
      type: 'object', required: ['target'],
      properties: {
        target: { type: 'string' }, project: { type: 'string' }, engine: { type: 'string' },
        license: { type: 'string' }, provider: { type: 'string' },
      },
    },
    args: (i) => ['import', String(i.target), ...(str(i.project) ? ['--project', str(i.project)!] : []),
      ...(str(i.engine) ? ['--engine', str(i.engine)!] : []), ...(str(i.license) ? ['--license', str(i.license)!] : []),
      ...(str(i.provider) ? ['--provider', str(i.provider)!] : [])],
  },
  {
    name: 'export_asset',
    description: 'Export library asset(s) to an engine project layout (unreal/unity/godot/blender) with attribution files.',
    inputSchema: { type: 'object', required: ['ids', 'engine', 'output'], properties: { ids: { type: 'array', items: { type: 'string' } }, engine: { type: 'string' }, output: { type: 'string' } } },
    args: (i) => ['export', ...(Array.isArray(i.ids) ? i.ids.map(String) : []), '--engine', String(i.engine), '--output', String(i.output)],
  },
  {
    name: 'list_sources',
    description: 'All providers with exact capability reporting (search/metadata/download/license verification/automation tier).',
    inputSchema: { type: 'object', properties: {} },
    args: () => ['sources'],
  },
  {
    name: 'detect_project',
    description: 'Detect the game engine project in a directory (uproject/project.godot/Assets+ProjectSettings/blend).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    args: (i) => ['project', ...(str(i.path) ? ['--path', str(i.path)!] : [])],
  },
];

export async function mcpServer(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  const send = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      return; // ignore malformed lines (protocol stays line-delimited JSON only)
    }
    const isNotification = req.id === undefined || req.id === null;
    const respond = (result: unknown, err?: { code: number; message: string }): void => {
      if (isNotification) return;
      send(err ? { jsonrpc: '2.0', id: req.id, error: err } : { jsonrpc: '2.0', id: req.id, result });
    };

    switch (req.method) {
      case 'initialize':
        respond({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'asset-hub', version: pkg.version },
          instructions: 'Local AI gateway for legally downloadable 3D game assets. Prefer recommend_assets/acquire_asset(dry_run) before downloads; license-safety rules are enforced server-side and cannot be bypassed.',
        });
        break;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break;
      case 'ping':
        respond({});
        break;
      case 'tools/list':
        respond({
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
        break;
      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) {
          respond(undefined, { code: -32602, message: `unknown tool: ${name}` });
          return;
        }
        const input = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const out: string[] = [];
        void runCli([...tool.args(input), '--json'], {
          out: (l = '') => out.push(l),
          err: (l = '') => out.push(l),
        }, { installSignalHandlers: false }).then((code) => {
          respond({ content: [{ type: 'text', text: out.join('\n') || '{}' }], isError: code !== 0 });
        });
        break;
      }
      default:
        if (!isNotification) respond(undefined, { code: -32601, message: `method not found: ${req.method}` });
    }
  });

  return new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });
}
