const weekdayEl = document.getElementById('weekday');
const daynumEl = document.getElementById('daynum');
const monthEl = document.getElementById('month');
const agendaEl = document.getElementById('agenda');
const footerEl = document.getElementById('footer');
const refreshBtn = document.getElementById('refreshBtn');
const addEventBtn = document.getElementById('addEventBtn');
const openCalendarWebBtn = document.getElementById('openCalendarWebBtn');
const notesBtn = document.getElementById('notesBtn');
const gridToggleBtn = document.getElementById('gridToggleBtn');
const viewToggleEl = document.getElementById('viewToggle');
const gridPanelEl = document.getElementById('gridPanel');
const monthLabelEl = document.getElementById('monthLabel');
const monthWeeksEl = document.getElementById('monthWeeks');
const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');
const gridProgressBar = createProgressBar(document.getElementById('gridProgressBar'));

const mailToggleBtn = document.getElementById('mailToggleBtn');
const mailUnreadDotEl = document.getElementById('mailUnreadDot');
const mailPanelEl = document.getElementById('mailPanel');
const mailBackBtn = document.getElementById('mailBackBtn');
const mailLabelEl = document.getElementById('mailLabel');
const mailBodyEl = document.getElementById('mailBody');
const mailProgressBar = createProgressBar(document.getElementById('mailProgressBar'));

// A themed toast instead of the OS's own alert() dialog, which looks jarring
// next to a borderless dark widget — one element, reused and repositioned
// content-wise for every message rather than stacking multiple. Anchored
// inside whichever panel the triggering action belongs to (defaults to the
// main widget) rather than the whole window — the window's full width
// includes whichever side panel is open, so centering on the window itself
// put the toast in the gap between panels instead of inside either one.
const widgetEl = document.getElementById('widget');
let toastTimer = null;
function showToast(message, { danger = false, duration = 4000, container = widgetEl } = {}) {
  let toastEl = document.getElementById('toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    toastEl.className = 'toast';
  }
  container.appendChild(toastEl); // re-appending moves it if it was last shown in a different panel
  toastEl.textContent = message;
  toastEl.classList.toggle('is-danger', danger);
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), duration);
}

const eventContextMenu = document.getElementById('eventContextMenu');
const editEventMenuItem = document.getElementById('editEventMenuItem');
const deleteEventMenuItem = document.getElementById('deleteEventMenuItem');

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

let currentView = 'day'; // 'day' | 'week' — drives the agenda list
let gridOpen = false;
let monthOffset = 0;
let currentCells = [];
let selectedCellKey = null; // set when a grid day is previewed in the agenda panel
let lastRenderedGroups = null;
let expandedEventKey = null; // id of the event whose detail panel is expanded, if any
let contextMenuEventId = null;

// Mail panel state. Single-account-shaped for now (just the app's own Gmail
// sign-in) — `mailAccounts` is still an array so a second Gmail account or
// Naver later on is just another entry, not a rewrite.
let mailOpen = false;
let mailView = 'list'; // 'list' | 'reading'
let mailAccounts = []; // populated from listTodayMail()'s response — main.js is the source of truth for which accounts exist
let mailReadingMessage = null;
let mailReadingAccountId = null;
let mailReadingShowTranslated = false;
// Provider groups the account list is organized under — Naver has no
// accounts/functionality yet (its own IMAP integration isn't built), but
// the row exists so the "+" placement and hierarchy are already right for
// when it is.
const MAIL_PROVIDERS = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'naver', label: 'Naver' },
];
let mailProviderExpanded = { gmail: true, naver: false };

/** Finds an event object (and which group holds it) across the currently rendered groups. */
function findEvent(id) {
  for (const group of lastRenderedGroups || []) {
    const ev = (group.events || []).find((e) => e.id === id);
    if (ev) return { ev, group };
  }
  return null;
}

