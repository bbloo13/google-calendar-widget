const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calendarAPI', {
  getListAgenda: (view) => ipcRenderer.invoke('get-list-agenda', { view }),
  getGrid: (monthOffset) => ipcRenderer.invoke('get-grid', { monthOffset }),
  // One shared window-resize channel for both side panels (the grid and
  // mail panels are mutually exclusive and the same size, so the window
  // just needs to know "is *a* panel open", not which one).
  setSidePanelOpen: (open) => ipcRenderer.invoke('set-side-panel-open', open),
  listTodayMail: () => ipcRenderer.invoke('mail:list-today'),
  getMailMessage: (provider, accountKey, messageId) =>
    ipcRenderer.invoke('mail:get-message', { provider, accountKey, messageId }),
  translateMail: (text) => ipcRenderer.invoke('mail:translate', text),
  cleanMailTable: (text) => ipcRenderer.invoke('mail:clean-table', text),
  addMailAccount: () => ipcRenderer.invoke('mail:add-account'),
  reloginMailAccount: (accountKey) => ipcRenderer.invoke('mail:relogin-account', { accountKey }),
  addNaverAccount: (email, password) => ipcRenderer.invoke('mail:add-naver-account', { email, password }),
  openCalendarHome: (dateKeyMs) => ipcRenderer.invoke('open-calendar-home', dateKeyMs),
  openNotesWindow: () => ipcRenderer.invoke('open-notes-window'),
  updateEvent: (eventId, title, description) => ipcRenderer.invoke('update-event', { eventId, title, description }),
  deleteEvent: (eventId) => ipcRenderer.invoke('delete-event', eventId),
  addEvent: (payload) => ipcRenderer.invoke('add-calendar-event', payload),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  onAutoRefreshTick: (callback) => {
    ipcRenderer.on('auto-refresh-tick', () => callback());
  },
  onMailCheckTick: (callback) => {
    ipcRenderer.on('mail-check-tick', () => callback());
  },
});
