import { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, extname } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentRunner } from './agent-runner';
import type { ServerEvent, ClientEvent } from '../shared/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:10090';

let mainWindow: BrowserWindow | null = null;
let runner: AgentRunner | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 900,
    minHeight: 600,
    title: 'Bubble',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    ...(process.platform === 'darwin' ? { roundedCorners: true } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111214' : '#ffffff',
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const emit = (event: ServerEvent) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('server-event', JSON.stringify(event));
  };
  runner = new AgentRunner(emit);

  ipcMain.on('client-event', (_evt, json: string) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(json);
    } catch {
      return;
    }
    runner?.handle(event).catch((err) => console.error('[runner]', event.type, err));
  });

  if (app.isPackaged) {
    mainWindow.loadFile(resolve(__dirname, '../dist-renderer/index.html'));
  } else {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- window.electron channel surface ----------------------------------------
// Boot-critical + chat handlers are real; the rest are safe stubs so the forked
// UI never crashes on a missing channel.

const FONT_DEFAULT = {
  selections: {
    ui: { source: 'builtin', id: 'system-sans' },
    display: { source: 'builtin', id: 'editorial-serif' },
    mono: { source: 'builtin', id: 'system-mono' },
  },
  importedFonts: [],
};

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

interface AttachmentDTO {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  kind: 'file' | 'image';
}

function toAttachment(filePath: string): AttachmentDTO | null {
  const ext = extname(filePath).toLowerCase();
  const mimeType = ATTACHMENT_MIME_TYPES[ext];
  if (!mimeType) return null;
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return null;
  }
  if (size > 10 * 1024 * 1024) return null; // 10MB cap
  const kind = ext === '.png' || ext === '.jpg' || ext === '.jpeg' ? 'image' : 'file';
  return { id: randomUUID(), path: filePath, name: basename(filePath), size, mimeType, kind };
}