// Google Calendar's own web editor stores event descriptions as a small HTML
// subset (links, bold, line breaks, lists) — showing that as plain text is
// where the escaped tags/entities the user saw came from. Rebuilding through
// an allowlist (rather than trusting innerHTML) keeps this safe even though
// the source is the user's own calendar data.
const DESCRIPTION_ALLOWED_TAGS = { A: 'a', B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', BR: 'br', UL: 'ul', OL: 'ol', LI: 'li' };

function appendSanitizedChildren(sourceNode, targetParent) {
  for (const child of Array.from(sourceNode.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      targetParent.appendChild(document.createTextNode(child.textContent));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const mapped = DESCRIPTION_ALLOWED_TAGS[child.tagName];
    if (!mapped) {
      appendSanitizedChildren(child, targetParent); // unwrap: drop the tag, keep its content
      continue;
    }
    const clean = document.createElement(mapped);
    if (mapped === 'a') {
      const href = child.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) clean.dataset.href = href;
    }
    appendSanitizedChildren(child, clean);
    targetParent.appendChild(clean);
  }
}

/** Renders an event description's limited HTML safely, with links opened via the OS browser. */
function renderEventDescription(container, raw) {
  container.innerHTML = '';
  if (!raw) {
    container.textContent = '추가 설명 없음';
    return;
  }
  const parsed = new DOMParser().parseFromString(raw, 'text/html');
  appendSanitizedChildren(parsed.body, container);
  container.querySelectorAll('a').forEach((a) => {
    const href = a.dataset.href;
    if (!href) return;
    a.href = href; // cursor/tooltip only — click is intercepted below, it never navigates the widget itself
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.calendarAPI.openExternalUrl(href);
    });
  });
}

function renderDate() {
  const now = new Date();
  weekdayEl.textContent = `${WEEKDAYS_KO[now.getDay()]}요일`;
  daynumEl.textContent = String(now.getDate());
  monthEl.textContent = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' });
}

function renderGroups(groups) {
  lastRenderedGroups = groups;
  agendaEl.innerHTML = '';

  if (!groups || groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'widget__empty';
    empty.textContent = '일정 없음';
    agendaEl.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'widget__section';

    const title = document.createElement('h2');
    title.className = 'widget__section-title' + (group.isToday ? ' is-today' : '');
    title.textContent = group.label;
    section.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'widget__list';

    if (!group.events || group.events.length === 0) {
      const li = document.createElement('li');
      li.className = 'widget__empty';
      li.textContent = '일정 없음';
      list.appendChild(li);
    } else {
      for (const ev of group.events) {
        const li = document.createElement('li');
        li.className = 'widget__item';
        li.dataset.id = ev.id;
        if (ev.id === expandedEventKey) li.classList.add('is-expanded');

        const row = document.createElement('div');
        row.className = 'widget__item-row';

        const time = document.createElement('span');
        time.className = 'widget__item-time';
        time.textContent = ev.time;

        const evTitle = document.createElement('span');
        evTitle.className = 'widget__item-title';
        evTitle.textContent = ev.title;
        evTitle.title = ev.title;

        row.appendChild(time);
        row.appendChild(evTitle);
        row.addEventListener('click', () => {
          expandedEventKey = expandedEventKey === ev.id ? null : ev.id;
          renderGroups(lastRenderedGroups);
        });
        // Public holiday entries come from Google's own calendar — not editable/deletable.
        if (ev.source !== 'holiday') {
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openEventContextMenu(ev.id, e.clientX, e.clientY);
          });
        }
        li.appendChild(row);

        if (ev.id === expandedEventKey) {
          const detail = document.createElement('div');
          detail.className = 'widget__item-detail';

          if (ev.location) {
            const loc = document.createElement('div');
            loc.className = 'widget__item-location';
            loc.textContent = `📍 ${ev.location}`;
            detail.appendChild(loc);
          }

          const desc = document.createElement('div');
          desc.className = 'widget__item-description';
          renderEventDescription(desc, ev.description);
          if (ev.source !== 'holiday') {
            desc.addEventListener('click', (e) => {
              e.stopPropagation();
              if (e.target.closest('a')) return; // let the link handler above deal with it
              startEditDescription(ev.id);
            });
          }
          detail.appendChild(desc);

          li.appendChild(detail);
        }

        list.appendChild(li);
      }
    }

    section.appendChild(list);
    agendaEl.appendChild(section);
  }
}

// --- Event context menu (rename / delete) + inline description edit ---

function openEventContextMenu(id, x, y) {
  contextMenuEventId = id;
  eventContextMenu.style.left = `${x}px`;
  eventContextMenu.style.top = `${y}px`;
  eventContextMenu.classList.add('is-visible');
}

function closeEventContextMenu() {
  eventContextMenu.classList.remove('is-visible');
  contextMenuEventId = null;
}

document.addEventListener('click', (e) => {
  if (!eventContextMenu.contains(e.target)) closeEventContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeEventContextMenu();
});

