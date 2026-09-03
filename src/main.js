const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { fetchAgenda, createEvent, updateEvent, deleteEvent } = require('./calendarService');
const { withAuthRetry } = require('../auth/googleAuth');
const drive = require('./driveService');

// Without this, every single Calendar/Drive API call opened a brand-new TLS
// connection before it could even start — reusing connections cuts a lot of
// the per-click latency the notes window and widget were both feeling.
https.globalAgent.keepAlive = true;

const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const COLLAPSED_WIDTH = 300;
const GRID_PANEL_WIDTH = 340;
const PANEL_GAP = 8;
const EXPANDED_WIDTH = COLLAPSED_WIDTH + GRID_PANEL_WIDTH + PANEL_GAP;
const WINDOW_HEIGHT = 420;

let mainWindow;
let notesWindow;
let tray;
let refreshTimer;
let isQuitting = false;

function getPositionFilePath() {
  return path.join(app.getPath('userData'), 'window-position.json');
}

function loadSavedPosition() {
  try {
    const raw = fs.readFileSync(getPositionFilePath(), 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function savePosition(bounds) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getPositionFilePath(), JSON.stringify({ x: bounds.x, y: bounds.y }));
  } catch (err) {
    console.error('Failed to save window position:', err);
  }
}

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 24;
  return {
    x: workArea.x + workArea.width - COLLAPSED_WIDTH - margin,
    y: workArea.y + margin,
  };
}

/** Resizes the window for the grid panel being open/closed, anchoring the top-right corner. */
function resizeForGrid(open) {
  if (!mainWindow) return;
  const targetWidth = open ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
  const bounds = mainWindow.getBounds();
  if (bounds.width === targetWidth) return;
  const newX = bounds.x + bounds.width - targetWidth;
  mainWindow.setBounds({ x: newX, y: bounds.y, width: targetWidth, height: WINDOW_HEIGHT });
}

