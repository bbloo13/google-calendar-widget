const weekdayEl = document.getElementById('weekday');
const daynumEl = document.getElementById('daynum');
const monthEl = document.getElementById('month');
const agendaEl = document.getElementById('agenda');
const footerEl = document.getElementById('footer');
const refreshBtn = document.getElementById('refreshBtn');
const addEventBtn = document.getElementById('addEventBtn');
const notesBtn = document.getElementById('notesBtn');
const gridToggleBtn = document.getElementById('gridToggleBtn');
const viewToggleEl = document.getElementById('viewToggle');
const gridPanelEl = document.getElementById('gridPanel');
const monthLabelEl = document.getElementById('monthLabel');
const monthWeeksEl = document.getElementById('monthWeeks');
const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');

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

/** Finds an event object (and which group holds it) across the currently rendered groups. */
function findEvent(id) {
  for (const group of lastRenderedGroups || []) {
    const ev = (group.events || []).find((e) => e.id === id);
    if (ev) return { ev, group };
  }
  return null;
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
          desc.textContent = ev.description || '추가 설명 없음';
          if (ev.source !== 'holiday') {
            desc.addEventListener('click', (e) => {
              e.stopPropagation();
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
    if (shouldSave && name && name !== found.ev.title) {
      const res = await window.calendarAPI.updateEvent(id, name, undefined);
      if (res.ok) found.ev.title = name;
    }
    renderGroups(lastRenderedGroups);
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
    if (description !== (found.ev.description || '')) {
      const res = await window.calendarAPI.updateEvent(id, undefined, description);
      if (res.ok) found.ev.description = description;
    }
    renderGroups(lastRenderedGroups);
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
  const payload = await window.calendarAPI.getGrid(offset);
  if (!payload.ok) {
    renderFooter(null, payload.error);
    return;
  }
  renderMonthGrid(payload.agenda);
  renderFooter(payload.agenda.fetchedAt, null);
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  await loadList(currentView);
  if (gridOpen) await loadGrid(monthOffset);
  setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
});

addEventBtn.addEventListener('click', () => {
  const dateKeyMs = selectedCellKey ? Number(selectedCellKey) : null;
  window.calendarAPI.openCalendarHome(dateKeyMs);
});

notesBtn.addEventListener('click', () => {
  window.calendarAPI.openNotesWindow();
});

gridToggleBtn.addEventListener('click', async () => {
  gridOpen = !gridOpen;
  gridToggleBtn.classList.toggle('is-active', gridOpen);
  gridPanelEl.classList.toggle('is-visible', gridOpen);
  await window.calendarAPI.setGridOpen(gridOpen);

  if (gridOpen) {
    await loadGrid(monthOffset);
  } else {
    selectedCellKey = null;
    await loadList(currentView);
  }
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

window.calendarAPI.onAutoRefreshTick(async () => {
  await loadList(currentView);
  if (gridOpen) await loadGrid(monthOffset);
});

renderDate();
loadList(currentView);

// Keep the date/weekday fresh across midnight without a full reload.
setInterval(renderDate, 60 * 1000);