function startEditEventTitle(id) {
  const found = findEvent(id);
  const li = agendaEl.querySelector(`[data-id="${id}"]`);
  if (!found || !li) return;
  const titleEl = li.querySelector('.widget__item-title');
  if (!titleEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = found.ev.title;
  input.style.cssText = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(127,181,255,0.4);border-radius:4px;color:#fff;font-size:13px;padding:1px 4px;';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (shouldSave) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    let changed = false;
    if (shouldSave && name && name !== found.ev.title) {
      const res = await window.calendarAPI.updateEvent(id, name, undefined);
      if (res.ok) {
        found.ev.title = name;
        changed = true;
      } else {
        showToast(`제목 수정 실패: ${res.error}`, { danger: true });
      }
    }
    renderGroups(lastRenderedGroups);
    if (changed) await refreshAgenda(); // catches up the month grid too, not just this list
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function startEditDescription(id) {
  const found = findEvent(id);
  const li = agendaEl.querySelector(`[data-id="${id}"]`);
  if (!found || !li) return;
  const descEl = li.querySelector('.widget__item-description');
  if (!descEl || descEl.tagName === 'TEXTAREA') return;

  const textarea = document.createElement('textarea');
  textarea.className = 'widget__item-description-input';
  textarea.value = found.ev.description || '';
  textarea.placeholder = '설명 입력...';
  descEl.replaceWith(textarea);
  textarea.focus();

  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    const description = textarea.value;
    let changed = false;
    if (description !== (found.ev.description || '')) {
      const res = await window.calendarAPI.updateEvent(id, undefined, description);
      if (res.ok) {
        found.ev.description = description;
        changed = true;
      } else {
        showToast(`설명 수정 실패: ${res.error}`, { danger: true });
      }
    }
    renderGroups(lastRenderedGroups);
    if (changed) await refreshAgenda();
  };

  textarea.addEventListener('blur', finish);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish();
  });
}

async function deleteEventFlow(id) {
  const found = findEvent(id);
  if (!found) return;
  if (!(await showConfirmDialog(`"${found.ev.title}" 일정을 삭제할까요?`))) return;
  const res = await window.calendarAPI.deleteEvent(id);
  if (!res.ok) return;
  found.group.events = found.group.events.filter((e) => e.id !== id);
  if (expandedEventKey === id) expandedEventKey = null;
  renderGroups(lastRenderedGroups);
  await refreshAgenda();
}

editEventMenuItem.addEventListener('click', () => {
  const id = contextMenuEventId;
  closeEventContextMenu();
  if (id) startEditEventTitle(id);
});

deleteEventMenuItem.addEventListener('click', () => {
  const id = contextMenuEventId;
  closeEventContextMenu();
  if (id) deleteEventFlow(id);
});

