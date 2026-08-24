const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calendarAPI', {
  getListAgenda: (view) => ipcRenderer.invoke('get-list-agenda', { view }),
  getGrid: (monthOffset) => ipcRenderer.invoke('get-grid', { monthOffset }),
  setGridOpen: (open) => ipcRenderer.invoke('set-grid-open', open),
  openCalendarHome: (dateKeyMs) => ipcRenderer.invoke('open-calendar-home', dateKeyMs),
  onAutoRefreshTick: (callback) => {
    ipcRenderer.on('auto-refresh-tick', () => callback());
  },
});
