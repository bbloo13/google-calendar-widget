const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { fetchAgenda, createEvent, updateEvent, deleteEvent } = require('./calendarService');
const { withAuthRetry, addMailAccount, listMailAccountKeys } = require('../auth/googleAuth');
const drive = require('./driveService');
const gmail = require('./gmailService');
const naver = require('./naverService');
const gemini = require('./geminiService');

// Without this, a second launch (e.g. the Windows startup shortcut firing
// while a manual launch is still starting up, or right after a reboot)
// would run fully independently alongside the first — both instances
// reading and writing the same userData files (mail-accounts.json,
// naver-accounts.json, tokens) with no coordination between them. That's
// how an account could intermittently fail to load with no error at all:
// not lost data, just two processes racing over the same file. Whichever
// instance grabs the lock first keeps running; every later launch attempt
// quits immediately and just re-shows the first instance's window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// Without this, every single Calendar/Drive API call opened a brand-new TLS
// connection before it could even start — reusing connections cuts a lot of
// the per-click latency the notes window and widget were both feeling.
https.globalAgent.keepAlive = true;

const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const MAIL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const COLLAPSED_WIDTH = 300;
const SIDE_PANEL_WIDTH = 340; // shared by the grid and mail panels — they're mutually exclusive, never both open
const PANEL_GAP = 8;
const EXPANDED_WIDTH = COLLAPSED_WIDTH + SIDE_PANEL_WIDTH + PANEL_GAP;
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

