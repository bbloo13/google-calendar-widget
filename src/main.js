const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchAgenda } = require('./calendarService');

const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const COLLAPSED_WIDTH = 300;
const GRID_PANEL_WIDTH = 340;
const PANEL_GAP = 8;
const EXPANDED_WIDTH = COLLAPSED_WIDTH + GRID_PANEL_WIDTH + PANEL_GAP;
const WINDOW_HEIGHT = 420;

let mainWindow;
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

app.whenReady().then(() => {
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
