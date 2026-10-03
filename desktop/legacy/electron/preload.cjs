const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bubble", {
  call: (method, params = {}) =>
    ipcRenderer.invoke("bubble:call", method, params),
  subscribe: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("bubble:event", handler);
    return () => ipcRenderer.removeListener("bubble:event", handler);
  },
});
