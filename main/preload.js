'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('folio', {
  library: {
    get: call('library:get'),
    importPaths: call('library:import'),
    pickFiles: call('library:pickFiles'),
    pickFolder: call('library:pickFolder'),
    remove: call('library:remove'),
    patchBook: call('library:patchBook'),
    setCollections: call('library:setCollections'),
    onChanged: (fn) => ipcRenderer.on('library:changed', (_e, result) => fn(result)),
  },
  settings: { patch: call('settings:patch') },
  book: { manifest: call('book:manifest') },
  tts: {
    status: call('tts:status'),
    install: call('tts:install'),
    voices: call('tts:voices'),
    synth: call('tts:synth'),
    cancel: call('tts:cancel'),
    onProgress: (fn) => ipcRenderer.on('tts:progress', (_e, progress) => fn(progress)),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: call('shell:openExternal'),
  window: {
    setChrome: call('window:setChrome'),
    toggleFullscreen: call('window:toggleFullscreen'),
  },
});