function renderFooter(timestamp, errorMessage) {
  if (errorMessage) {
    footerEl.textContent = `동기화 실패: ${errorMessage}`;
    return;
  }
  const time = new Date(timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  footerEl.textContent = `업데이트 ${time}`;
}

function renderSelectedCellPreview() {
  const cell = currentCells.find((c) => c.key === selectedCellKey);
  if (!cell) return;
  renderGroups([{ key: cell.key, label: cell.label, isToday: cell.isToday, events: cell.events }]);
}

function updateGridSelectionHighlight() {
  for (const el of monthWeeksEl.querySelectorAll('.gridPanel__cell')) {
    el.classList.toggle('is-selected', el.dataset.key === selectedCellKey);
  }
}

const BAR_ROW_HEIGHT = 11;
const BAR_GAP = 1;
const CELL_TOP_OFFSET = 20;

function buildDayCell(cell) {
  const btn = document.createElement('button');
  btn.className = 'gridPanel__cell';
  if (!cell.inMonth) btn.classList.add('is-outside');
  if (cell.isToday) btn.classList.add('is-today');
  if (cell.key === selectedCellKey) btn.classList.add('is-selected');
  btn.dataset.key = cell.key;

  const num = document.createElement('span');
  num.className = 'gridPanel__cellNum';
  num.textContent = String(cell.day);
  btn.appendChild(num);

  btn.addEventListener('click', () => {
    selectedCellKey = cell.key;
    updateGridSelectionHighlight();
    renderSelectedCellPreview();
    // A single grid day is effectively a "day" view — reflect that in the toggle.
    setActiveView('day');
  });

  return btn;
}

function buildWeekRow(weekCells, weekBars, rowHeight, laneCount) {
  const weekRow = document.createElement('div');
  weekRow.className = 'weekRow';
  weekRow.style.minHeight = `${rowHeight}px`;

  const cellsWrap = document.createElement('div');
  cellsWrap.className = 'weekRow__cells';
  for (const cell of weekCells) cellsWrap.appendChild(buildDayCell(cell));
  weekRow.appendChild(cellsWrap);

  if (laneCount > 0) {
    const barsWrap = document.createElement('div');
    barsWrap.className = 'weekRow__bars';
    barsWrap.style.gridTemplateRows = `repeat(${laneCount}, ${BAR_ROW_HEIGHT}px)`;
    for (const bar of weekBars.bars) {
      const barEl = document.createElement('div');
      barEl.className = 'weekRow__bar';
      if (bar.isStart) barEl.classList.add('is-start');
      if (bar.isEnd) barEl.classList.add('is-end');
      barEl.style.gridColumn = `${bar.startCol + 1} / ${bar.endCol + 2}`;
      barEl.style.gridRow = `${bar.lane + 1}`;
      barEl.style.background = bar.color;
      barEl.textContent = bar.title;
      barEl.title = bar.title;
      barsWrap.appendChild(barEl);
    }
    weekRow.appendChild(barsWrap);
  }

  return weekRow;
}

function renderMonthGrid(agenda) {
  monthLabelEl.textContent = agenda.monthLabel;
  currentCells = agenda.cells;

  // Every week row shares the same height (sized for the busiest week) so the
  // grid stays visually even regardless of which weeks have events.
  const laneCount = agenda.maxLaneCount || 0;
  const barsHeight = laneCount > 0 ? laneCount * BAR_ROW_HEIGHT + (laneCount - 1) * BAR_GAP : 0;
  const rowHeight = CELL_TOP_OFFSET + barsHeight + (laneCount > 0 ? 3 : 0);

  monthWeeksEl.innerHTML = '';
  for (let w = 0; w < 6; w++) {
    const weekCells = currentCells.slice(w * 7, w * 7 + 7);
    const weekBars = agenda.weeks[w] || { bars: [], laneCount: 0 };
    monthWeeksEl.appendChild(buildWeekRow(weekCells, weekBars, rowHeight, laneCount));
  }

  // If a previously-selected day still exists in the refreshed grid, keep its preview current.
  if (selectedCellKey && currentCells.some((c) => c.key === selectedCellKey)) {
    updateGridSelectionHighlight();
    renderSelectedCellPreview();
  }
}

async function loadList(view) {
  const payload = await window.calendarAPI.getListAgenda(view);
  if (!payload.ok) {
    renderFooter(null, payload.error);
    return;
  }
  if (!selectedCellKey) renderGroups(payload.agenda.groups);
  renderFooter(payload.agenda.fetchedAt, null);
}

async function loadGrid(offset) {
  gridProgressBar.start();
  const payload = await window.calendarAPI.getGrid(offset);
  gridProgressBar.finish();
  if (!payload.ok) {
    renderFooter(null, payload.error);
    return;
  }
  renderMonthGrid(payload.agenda);
  renderFooter(payload.agenda.fetchedAt, null);
}

/**
 * Re-fetches whatever's currently on screen (list, the grid too if it's
 * open, and mail — there's no separate mail-only refresh control, so the
 * one refresh button covers it too). Used by the manual refresh button, the
 * 20-minute auto-refresh timer, and after any edit the widget itself makes
 * (rename/delete/description) — a local DOM patch alone wouldn't reach the
 * month grid's bars/dots.
 */
async function refreshAgenda() {
  await loadList(currentView);
  if (gridOpen) await loadGrid(monthOffset);
  await loadMailSummary();
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  await refreshAgenda();
  setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
});

addEventBtn.addEventListener('click', async () => {
  const payload = await showAddEventPopup({});
  if (!payload) return;
  const res = await window.calendarAPI.addEvent(payload);
  if (res.ok) {
    await refreshAgenda();
  } else {
    showToast(`일정 추가 실패: ${res.error}`, { danger: true });
  }
});

openCalendarWebBtn.addEventListener('click', () => {
  const dateKeyMs = selectedCellKey ? Number(selectedCellKey) : null;
  window.calendarAPI.openCalendarHome(dateKeyMs);
});

notesBtn.addEventListener('click', () => {
  window.calendarAPI.openNotesWindow();
});

/**
 * Grid and mail are two mutually-exclusive side panels sharing one slot —
 * `next` is 'grid', 'mail', or null (close whichever is open). Only resizes
 * the OS window on an actual open-from-nothing or close-to-nothing edge;
 * switching directly between the two panels leaves the window exactly as
 * wide as it already was. See the comment that used to live on the old
 * per-panel grid handler for why resize and reveal/hide are ordered the
 * way they are around each other.
 */
