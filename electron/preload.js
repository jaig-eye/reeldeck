// Runs before the page loads. Exposes a tiny, safe bridge to the TOP frame only.
// The cross-origin player <iframe> must NOT get this — so we guard on being the
// top window. That way the app's own "Open in browser" can reach the OS browser
// through a trusted channel, while the provider iframe's ad pop-ups can't.
const { contextBridge, ipcRenderer } = require('electron');

let isTop = false;
try { isTop = window.top === window.self; } catch (e) { isTop = false; }

if (isTop) {
  contextBridge.exposeInMainWorld('reeldeck', {
    desktop: true,
    // Which window buttons share the header: 'overlay' (Windows/Linux, right) or 'inset' (macOS, left).
    frame: process.platform === 'darwin' ? 'inset' : 'overlay',
    titlebar: (o) => ipcRenderer.invoke('reeldeck:titlebar', o),
    // Did the named player frame load, and is anything in it? (electron/watchdog.js)
    checkPlayer: (name) => ipcRenderer.invoke('reeldeck:player-check', String(name || '')),
    openExternal: (url) => ipcRenderer.invoke('reeldeck:open-external', String(url || '')),
    installUpdate: () => ipcRenderer.invoke('reeldeck:install-update'),
    checkForUpdates: () => ipcRenderer.invoke('reeldeck:check-update'),
    onUpdate: (cb) => ipcRenderer.on('reeldeck:update', (e, data) => { try { cb(data); } catch (_) {} })
  });
}