function createWindow() {
  const saved = loadSavedPosition() || defaultPosition();

  mainWindow = new BrowserWindow({
    width: COLLAPSED_WIDTH,
    height: WINDOW_HEIGHT,
    x: saved.x,
    y: saved.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    alwaysOnTop: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep the widget on the desktop, not above normal windows.
  mainWindow.setAlwaysOnTop(false);

  let moveSaveTimeout;
  mainWindow.on('move', () => {
    clearTimeout(moveSaveTimeout);
    moveSaveTimeout = setTimeout(() => {
      // Only persist the collapsed (day/week) position, not the expanded grid layout.
      if (mainWindow && mainWindow.getBounds().width === COLLAPSED_WIDTH) {
        savePosition(mainWindow.getBounds());
      }
    }, 300);
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

/** Opens the notes app window (a normal resizable window, unlike the calendar widget). */
function openNotesWindow() {
  if (notesWindow) {
    notesWindow.show();
    notesWindow.focus();
    return;
  }

  notesWindow = new BrowserWindow({
    width: 880,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    title: '메모장',
    backgroundColor: '#14141a',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1c1c22', symbolColor: '#b8b8c4', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'notes-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notesWindow.loadFile(path.join(__dirname, 'notes', 'index.html'));
  notesWindow.on('closed', () => {
    notesWindow = null;
  });
}

function createTrayIcon() {
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size / 2 - 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - center + 0.5;
      const dy = y - center + 0.5;
      const inside = dx * dx + dy * dy <= radius * radius;
      // nativeImage BGRA byte order
      buffer[idx] = inside ? 255 : 0; // B
      buffer[idx + 1] = inside ? 181 : 0; // G
      buffer[idx + 2] = inside ? 127 : 0; // R
      buffer[idx + 3] = inside ? 255 : 0; // A
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Calendar Widget');

  const menu = Menu.buildFromTemplate([
    { label: '위젯 표시', click: () => mainWindow && mainWindow.show() },
    { label: '메모장 열기', click: () => openNotesWindow() },
    { type: 'separator' },
    {
      label: '완전 종료',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (mainWindow) mainWindow.webContents.send('auto-refresh-tick');
  }, REFRESH_INTERVAL_MS);
}

// Renderer owns which view/month is showing; main just proxies data fetches,
// handles window resizing for the grid panel, and broadcasts refresh ticks.
ipcMain.handle('get-list-agenda', async (_event, { view }) => {
  try {
    const agenda = await fetchAgenda(app.getPath('userData'), view);
    return { ok: true, agenda };
  } catch (err) {
    console.error('Failed to fetch agenda:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-grid', async (_event, { monthOffset = 0 } = {}) => {
  try {
    const agenda = await fetchAgenda(app.getPath('userData'), 'month', monthOffset);
    return { ok: true, agenda };
  } catch (err) {
    console.error('Failed to fetch month grid:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-grid-open', (_event, open) => {
  resizeForGrid(open);
});

ipcMain.handle('open-calendar-home', (_event, dateKeyMs) => {
  const d = dateKeyMs ? new Date(Number(dateKeyMs)) : new Date();
  const url = `https://calendar.google.com/calendar/u/0/r/month/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  shell.openExternal(url);
});

// Links inside an event's (HTML) description get opened this way, never navigated to in-window.
ipcMain.handle('open-external-url', (_event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('open-notes-window', () => {
  openNotesWindow();
});

ipcMain.handle('update-event', async (_event, { eventId, title, description }) => {
  try {
    const event = await withGoogleAuth((auth) => updateEvent(auth, eventId, { title, description }));
    return { ok: true, event };
  } catch (err) {
    console.error('Failed to update event:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('delete-event', async (_event, eventId) => {
  try {
    await withGoogleAuth((auth) => deleteEvent(auth, eventId));
    return { ok: true };
  } catch (err) {
    console.error('Failed to delete event:', err);
    return { ok: false, error: err.message };
  }
});

// --- Notes (Google Drive-backed) ---

async function withGoogleAuth(fn) {
  return withAuthRetry(app.getPath('userData'), fn);
}

ipcMain.handle('notes:list-categories', async () => {
  try {
    const { categories } = await withGoogleAuth((auth) => drive.listCategories(auth));
    return { ok: true, categories };
  } catch (err) {
    console.error('Failed to list note categories:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:create-category', async (_event, { name, parentId }) => {
  try {
    const category = await withGoogleAuth((auth) => drive.createCategory(auth, name, parentId));
    return { ok: true, category };
  } catch (err) {
    console.error('Failed to create category:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:list-notes', async (_event, categoryId) => {
  try {
    const notes = await withGoogleAuth((auth) => drive.listNotes(auth, categoryId));
    return { ok: true, notes };
  } catch (err) {
    console.error('Failed to list notes:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:read-note', async (_event, fileId) => {
  try {
    const note = await withGoogleAuth((auth) => drive.readNote(auth, fileId));
    return { ok: true, note };
  } catch (err) {
    console.error('Failed to read note:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:create-note', async (_event, { categoryId, name, content }) => {
  try {
    const note = await withGoogleAuth((auth) => drive.createNote(auth, categoryId, name, content));
    return { ok: true, note };
  } catch (err) {
    console.error('Failed to create note:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:update-note', async (_event, { fileId, content }) => {
  try {
    const note = await withGoogleAuth((auth) => drive.updateNote(auth, fileId, content));
    return { ok: true, note };
  } catch (err) {
    console.error('Failed to save note:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:rename-note', async (_event, { fileId, name }) => {
  try {
    const note = await withGoogleAuth((auth) => drive.renameItem(auth, fileId, name));
    return { ok: true, note };
  } catch (err) {
    console.error('Failed to rename note:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:rename-category', async (_event, { categoryId, name }) => {
  try {
    const category = await withGoogleAuth((auth) => drive.renameItem(auth, categoryId, name));
    return { ok: true, category };
  } catch (err) {
    console.error('Failed to rename category:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:delete-note', async (_event, fileId) => {
  try {
    await withGoogleAuth((auth) => drive.trashFile(auth, fileId));
    return { ok: true };
  } catch (err) {
    console.error('Failed to delete note:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:delete-category', async (_event, categoryId) => {
  try {
    await withGoogleAuth((auth) => drive.trashFile(auth, categoryId));
    return { ok: true };
  } catch (err) {
    console.error('Failed to delete category:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:reorder-categories', async (_event, items) => {
  try {
    await withGoogleAuth((auth) => drive.reorderItems(auth, items));
    return { ok: true };
  } catch (err) {
    console.error('Failed to reorder categories:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:reorder-notes', async (_event, items) => {
  try {
    await withGoogleAuth((auth) => drive.reorderItems(auth, items));
    return { ok: true };
  } catch (err) {
    console.error('Failed to reorder notes:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:move-note', async (_event, { fileId, fromCategoryId, toCategoryId }) => {
  try {
    await withGoogleAuth((auth) => drive.moveNote(auth, fileId, fromCategoryId, toCategoryId));
    return { ok: true };
  } catch (err) {
    console.error('Failed to move note:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:search', async (_event, term) => {
  try {
    const results = await withGoogleAuth((auth) => drive.searchNotes(auth, term));
    return { ok: true, results };
  } catch (err) {
    console.error('Failed to search notes:', err);
    return { ok: false, error: err.message };
  }
});

// Shared by both windows — the widget's own "+" popup and the notes editor's
// "일정에 추가" button both call this same channel.
ipcMain.handle('add-calendar-event', async (_event, { title, date, endDate, time, endTime, description }) => {
  try {
    const event = await withGoogleAuth((auth) =>
      createEvent(auth, { title, date, endDate, time, endTime, description })
    );
    // Whichever window made the change, keep the widget's own view in sync.
    if (mainWindow) mainWindow.webContents.send('auto-refresh-tick');
    return { ok: true, event };
  } catch (err) {
    console.error('Failed to add event to calendar:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:open-drive-folder', async () => {
  try {
    const url = await withGoogleAuth((auth) => drive.getRootFolderUrl(auth));
    shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    console.error('Failed to open Drive folder:', err);
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  startAutoRefresh();
});

app.on('window-all-closed', () => {
  // Widget lives in the tray; only quit via the tray's "완전 종료" menu item.
});

app.on('before-quit', () => {
  isQuitting = true;
});