function registerHandlers() {
  // -- real, boot-critical --
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-window-shell-state', () => ({ rounded: process.platform === 'darwin' }));
  ipcMain.handle('get-ui-resume-state', () => null);
  ipcMain.handle('set-theme', (_e, theme: string) => {
    nativeTheme.themeSource = (theme as 'light' | 'dark' | 'system') ?? 'system';
    return { ok: true };
  });
  ipcMain.handle('set-window-min-size', () => ({ ok: true }));
  ipcMain.handle('generate-session-title', (_e, prompt: string) => String(prompt ?? '').slice(0, 40));
  ipcMain.handle('get-font-settings', () => FONT_DEFAULT);
  ipcMain.handle('list-system-fonts', () => []);
  ipcMain.handle('get-recent-cwds', () => []);
  ipcMain.handle('select-directory', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('open-external-url', (_e, url: string) => shell.openExternal(String(url)));
  ipcMain.handle('open-path', (_e, p: string) => shell.openPath(String(p)));
  ipcMain.handle('reveal-path', (_e, p: string) => {
    shell.showItemInFolder(String(p));
    return { ok: true };
  });

  // -- sendSync channels --
  ipcMain.on('get-ui-resume-state-sync', (e) => {
    e.returnValue = null;
  });
  ipcMain.on('save-ui-resume-state-sync', (e) => {
    e.returnValue = { ok: true };
  });
  ipcMain.on('project-editor-draft-update-sync', (e) => {
    e.returnValue = { ok: true };
  });
  ipcMain.on('write-project-text-file-sync', (e) => {
    e.returnValue = { ok: true };
  });
  ipcMain.on('project-editor-draft-update', () => {
    /* no-op async draft mirror */
  });

  // -- safe stubs for everything else --
  const stub = (channel: string, value: unknown) => ipcMain.handle(channel, () => value);

  // model/provider configs (Bubble is the only provider; pickers read these).
  // Shapes must match shared/types.ts exactly — composer spreads .options / .availableModels.
  stub('get-claude-model-config', { defaultModel: null, options: [] });
  stub('get-codex-model-config', {
    defaultModel: null,
    defaultReasoningEffort: null,
    options: [],
    availableModels: [],
  });
  stub('get-kimi-model-config', { defaultModel: null, options: [], availableModels: [] });
  stub('get-opencode-model-config', { defaultModel: null, options: [], availableModels: [] });
  ipcMain.handle(
    'get-aegis-built-in-agent-config',
    () =>
      runner?.getAegisConfig() ?? {
        providerId: '',
        baseUrl: '',
        apiKey: '',
        providerApiKeys: {},
        model: '',
        temperature: 0,
      },
  );
  stub('get-claude-compatible-provider-config', { providers: {} });
  stub('save-claude-compatible-provider-config', { ok: true });
  stub('save-aegis-built-in-agent-config', { ok: true });
  stub('save-codex-model-visibility', { ok: true });
  stub('save-opencode-model-visibility', { ok: true });
  stub('get-claude-runtime-status', { ready: true });
  stub('get-codex-runtime-status', { ready: false });
  stub('get-kimi-runtime-status', { ready: false });
  stub('get-opencode-runtime-status', { ready: false });
  stub('codex-get-composer-capabilities', {});
  stub('codex-list-skills', { skills: [] });
  ipcMain.handle('aegis-list-skills', () => runner?.listSkills() ?? { skills: [] });
  stub('codex-list-plugins', { plugins: [] });
  stub('codex-read-plugin', {});
  stub('expand-claude-skill-prompt', {});

  // project tree / files
  stub('get-project-tree', null);
  stub('watch-project-tree', { ok: true });
  stub('unwatch-project-tree', { ok: true });
  stub('watch-project-file', { ok: true });
  stub('unwatch-project-file', { ok: true });
  stub('read-project-file-preview', '');
  ipcMain.handle('select-attachments', async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported', extensions: ['txt', 'md', 'json', 'log', 'pdf', 'docx', 'png', 'jpg', 'jpeg'] }],
    });
    if (result.canceled) return [];
    return result.filePaths.map(toAttachment).filter(Boolean);
  });
  ipcMain.handle('read-attachment-preview', (_e, filePath: string) => {
    try {
      const ext = extname(String(filePath)).toLowerCase();
      const mime = ATTACHMENT_MIME_TYPES[ext];
      if (!mime || !mime.startsWith('image/')) return '';
      return `data:${mime};base64,${readFileSync(String(filePath)).toString('base64')}`;
    } catch {
      return '';
    }
  });

  // git
  stub('get-git-changes', []);
  stub('get-git-working-tree-summary', null);
  stub('get-git-overview', { branch: null, changes: [] });
  stub('get-git-patch', { files: [] });
  stub('get-git-branch', null);
  stub('get-git-branches', []);
  stub('get-git-history', []);
  stub('get-git-diff', '');

  // prompts / skills market / memory / usage
  stub('get-prompt-library', []);
  stub('get-skill-market-hot', []);
  stub('search-skill-market', []);
  stub('get-memory-workspace', { documents: [] });
  stub('get-automations', { automations: [] });
  stub('get-claude-usage-report', { entries: [] });
  stub('get-codex-usage-report', { entries: [] });
  stub('get-codex-rate-limits', {});
  stub('get-opencode-usage-report', { entries: [] });
  stub('get-feishu-bridge-config', {});
  stub('get-feishu-bridge-status', { running: false });
  stub('get-wechat-html-generator-config', {});
  stub('getStaticData', {});
  stub('check-for-updates', { available: false, version: null, autoDetected: false });
  stub('get-update-status', { available: false, version: null, autoDetected: false });
  stub('getEnvironmentEditorLaunchers', []);
  stub('get-environment-editor-launchers', []);

  // terminal (no-op; terminal feature disabled for now)
  stub('terminal:open', { ok: false });
  stub('terminal:write', { ok: false });
  stub('terminal:resize', { ok: false });
  stub('terminal:clear', { ok: false });
  stub('terminal:restart', { ok: false });
  stub('terminal:close', { ok: false });
  stub('get-terminal-transport-info', { available: false });
  stub('start-terminal-session', { ok: false });
  stub('write-terminal-session', { ok: false });
  stub('resize-terminal-session', { ok: false });
  stub('stop-terminal-session', { ok: false });
}

ipcMain.handle('app:get-version', () => app.getVersion());

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