async function setActivePanel(next) {
  const wasOpen = gridOpen || mailOpen;
  const willOpen = next !== null;

  if (willOpen && !wasOpen) {
    await window.calendarAPI.setSidePanelOpen(true);
  }

  if (gridOpen && next !== 'grid') {
    gridPanelEl.classList.remove('is-visible');
    gridToggleBtn.classList.remove('is-active');
    gridOpen = false;
  }
  if (mailOpen && next !== 'mail') {
    mailPanelEl.classList.remove('is-visible');
    mailToggleBtn.classList.remove('is-active');
    mailOpen = false;
    mailView = 'list';
  }

  if (next === 'grid') {
    gridOpen = true;
    gridToggleBtn.classList.add('is-active');
    gridPanelEl.classList.add('is-visible');
    monthOffset = 0;
    await loadGrid(monthOffset);
  } else if (next === 'mail') {
    mailOpen = true;
    mailToggleBtn.classList.add('is-active');
    mailPanelEl.classList.add('is-visible');
    await ensureMailLoaded();
    renderMailPanel();
  }

  if (!willOpen && wasOpen) {
    // Give Chromium a chance to actually paint the hidden state before the
    // native window shrink fires — otherwise the resize can land before the
    // display:none repaint does, and it stretches the still-wide old frame
    // into the new narrow bounds for a frame, reading as an overlap/flash.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await window.calendarAPI.setSidePanelOpen(false);
    selectedCellKey = null;
    await loadList(currentView);
  }
}

gridToggleBtn.addEventListener('click', () => setActivePanel(gridOpen ? null : 'grid'));
mailToggleBtn.addEventListener('click', () => setActivePanel(mailOpen ? null : 'mail'));

function formatMailTime(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function updateMailUnreadDot() {
  mailUnreadDotEl.classList.toggle('is-visible', mailAccounts.some((a) => a.unread > 0));
}

/** Merges a fresh listTodayMail() response into `mailAccounts` — adds rows for any account seen for the first time (Gmail or Naver, per its own `provider` field), updates the rest in place, and leaves an account's last-known data alone if this round's fetch for it failed. Safe to call whether or not the panel is open (it also drives the header dot). */
async function loadMailSummary() {
  if (mailOpen) mailProgressBar.start();
  const res = await window.calendarAPI.listTodayMail();
  if (mailOpen) mailProgressBar.finish();
  if (!res.ok) return;

  for (const accountRes of res.accounts) {
    let account = mailAccounts.find((a) => a.id === accountRes.accountKey);
    if (!account) {
      account = {
        id: accountRes.accountKey,
        provider: accountRes.provider,
        label: accountRes.email || accountRes.accountKey,
        expanded: false,
      };
      mailAccounts.push(account);
    }
    if (accountRes.email) account.label = accountRes.email; // real address, not a generic placeholder — matters once there's more than one

    if (!accountRes.ok) {
      // Still add/keep the row instead of skipping it — an account that
      // fails on its very first load (e.g. an expired Naver app password)
      // would otherwise never appear at all, which just looks like the
      // account vanished with no explanation.
      console.error(`Mail account '${accountRes.accountKey}' failed to load:`, accountRes.error);
      account.error = accountRes.error;
      continue;
    }
    account.error = null;
    account.total = accountRes.total;
    account.unread = accountRes.unread;
    account.messages = accountRes.messages;
  }

  updateMailUnreadDot();
  if (mailOpen && mailView === 'list') renderMailPanel();
}

async function ensureMailLoaded() {
  if (mailAccounts.length === 0) await loadMailSummary();
}

async function addMailAccountFlow() {
  mailProgressBar.start();
  const res = await window.calendarAPI.addMailAccount();
  mailProgressBar.finish();
  if (!res.ok) {
    showToast(`계정 추가 실패: ${res.error}`, { danger: true, container: mailPanelEl });
    return;
  }
  mailAccounts.push({
    id: res.accountKey,
    provider: 'gmail',
    label: res.email || res.accountKey,
    total: res.total,
    unread: res.unread,
    messages: res.messages,
    expanded: false,
  });
  updateMailUnreadDot();
  renderMailPanel();
}

/** Deep link to read this message in the provider's own webmail — `null` when there isn't one (e.g. an unknown provider). Gmail's `authuser` param routes to the right one of several signed-in accounts; Naver's URL was captured directly from the user's browser (folder "-1" = all mail) and its message id matched our IMAP UID exactly. */
function mailWebUrl(account, messageId) {
  if (!account) return null;
  if (account.provider === 'gmail') {
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.label)}#all/${messageId}`;
  }
  if (account.provider === 'naver') {
    return `https://mail.naver.com/v2/read/-1/${messageId}`;
  }
  return null;
}

// Keyed by `${accountId}:${messageId}`. A sent message's content never
// changes, so once fetched (and, for a table-bearing one, once Gemini's
// cleaned it up) reopening the same message should be instant instead of
// re-running the IMAP/Gmail fetch and the Gemini pass from scratch every
// time. Also means a translation survives closing and reopening the
// message, since the same message object — with its `.translated` cache —
// stays around instead of being replaced by a fresh fetch each time.
const mailMessageCache = new Map();

