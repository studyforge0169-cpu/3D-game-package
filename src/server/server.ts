/**
 * Server mode: runs the identical core (Hub) behind a local HTTP API so the
 * same renderer UI works in a browser. Used for headless testing, the
 * sandboxed demo, and for users who prefer http://localhost.
 *
 *   npm run dev:web   → serves build/renderer + /api/* on 127.0.0.1 (bind
 *   0.0.0.0 when UGAH_BIND_ALL=1 for container/preview use).
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Hub } from '../core/services/hub';
import { rootLogger } from '../core/util/logger';
import { detectExternalTool } from '../core/convert/adapters';

const log = rootLogger.child('server');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain',
  '.zip': 'application/zip',
};

async function main() {
  const mockMode = process.env.UGAH_FIXTURES === '1';
  const hub = new Hub({ mockMode });
  await hub.init();

  const rendererDir = path.resolve(__dirname, '..', '..', 'build', 'renderer');
  const indexHtml = path.join(rendererDir, 'index.html');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      // ---- SSE event stream
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const fwd = (ev: string) => (data: unknown) => {
          res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const onProgress = fwd('download-progress');
        const onCompleted = fwd('download-completed');
        const onConflicts = fwd('export-conflicts');
        hub.on('download-progress', onProgress);
        hub.on('download-completed', onCompleted);
        hub.on('export-conflicts', onConflicts);
        const keep = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => {
          clearInterval(keep);
          hub.off('download-progress', onProgress);
          hub.off('download-completed', onCompleted);
          hub.off('export-conflicts', onConflicts);
        });
        return;
      }

      // ---- asset binary file (viewer)
      const fileMatch = /^\/api\/assets\/([^/]+)\/(file|preview)$/.exec(url.pathname);
      if (fileMatch) {
        const asset = hub.asset(fileMatch[1]);
        if (!asset) { res.writeHead(404); res.end('not found'); return; }
        const filePath = fileMatch[2] === 'preview' ? asset.previewPath : asset.localPath;
        if (!filePath || !fs.existsSync(filePath)) { res.writeHead(404); res.end('file missing'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      // ---- API
      if (url.pathname.startsWith('/api/')) {
        const method = url.pathname.slice('/api/'.length);
        let args: unknown[] = [];
        if (req.method === 'POST') {
          const body = await readBody(req);
          try { args = (JSON.parse(body || '{}') as { args?: unknown[] }).args ?? []; } catch { args = []; }
        }
        const result = await dispatch(hub, method, args);
        if (result === undefined) { res.writeHead(200); res.end('null'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // ---- static renderer
      let filePath = path.normalize(path.join(rendererDir, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!filePath.startsWith(rendererDir)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = indexHtml;
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('renderer build missing — run npm run build:renderer'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      log.warn('request failed', { path: url.pathname, error: String(e) });
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String((e as Error).message ?? e));
    }
  });

  const port = Number(process.env.UGAH_PORT ?? 8765);
  const host = process.env.UGAH_BIND_ALL === '1' ? '0.0.0.0' : '127.0.0.1';
  server.listen(port, host, () => {
    log.info(`server mode ready — http://${host}:${port} (mock=${mockMode})`);
  });

  const shutdown = () => { server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatch(hub: Hub, method: string, args: any[]): Promise<unknown> {
  switch (method) {
    case 'search': return hub.search(args[0]);
    case 'providerInfos': return hub.providerInfos();
    case 'getAssetDetail': return hub.getAssetDetail(args[0], args[1]);
    case 'enqueueDownload': return hub.enqueueDownload(args[0], args[1], args[2]);
    case 'downloads': return hub.downloads();
    case 'pauseDownloads': return hub.pauseDownloads(args[0]);
    case 'resumeDownloads': return hub.resumeDownloads(args[0]);
    case 'cancelDownload': return hub.cancelDownload(args[0]);
    case 'retryDownload': return hub.retryDownload(args[0]);
    case 'removeDownload': return hub.removeDownload(args[0]);
    case 'clearFinishedDownloads': return hub.clearFinishedDownloads();
    case 'librarySearch': return hub.librarySearch(args[0] ?? {});
    case 'asset': return hub.asset(args[0]);
    case 'updateAsset': return hub.updateAsset(args[0], args[1]);
    case 'moveAssetCategory': return hub.moveAssetCategory(args[0], args[1]);
    case 'deleteAsset': return hub.deleteAsset(args[0]);
    case 'verifyAsset': return hub.verifyAsset(args[0]);
    case 'recentlyDownloaded': return hub.recentlyDownloaded();
    case 'recentlyUsed': return hub.recentlyUsed();
    case 'scanDuplicates': return hub.scanDuplicates();
    case 'duplicateGroups': return hub.duplicates.groups();
    case 'importLocalFile': return hub.importLocalFile(args[0]);
    case 'createCollection': return hub.createCollection(args[0], args[1]);
    case 'listCollections': return hub.listCollections();
    case 'deleteCollection': return hub.deleteCollection(args[0]);
    case 'addToCollection': return hub.addToCollection(args[0], args[1]);
    case 'removeFromCollection': return hub.removeFromCollection(args[0], args[1]);
    case 'collectionAssets': return hub.collectionAssets(args[0]);
    case 'convertAsset': return hub.convertAsset(args[0], args[1]);
    case 'converterTools': {
      const cfg = hub.getConfig();
      return {
        blender: detectExternalTool('blender', { blenderPath: cfg.converters.blenderPath }),
        assimp: detectExternalTool('assimp', { assimpPath: cfg.converters.assimpPath }),
      };
    }
    case 'exportAssets': return hub.exportAssets(args[0]);
    case 'resolveExportConflicts': return hub.resolveExportConflicts(args[0], args[1]);
    case 'listProjects': return hub.listProjects();
    case 'saveProject': return hub.saveProject(args[0]);
    case 'deleteProject': return hub.deleteProject(args[0]);
    case 'attributionFor': return hub.attributionFor(args[0] ?? []);
    case 'attributionForCollection': return hub.attributionForCollection(args[0]);
    case 'writeAttributionFiles': return hub.writeAttributionFiles(args[0] ?? [], args[1]);
    case 'getConfig': return hub.getConfig();
    case 'updateConfig': return hub.updateConfig(args[0]);
    case 'setApiKey': return hub.setApiKey(args[0], args[1] ?? '');
    case 'hasApiKey': return hub.hasApiKey(args[0]);
    case 'secretBackend': return hub.getSecretBackend();
    case 'backupDatabase': return hub.backupDatabase();
    case 'openExternal': {
      const u = String(args[0] ?? '');
      if (/^https:\/\//.test(u)) log.info('open-in-browser requested', { url: u });
      return null; // browser mode: the renderer link opens directly
    }
    case 'pickFile': return null; // browser file pickers are used instead
    case 'pickDirectory': return null;
    case 'readAssetFile': return null;
    case 'readPreview': return null;
    default: throw new Error(`unknown api method: ${method}`);
  }
}

void main().catch((e) => {
  log.error('server failed to start', { error: String(e) });
  process.exit(1);
});