/** A Downloads-folder path for `name` that won't clobber an existing file (matches how browsers auto-number repeat downloads). */
function uniqueDownloadPath(name) {
  const downloadsDir = app.getPath('downloads');
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(downloadsDir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(downloadsDir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

/** A scratch path (per file id, so two different attachments never collide) for opening an attachment in its OS default viewer without touching Downloads. */
function previewTempPath(fileId, name) {
  const dir = path.join(app.getPath('temp'), 'calendar-widget-previews', fileId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 24;
  return {
    x: workArea.x + workArea.width - COLLAPSED_WIDTH - margin,
    y: workArea.y + margin,
  };
}

/**
 * Resizes the window for a side panel (grid or mail) being open/closed,
 * anchoring the top-right corner (the main widget's edge never moves). The
 * renderer is the source of truth for whether either panel wants the space
 * open (see setSidePanelOpen's callers) — this just gets a plain boolean.
 * A single instant jump, not animated: the panel's own reveal is instant
 * too (display:none/flex), so there's nothing for a window-resize animation
 * to stay in sync with.
 */
function resizeForSidePanel(open) {
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

let mailCheckTimer;
function startMailAutoCheck() {
  clearInterval(mailCheckTimer);
  mailCheckTimer = setInterval(() => {
    if (mainWindow) mainWindow.webContents.send('mail-check-tick');
  }, MAIL_CHECK_INTERVAL_MS);
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

ipcMain.handle('set-side-panel-open', (_event, open) => {
  resizeForSidePanel(open);
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

async function withGoogleAuth(fn, accountKey = 'primary') {
  return withAuthRetry(app.getPath('userData'), fn, accountKey);
}

ipcMain.handle('notes:list-categories', async () => {
  try {
    const { rootId, categories } = await withGoogleAuth((auth) => drive.listCategories(auth));
    return { ok: true, rootId, categories };
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

ipcMain.handle('notes:move-category', async (_event, { categoryId, fromParentId, toParentId }) => {
  try {
    await withGoogleAuth((auth) => drive.moveCategory(auth, categoryId, fromParentId, toParentId));
    return { ok: true };
  } catch (err) {
    console.error('Failed to move category:', err);
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
    await withGoogleAuth(async (auth) => {
      await drive.trashFile(auth, fileId);
      await drive.deleteAttachmentsForNote(auth, fileId); // no orphaned images/files left behind
    });
    return { ok: true };
  } catch (err) {
    console.error('Failed to delete note:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:list-attachments', async (_event, noteId) => {
  try {
    const attachments = await withGoogleAuth((auth) => drive.listAttachments(auth, noteId));
    return { ok: true, attachments };
  } catch (err) {
    console.error('Failed to list attachments:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:rename-attachment', async (_event, { fileId, name }) => {
  try {
    const attachment = await withGoogleAuth((auth) => drive.renameItem(auth, fileId, name));
    return { ok: true, attachment };
  } catch (err) {
    console.error('Failed to rename attachment:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:upload-attachment', async (_event, { categoryId, noteId, name, mimeType, data }) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    const attachment = await withGoogleAuth((auth) =>
      drive.uploadAttachment(auth, { categoryId, noteId, name, mimeType, buffer })
    );
    return { ok: true, attachment };
  } catch (err) {
    console.error('Failed to upload attachment:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:download-attachment', async (_event, fileId) => {
  try {
    const { name, buffer } = await withGoogleAuth((auth) => drive.downloadAttachment(auth, fileId));
    const savePath = uniqueDownloadPath(name);
    fs.writeFileSync(savePath, buffer);
    return { ok: true, path: savePath };
  } catch (err) {
    console.error('Failed to download attachment:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:preview-attachment', async (_event, fileId) => {
  try {
    const { name, buffer } = await withGoogleAuth((auth) => drive.downloadAttachment(auth, fileId));
    const tempPath = previewTempPath(fileId, name);
    fs.writeFileSync(tempPath, buffer);
    const openError = await shell.openPath(tempPath);
    if (openError) throw new Error(openError);
    return { ok: true };
  } catch (err) {
    console.error('Failed to preview attachment:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:delete-attachment', async (_event, fileId) => {
  try {
    await withGoogleAuth((auth) => drive.trashFile(auth, fileId));
    return { ok: true };
  } catch (err) {
    console.error('Failed to delete attachment:', err);
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

// --- Mail (Gmail + Naver) ---
// Gmail: 'primary' is the original single-account identity (shared with
// Calendar/Drive); any others are mail-only accounts added via
// mail:add-account, tracked in mail-accounts.json (see googleAuth.js).
// Naver: a completely separate IMAP-based integration (naverService.js) —
// no OAuth, just an email + app password stored in naver-accounts.json,
// both userData files, neither ever in the git repo.

ipcMain.handle('mail:list-today', async () => {
  const userDataDir = app.getPath('userData');
  const gmailKeys = ['primary', ...listMailAccountKeys(userDataDir)];

  const gmailResults = Promise.all(
    gmailKeys.map(async (accountKey) => {
      try {
        const summary = await withGoogleAuth((auth) => gmail.listTodayMessages(auth), accountKey);
        return { ok: true, provider: 'gmail', accountKey, ...summary };
      } catch (err) {
        console.error(`Failed to list today's mail for '${accountKey}':`, err);
        return { ok: false, provider: 'gmail', accountKey, error: err.message };
      }
    })
  );

  const naverResults = Promise.all(
    naver.listAccounts(userDataDir).map(async (account) => {
      try {
        const summary = await naver.listTodayMessages(account);
        return { ok: true, provider: 'naver', accountKey: account.email, email: account.email, ...summary };
      } catch (err) {
        console.error(`Failed to list today's mail for Naver '${account.email}':`, err);
        return { ok: false, provider: 'naver', accountKey: account.email, error: err.message };
      }
    })
  );

  const accounts = [...(await gmailResults), ...(await naverResults)];
  return { ok: true, accounts };
});

ipcMain.handle('mail:get-message', async (_event, { provider, accountKey, messageId }) => {
  try {
    let message;
    if (provider === 'naver') {
      const account = naver.listAccounts(app.getPath('userData')).find((a) => a.email === accountKey);
      if (!account) throw new Error('네이버 계정을 찾을 수 없어요.');
      message = await naver.getMessage(account, messageId);
    } else {
      message = await withGoogleAuth((auth) => gmail.getMessage(auth, messageId), accountKey);
    }
    return { ok: true, message };
  } catch (err) {
    console.error('Failed to fetch mail message:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mail:add-account', async () => {
  try {
    const accountKey = await addMailAccount(app.getPath('userData'));
    const summary = await withGoogleAuth((auth) => gmail.listTodayMessages(auth), accountKey);
    return { ok: true, accountKey, ...summary };
  } catch (err) {
    console.error('Failed to add mail account:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mail:add-naver-account', async (_event, { email, password }) => {
  try {
    const userDataDir = app.getPath('userData');
    await naver.addAccount(userDataDir, email, password);
    const account = naver.listAccounts(userDataDir).find((a) => a.email === email);
    const summary = await naver.listTodayMessages(account);
    return { ok: true, email, ...summary };
  } catch (err) {
    console.error('Failed to add Naver account:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mail:translate', async (_event, text) => {
  try {
    if (!gemini.isConfigured()) return { ok: false, error: 'Gemini API 키가 설정되지 않았어요.' };
    const translated = await gemini.translateToKorean(text);
    return { ok: true, translated };
  } catch (err) {
    console.error('Failed to translate mail:', err);
    return { ok: false, error: err.message };
  }
});

// Kept separate from mail:get-message rather than run inline there — the
// raw extraction is already readable (if a bit flat for table rows), so
// the message can be shown immediately while this upgrades it in the
// background instead of the reading view sitting on a blank loading bar
// for the couple extra seconds Gemini adds.
ipcMain.handle('mail:clean-table', async (_event, text) => {
  try {
    if (!gemini.isConfigured()) return { ok: false, error: 'Gemini API 키가 설정되지 않았어요.' };
    const cleaned = await gemini.cleanMailContent(text);
    return { ok: true, cleaned };
  } catch (err) {
    console.error('Failed to clean up table mail:', err);
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  startAutoRefresh();
  startMailAutoCheck();

  // Quietly warm the notes backend (root-folder lookup + an authorized
  // client) in the background so opening the notes window for the first
  // time doesn't pay for that from a cold start — it races harmlessly
  // against the widget's own startup fetch (see the promise-caching note
  // on getAuthorizedClient) and just gets ignored if it fails.
  withGoogleAuth((auth) => drive.listCategories(auth)).catch(() => {});
});

app.on('window-all-closed', () => {
  // Widget lives in the tray; only quit via the tray's "완전 종료" menu item.
});

app.on('before-quit', () => {
  isQuitting = true;
});