async function openMailMessage(accountId, messageId) {
  const account = mailAccounts.find((a) => a.id === accountId);
  const cacheKey = `${accountId}:${messageId}`;
  let msg = mailMessageCache.get(cacheKey);

  if (!msg) {
    mailProgressBar.start();
    const res = await window.calendarAPI.getMailMessage(account?.provider, accountId, messageId);
    mailProgressBar.finish();
    if (!res.ok) return;
    msg = res.message;
    mailMessageCache.set(cacheKey, msg);
  }

  const cachedRow = account && account.messages && account.messages.find((m) => m.id === messageId);
  if (cachedRow && cachedRow.isUnread) {
    cachedRow.isUnread = false;
    account.unread = Math.max(0, account.unread - 1);
    updateMailUnreadDot();
  }

  mailReadingAccountId = accountId;
  mailReadingMessage = msg;
  mailReadingShowTranslated = false;
  mailView = 'reading';
  renderMailPanel();

  // The raw extraction is already readable — show it immediately rather
  // than making the whole reading view wait on Gemini, and upgrade it in
  // place once the cleaned version comes back. Guarded so reopening the
  // same message while cleanup is still in flight (or after it's already
  // done) doesn't kick off a second, redundant pass.
  if (msg.hasTable && !msg.tableCleaned && !msg.tableCleaning) cleanMailTableInBackground(msg);
}

async function cleanMailTableInBackground(msg) {
  msg.tableCleaning = true;
  if (mailReadingMessage === msg) renderMailReading();
  mailProgressBar.start();
  const res = await window.calendarAPI.cleanMailTable(msg.text);
  mailProgressBar.finish();
  msg.tableCleaning = false;
  if (res.ok) {
    msg.text = res.cleaned;
    msg.tableCleaned = true; // only on success — leaves it retryable (e.g. after a rate limit) on the next open otherwise
  } else {
    showToast(`표 정리 실패: ${res.error}`, { danger: true, container: mailPanelEl });
  }
  if (mailReadingMessage === msg) renderMailReading();
}

async function toggleMailTranslation() {
  const msg = mailReadingMessage;
  if (!msg) return;

  if (mailReadingShowTranslated) {
    mailReadingShowTranslated = false;
    renderMailReading();
    return;
  }
  if (msg.translated) {
    mailReadingShowTranslated = true;
    renderMailReading();
    return;
  }

  mailProgressBar.start();
  const res = await window.calendarAPI.translateMail(msg.text);
  mailProgressBar.finish();
  if (!res.ok) {
    showToast(`번역 실패: ${res.error}`, { danger: true, container: mailPanelEl });
    return;
  }
  msg.translated = res.translated; // cached on the message object, so flipping back and forth doesn't re-request
  mailReadingShowTranslated = true;
  renderMailReading();
}

/** One account row (indented under its provider) plus its expanded message list, if any. */
function renderAccountRow(account) {
  const row = document.createElement('div');
  row.className = 'mailAccount mailAccount--account';

  const toggle = document.createElement('span');
  toggle.className = 'mailAccount__toggle';
  if (account.messages && account.messages.length > 0) toggle.textContent = account.expanded ? '▾' : '▸';

  const name = document.createElement('span');
  name.className = 'mailAccount__name';
  name.textContent = account.label;

  row.appendChild(toggle);
  row.appendChild(name);

  if (account.error) {
    const errBadge = document.createElement('span');
    errBadge.className = 'mailAccount__badge mailAccount__badge--error';
    errBadge.textContent = '연결 실패';
    row.appendChild(errBadge);
  } else if (account.unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'mailAccount__badge';
    badge.textContent = String(account.unread);
    row.appendChild(badge);
  }

  row.addEventListener('click', async () => {
    account.expanded = !account.expanded;
    await ensureMailLoaded();
    renderMailPanel();
  });
  mailBodyEl.appendChild(row);

  if (!account.expanded) return;

  if (account.error) {
    const errMsg = document.createElement('div');
    errMsg.className = 'mailPanel__empty mailPanel__empty--message';
    errMsg.textContent = `연결 실패: ${account.error}`;
    mailBodyEl.appendChild(errMsg);
    return;
  }

  if (!account.messages || account.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mailPanel__empty mailPanel__empty--message';
    empty.textContent = '오늘 온 메일이 없어요';
    mailBodyEl.appendChild(empty);
    return;
  }

  for (const msg of account.messages) {
    const item = document.createElement('div');
    item.className = 'mailMessage' + (msg.isUnread ? ' is-unread' : '');

    const subject = document.createElement('div');
    subject.className = 'mailMessage__subject';
    subject.textContent = msg.subject;

    const meta = document.createElement('div');
    meta.className = 'mailMessage__meta';
    meta.textContent = `${msg.from} · ${formatMailTime(msg.date)}`;

    item.appendChild(subject);
    item.appendChild(meta);
    item.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also toggle the account row's expand state
      openMailMessage(account.id, msg.id);
    });
    mailBodyEl.appendChild(item);
  }
}

