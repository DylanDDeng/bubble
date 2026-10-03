import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
} from "electron";
import { fork, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
const here = dirname(fileURLToPath(import.meta.url));
app.setName("Bubble");
if (process.env.BUBBLE_DESKTOP_USER_DATA)
  app.setPath("userData", process.env.BUBBLE_DESKTOP_USER_DATA);
let win,
  worker,
  nextId = 0,
  ready,
  stopped = false;
const requests = new Map();
let preferences;
function loadPreferences() {
  try {
    return JSON.parse(
      readFileSync(join(app.getPath("userData"), "desktop.json"), "utf8"),
    );
  } catch {
    return { projects: [], theme: "system" };
  }
}
function savePreferences() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(
    join(app.getPath("userData"), "desktop.json"),
    JSON.stringify(preferences, null, 2),
  );
}
function emit(event) {
  if (win && !win.isDestroyed()) win.webContents.send("bubble:event", event);
}
function shellPath() {
  // Finder does not inherit the user's terminal PATH (npm, git, python, etc.).
  if (process.platform !== "darwin") return process.env.PATH ?? "";
  try {
    const output = execFileSync(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", 'printf "\\n__BUBBLE_PATH__%s" "$PATH"'],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return (
      output.split("__BUBBLE_PATH__").at(-1).trim().split("\n")[0] ||
      process.env.PATH ||
      ""
    );
  } catch {
    return process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
  }
}
function startWorker() {
  const sdkRoot = app.isPackaged
    ? join(process.resourcesPath, "runtime")
    : resolve(here, "../..");
  const node = app.isPackaged
    ? join(process.resourcesPath, "runtime/node")
    : process.env.BUBBLE_DESKTOP_NODE;
  if (!node || !existsSync(node))
    throw new Error("Node runtime missing. Launch with npm run desktop.");
  const workerPath = app.isPackaged
    ? join(process.resourcesPath, "agent-host/worker.mjs")
    : join(here, "worker.mjs");
  worker = fork(workerPath, [], {
    execPath: node,
    cwd: homedir(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      BUBBLE_SDK_ROOT: sdkRoot,
      BUBBLE_DESKTOP_CWD: homedir(),
      PATH: `${dirname(node)}:${shellPath()}`,
    },
  });
  // Keep credentials and SDK diagnostic output away from renderer/devtools.
  worker.stdout.resume();
  worker.stderr.resume();
  ready = new Promise((res, rej) => {
    const timeout = setTimeout(() => {
      rej(new Error("Agent 启动超时"));
      worker.kill();
    }, 30000);
    worker.on("message", (message) => {
      if (message.ready) {
        clearTimeout(timeout);
        res();
      }
      if (message.event) emit(message.event);
      if (message.id) {
        const p = requests.get(message.id);
        if (p) {
          requests.delete(message.id);
          clearTimeout(p.timer);
          message.error
            ? p.reject(new Error(message.error))
            : p.resolve(message.result);
        }
      }
    });
    const failed = (error) => {
      clearTimeout(timeout);
      rej(error);
      for (const p of requests.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      requests.clear();
      if (!stopped) emit({ type: "host_failure", message: error.message });
    };
    worker.on("error", failed);
    worker.on("exit", (code) =>
      failed(
        new Error(
          `Agent 进程已退出 (${code ?? "signal"})，请重新打开 Bubble。`,
        ),
      ),
    );
  });
  ready.catch(() => {});
}
async function rpc(method, params) {
  await ready;
  if (!worker?.connected) throw new Error("Agent 未连接，请重新打开 Bubble。");
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error("Agent 请求超时"));
    }, 30000);
    requests.set(id, { resolve, reject, timer });
    worker.send({ id, method, params });
  });
}
const methods = new Set([
  "bootstrap",
  "sessions",
  "snapshot",
  "create",
  "run",
  "stop",
  "reply",
]);
function validDirectory(cwd) {
  return (
    typeof cwd === "string" &&
    cwd.startsWith("/") &&
    existsSync(cwd) &&
    statSync(cwd).isDirectory()
  );
}
ipcMain.handle("bubble:call", async (event, method, params = {}) => {
  if (
    event.sender !== win?.webContents ||
    event.senderFrame !== win.webContents.mainFrame
  )
    throw new Error("Invalid sender");
  if (!params || typeof params !== "object")
    throw new Error("Invalid parameters");
  if (method === "preferences")
    return { ...preferences, home: homedir(), version: app.getVersion() };
  if (method === "theme") {
    if (!["light", "dark", "system"].includes(params.theme))
      throw new Error("Invalid theme");
    preferences.theme = params.theme;
    nativeTheme.themeSource = params.theme;
    savePreferences();
    return true;
  }
  if (method === "chooseProject") {
    const result = await dialog.showOpenDialog(win, {
      title: "选择项目文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const cwd = result.filePaths[0];
    preferences.projects = [...new Set([...preferences.projects, cwd])];
    savePreferences();
    return cwd;
  }
  if (method === "revealProject") {
    if (!validDirectory(params.cwd)) throw new Error("项目目录不存在");
    shell.showItemInFolder(params.cwd);
    return true;
  }
  if (method === "openSettings") {
    const dir = process.env.BUBBLE_HOME || join(homedir(), ".bubble");
    mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return true;
  }
  if (method === "openLink") {
    const url = new URL(params.url);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("不支持此链接类型");
    await shell.openExternal(url.href);
    return true;
  }
  if (!methods.has(method)) throw new Error("Unknown method");
  if (method === "create" && !validDirectory(params.cwd))
    throw new Error("请选择有效的项目文件夹");
  return rpc(method, params);
});
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 760,
    minHeight: 560,
    title: "Bubble",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202020" : "#faf9f7",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
    vibrancy: "sidebar",
    visualEffectState: "active",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.loadFile(join(here, "../dist/index.html"));
  win.on("closed", () => {
    win = null;
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(() => {
      preferences = loadPreferences();
      preferences.projects = Array.isArray(preferences.projects)
        ? preferences.projects.filter((p) => typeof p === "string")
        : [];
      nativeTheme.themeSource = ["light", "dark", "system"].includes(
        preferences.theme,
      )
        ? preferences.theme
        : "system";
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Bubble",
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "设置…",
                accelerator: "CmdOrCtrl+,",
                click: () => emit({ type: "settings" }),
              },
              { type: "separator" },
              { role: "hide" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          {
            label: "任务",
            submenu: [
              {
                label: "新建任务",
                accelerator: "CmdOrCtrl+N",
                click: () => emit({ type: "new_task" }),
              },
            ],
          },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
      startWorker();
      createWindow();
      app.on("activate", () => {
        if (!win) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("Bubble 启动失败", error.message);
      app.quit();
    });
  app.on("before-quit", () => {
    stopped = true;
    if (worker?.connected) worker.disconnect();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
