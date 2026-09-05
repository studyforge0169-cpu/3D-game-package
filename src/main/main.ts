/**
 * Electron main process: window, IPC bridge to the Hub, native dialogs,
 * secure storage, single-instance, safe shutdown.
 */

import { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Hub } from '../core/services/hub';
import { detectExternalTool } from '../core/convert/adapters';
import { rootLogger } from '../core/util/logger';

const log = rootLogger.child('main');

let mainWindow: BrowserWindow | null = null;
let hub: Hub;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = extractImportArg(argv);
    if (mainWindow) {
      if (file) void sendImportFile(file);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    hub = new Hub({
      safeStorage: {
        isEncryptionAvailable: () => require('electron').safeStorage.isEncryptionAvailable(),
        encryptString: (p) => require('electron').safeStorage.encryptString(p),
        decryptString: (b) => require('electron').safeStorage.decryptString(b),
      },
    });
    await hub.init();
    registerIpc();
    createWindow();
    const importFile = extractImportArg(process.argv);
    if (importFile) void sendImportFile(importFile);
  });

  app.on('window-all-closed', () => {
    // Windows/Linux: quit (mac keeps the menu-bar convention)
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f5f6fa',
    title: 'Universal Game Asset Hub',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(path.join(__dirname, '..', '..', 'build', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function extractImportArg(argv: string[]): string | null {
  const i = argv.indexOf('--import-file');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

async function sendImportFile(file: string): Promise<void> {
  mainWindow?.webContents.send('import-file', file);
}

// ------------------------------------------------------------------- IPC

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown | Promise<unknown>;

function handle(method: string, fn: Handler): void {
  ipcMain.handle(method, (_ev, ...args) => {
    try {
      return fn(...args);
    } catch (e) {
      log.error('ipc handler failed', { method, error: String(e) });
      throw e;
    }
  });
}

function registerIpc(): void {
  handle('search', (q: never) => hub.search(q));
  handle('providerInfos', () => hub.providerInfos());
  handle('getAssetDetail', (p, id) => hub.getAssetDetail(p, id));
  handle('enqueueDownload', (p, id, o) => hub.enqueueDownload(p, id, o));
  handle('downloads', () => hub.downloads());
  handle('pauseDownloads', (t) => hub.pauseDownloads(t));
  handle('resumeDownloads', (t) => hub.resumeDownloads(t));
  handle('cancelDownload', (t) => hub.cancelDownload(t));
  handle('retryDownload', (t) => hub.retryDownload(t));
  handle('removeDownload', (t) => hub.removeDownload(t));
  handle('clearFinishedDownloads', () => hub.clearFinishedDownloads());
  handle('librarySearch', (o) => hub.librarySearch(o ?? {}));
  handle('asset', (id) => hub.asset(id));
  handle('updateAsset', (id, patch) => hub.updateAsset(id, patch));
  handle('moveAssetCategory', (id, cat) => hub.moveAssetCategory(id, cat));
  handle('deleteAsset', (id) => hub.deleteAsset(id));
  handle('verifyAsset', (id) => hub.verifyAsset(id));
  handle('recentlyDownloaded', () => hub.recentlyDownloaded());
  handle('recentlyUsed', () => hub.recentlyUsed());
  handle('scanDuplicates', () => hub.scanDuplicates());
  handle('duplicateGroups', () => hub.duplicates.groups());
  handle('importLocalFile', (o) => hub.importLocalFile(o));
  handle('createCollection', (n, d) => hub.createCollection(n, d));
  handle('listCollections', () => hub.listCollections());
  handle('deleteCollection', (id) => hub.deleteCollection(id));
  handle('addToCollection', (c, a) => hub.addToCollection(c, a));
  handle('removeFromCollection', (c, a) => hub.removeFromCollection(c, a));
  handle('collectionAssets', (c) => hub.collectionAssets(c));
  handle('convertAsset', (id, o) => hub.convertAsset(id, o));
  handle('converterTools', () => {
    const cfg = hub.getConfig();
    return {
      blender: detectExternalTool('blender', { blenderPath: cfg.converters.blenderPath }),
      assimp: detectExternalTool('assimp', { assimpPath: cfg.converters.assimpPath }),
    };
  });
  handle('exportAssets', (req) => hub.exportAssets(req));
  handle('resolveExportConflicts', (req, d) => hub.resolveExportConflicts(req, d));
  handle('listProjects', () => hub.listProjects());
  handle('saveProject', (p) => hub.saveProject(p));
  handle('deleteProject', (id) => hub.deleteProject(id));
  handle('attributionFor', (ids) => hub.attributionFor(ids ?? []));
  handle('attributionForCollection', (id) => hub.attributionForCollection(id));
  handle('writeAttributionFiles', (ids, dir) => hub.writeAttributionFiles(ids ?? [], dir));
  handle('getConfig', () => hub.getConfig());
  handle('updateConfig', (patch) => hub.updateConfig(patch));
  handle('setApiKey', (p, k) => hub.setApiKey(p, k ?? ''));
  handle('hasApiKey', (p) => hub.hasApiKey(p));
  handle('secretBackend', () => hub.getSecretBackend());
  handle('backupDatabase', () => hub.backupDatabase());

  handle('openExternal', async (url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url);
  });
  handle('pickFile', async (extensions) => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: extensions?.length
        ? [{ name: 'Assets', extensions }]
        : [
          { name: '3D assets & archives', extensions: ['glb', 'gltf', 'obj', 'fbx', 'blend', 'stl', 'ply', 'dae', 'zip', 'hdr', 'exr', 'png', 'jpg', 'wav', 'ogg'] },
          { name: 'All files', extensions: ['*'] },
        ],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  handle('pickDirectory', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  handle('readAssetFile', async (assetId) => {
    const a = hub.asset(assetId);
    if (!a || !fs.existsSync(a.localPath)) return null;
    const data = await fs.promises.readFile(a.localPath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });
  handle('readPreview', async (assetId) => {
    const a = hub.asset(assetId);
    if (!a?.previewPath || !fs.existsSync(a.previewPath)) return null;
    return `data:image/${path.extname(a.previewPath).slice(1) || 'png'};base64,${(await fs.promises.readFile(a.previewPath)).toString('base64')}`;
  });

  // forward hub events to the renderer
  const forward = (channel: string) => (data: unknown) => mainWindow?.webContents.send(channel, data);
  hub.on('download-progress', forward('download-progress'));
  hub.on('download-completed', forward('download-completed'));
  hub.on('export-conflicts', forward('export-conflicts'));

  // Safe shutdown: flush downloads, backup db, close.
  app.on('before-quit', (e) => {
    e.preventDefault();
    void (async () => {
      try {
        await hub.backupDatabase().catch(() => {});
        hub.shutdownForProcessExit();
      } finally {
        app.exit(0);
      }
    })();
  });
}