/**
 * A minimal dark-themed email+password prompt for Naver (no OAuth to redirect
 * through — see naverService.js) — same visual language as the shared
 * confirmDialog, just with two inputs instead of a message. Resolves
 * {email, password} on submit, or null on cancel/escape.
 */
function showNaverLoginDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirmDialog__overlay';

    const box = document.createElement('div');
    box.className = 'confirmDialog__box confirmDialog__box--wide';

    const title = document.createElement('div');
    title.className = 'confirmDialog__message';
    title.textContent = '네이버 계정 추가';

    const hint = document.createElement('div');
    hint.className = 'confirmDialog__hint';
    hint.textContent = '2단계 인증 사용 중이면 앱 비밀번호를 입력하세요';

    // Naver's IMAP login only ever wants the bare ID anyway (see
    // naverService.js) — asking for just that, with the domain fixed as a
    // suffix, is one less thing to type and matches Naver's own login form.
    const idRow = document.createElement('div');
    idRow.className = 'confirmDialog__idRow';
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.placeholder = '아이디';
    idInput.className = 'confirmDialog__input confirmDialog__input--id';
    const idSuffix = document.createElement('span');
    idSuffix.className = 'confirmDialog__idSuffix';
    idSuffix.textContent = '@naver.com';
    idRow.appendChild(idInput);
    idRow.appendChild(idSuffix);

    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.placeholder = '비밀번호 / 앱 비밀번호';
    passwordInput.className = 'confirmDialog__input';

    const btns = document.createElement('div');
    btns.className = 'confirmDialog__btns';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirmDialog__btn';
    cancelBtn.textContent = '취소';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirmDialog__btn';
    confirmBtn.textContent = '추가';
    btns.appendChild(cancelBtn);
    btns.appendChild(confirmBtn);

    box.appendChild(title);
    box.appendChild(idRow);
    box.appendChild(passwordInput);
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const finish = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const submit = () => {
      const id = idInput.value.trim();
      const password = passwordInput.value;
      if (!id || !password) return;
      finish({ email: `${id}@naver.com`, password });
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter') submit();
    };

    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    cancelBtn.addEventListener('click', () => finish(null));
    confirmBtn.addEventListener('click', submit);
    idInput.focus();
  });
}

async function addNaverAccountFlow() {
  const creds = await showNaverLoginDialog();
  if (!creds) return;

  mailProgressBar.start();
  const res = await window.calendarAPI.addNaverAccount(creds.email, creds.password);
  mailProgressBar.finish();
  if (!res.ok) {
    showToast(`네이버 계정 추가 실패: ${res.error}`, { danger: true, container: mailPanelEl });
    return;
  }
  mailAccounts.push({
    id: res.email,
    provider: 'naver',
    label: res.email,
    total: res.total,
    unread: res.unread,
    messages: res.messages,
    expanded: false,
  });
  updateMailUnreadDot();
  renderMailPanel();
}

function addProviderAccountFlow(providerId) {
  if (providerId === 'gmail') {
    addMailAccountFlow();
  } else if (providerId === 'naver') {
    addNaverAccountFlow();
  }
}

function renderMailPanel() {
  if (mailView === 'reading') {
    renderMailReading();
    return;
  }

  mailBackBtn.style.visibility = 'hidden';
  mailLabelEl.textContent = '메일';
  mailBodyEl.innerHTML = '';

  for (const provider of MAIL_PROVIDERS) {
    const accounts = mailAccounts.filter((a) => a.provider === provider.id);
    const unreadTotal = accounts.reduce((sum, a) => sum + (a.unread || 0), 0);
    const expanded = mailProviderExpanded[provider.id];

    const row = document.createElement('div');
    row.className = 'mailAccount mailAccount--provider';

    const toggle = document.createElement('span');
    toggle.className = 'mailAccount__toggle';
    if (accounts.length > 0) toggle.textContent = expanded ? '▾' : '▸';

    const name = document.createElement('span');
    name.className = 'mailAccount__name mailAccount__name--provider';
    name.textContent = provider.label;

    row.appendChild(toggle);
    row.appendChild(name);

    if (unreadTotal > 0) {
      const badge = document.createElement('span');
      badge.className = 'mailAccount__badge';
      badge.textContent = String(unreadTotal);
      row.appendChild(badge);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'mailAccount__addBtn';
    addBtn.textContent = '+';
    addBtn.title = `${provider.label} 계정 추가`;
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also toggle the provider's own expand state
      addProviderAccountFlow(provider.id);
    });
    row.appendChild(addBtn);

    row.addEventListener('click', () => {
      mailProviderExpanded[provider.id] = !mailProviderExpanded[provider.id];
      renderMailPanel();
    });
    mailBodyEl.appendChild(row);

    if (!expanded) continue;

    if (accounts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mailPanel__empty mailPanel__empty--account';
      empty.textContent = '연결된 계정이 없어요';
      mailBodyEl.appendChild(empty);
      continue;
    }

    for (const account of accounts) renderAccountRow(account);
  }
}

function renderMailReading() {
  mailBackBtn.style.visibility = 'visible';
  mailLabelEl.textContent = '메일';
  mailBodyEl.innerHTML = '';
  const msg = mailReadingMessage;
  if (!msg) return;

  const subject = document.createElement('div');
  subject.className = 'mailReading__subject';
  subject.textContent = msg.subject;

  const fromRow = document.createElement('div');
  fromRow.className = 'mailReading__fromRow';

  const from = document.createElement('span');
  from.className = 'mailReading__from';
  from.textContent = `${msg.from} · ${formatMailTime(msg.date)}`;

  const actions = document.createElement('div');
  actions.className = 'mailReading__actions';

  const account = mailAccounts.find((a) => a.id === mailReadingAccountId);
  const webUrl = mailWebUrl(account, msg.id);
  if (webUrl) {
    const webBtn = document.createElement('button');
    webBtn.className = 'mailReading__translateBtn';
    webBtn.textContent = '웹에서 보기';
    webBtn.addEventListener('click', () => window.calendarAPI.openExternalUrl(webUrl));
    actions.appendChild(webBtn);
  }

  const translateBtn = document.createElement('button');
  translateBtn.className = 'mailReading__translateBtn';
  translateBtn.textContent = mailReadingShowTranslated ? '원문 보기' : '번역';
  translateBtn.addEventListener('click', toggleMailTranslation);
  actions.appendChild(translateBtn);

  fromRow.appendChild(from);
  fromRow.appendChild(actions);

  mailBodyEl.appendChild(subject);
  mailBodyEl.appendChild(fromRow);

  if (msg.tableCleaning) {
    const notice = document.createElement('div');
    notice.className = 'mailReading__cleaningNotice';
    notice.textContent = '표 정리 중…';
    mailBodyEl.appendChild(notice);
  }

  if (msg.hasAttachment) {
    const notice = document.createElement('div');
    notice.className = 'mailReading__attachmentNotice';
    notice.textContent = '첨부파일이 있어요 — 직접 확인해 주세요.';
    mailBodyEl.appendChild(notice);
  }

  const body = document.createElement('div');
  body.className = 'mailReading__body';
  const shownText = mailReadingShowTranslated && msg.translated ? msg.translated : msg.text;
  body.textContent = shownText || '(내용 없음)';
  mailBodyEl.appendChild(body);
}

mailBackBtn.addEventListener('click', () => {
  mailView = 'list';
  mailReadingMessage = null;
  renderMailPanel();
});

function setActiveView(view) {
  currentView = view;
  for (const b of viewToggleEl.querySelectorAll('.widget__viewBtn')) {
    b.classList.toggle('is-active', b.dataset.view === view);
  }
}

viewToggleEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.widget__viewBtn');
  if (!btn || btn.classList.contains('is-active')) return;

  selectedCellKey = null;
  updateGridSelectionHighlight();
  setActiveView(btn.dataset.view);
  loadList(currentView);
});

prevMonthBtn.addEventListener('click', () => {
  monthOffset -= 1;
  selectedCellKey = null;
  loadGrid(monthOffset);
});

nextMonthBtn.addEventListener('click', () => {
  monthOffset += 1;
  selectedCellKey = null;
  loadGrid(monthOffset);
});

window.calendarAPI.onAutoRefreshTick(refreshAgenda);
window.calendarAPI.onMailCheckTick(loadMailSummary);

renderDate();
loadList(currentView);
loadMailSummary();

// Keep the date/weekday fresh, and re-fetch the agenda once the day actually
// rolls over — otherwise "오늘/내일" (or the week's day-of-week grouping) kept
// showing the previous day's data until the next 20-minute auto-refresh.
let lastDateKey = new Date().toDateString();
setInterval(() => {
  renderDate();
  const nowKey = new Date().toDateString();
  if (nowKey !== lastDateKey) {
    lastDateKey = nowKey;
    refreshAgenda();
  }
}, 60 * 1000);
