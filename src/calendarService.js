const { google } = require('googleapis');
const { getAuthorizedClient } = require('../auth/googleAuth');

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];
const HOLIDAY_CALENDAR_ID = 'ko.south_korea#holiday@group.v.calendar.google.com';
const PRIMARY_COLOR = '#7fb5ff';
const HOLIDAY_COLOR = '#3aa76d';
const DAY_MS = 86400000;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeekMonday(date) {
  const d = startOfDay(date);
  const dow = d.getDay(); // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow; // move back to this week's Monday
  return addDays(d, diff);
}

function startOfMonth(date) {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

function dayKey(date) {
  return startOfDay(date).getTime();
}

function dayLabel(date, todayKey) {
  const isToday = dayKey(date) === todayKey;
  const label = `${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAYS_KO[date.getDay()]})`;
  return isToday ? `오늘 · ${label}` : label;
}

/** Parses a Calendar API start/end boundary (all-day `date` or timed `dateTime`) as a local Date. */
function parseBoundary(part) {
  if (part.date) {
    const [y, m, d] = part.date.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(part.dateTime);
}

function formatEvent(ev, source) {
  const isAllDay = !ev.start.dateTime;
  const startMoment = parseBoundary(ev.start);
  const endMomentExclusive = parseBoundary(ev.end);
  const startDay = startOfDay(startMoment);
  // Google's end boundary is exclusive; step back 1ms to land on the last real day.
  const endDayInclusive = startOfDay(new Date(endMomentExclusive.getTime() - 1));
  const spanDays = Math.round((endDayInclusive.getTime() - startDay.getTime()) / DAY_MS) + 1;

  return {
    id: ev.id,
    title: ev.summary || '(제목 없음)',
    isAllDay,
    time: isAllDay
      ? '종일'
      : startMoment.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: true }),
    startSortKey: startMoment.getTime(),
    startDayKey: startDay.getTime(),
    endDayKeyInclusive: endDayInclusive.getTime(),
    spanDays,
    isMultiDay: spanDays > 1,
    source,
    color: source === 'holiday' ? HOLIDAY_COLOR : PRIMARY_COLOR,
    description: ev.description || '',
    location: ev.location || '',
  };
}

async function listCalendarEvents(calendarApi, calendarId, timeMin, timeMax) {
  const res = await calendarApi.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });
  return res.data.items || [];
}

/** Fetches events from the user's primary calendar plus the KR public holiday calendar. */
async function listEvents(auth, timeMin, timeMax) {
  const calendar = google.calendar({ version: 'v3', auth });
  const [primaryItems, holidayItems] = await Promise.all([
    listCalendarEvents(calendar, 'primary', timeMin, timeMax),
    listCalendarEvents(calendar, HOLIDAY_CALENDAR_ID, timeMin, timeMax).catch((err) => {
      console.error('Failed to fetch holiday calendar:', err.message);
      return [];
    }),
  ]);
  return [
    ...primaryItems.map((ev) => formatEvent(ev, 'primary')),
    ...holidayItems.map((ev) => formatEvent(ev, 'holiday')),
  ];
}

function eventsForDay(events, dayKeyMs) {
  return events
    .filter((e) => dayKeyMs >= e.startDayKey && dayKeyMs <= e.endDayKeyInclusive)
    .sort((a, b) => a.startSortKey - b.startSortKey);
}

/** Day view: fixed "오늘" / "내일" groups, shown even when empty. */
async function fetchDayView(auth) {
  const todayStart = startOfDay(new Date());
  const tomorrowStart = addDays(todayStart, 1);
  const dayAfterStart = addDays(todayStart, 2);

  const events = await listEvents(auth, todayStart, dayAfterStart);

  return {
    view: 'day',
    groups: [
      { key: 'today', label: '오늘', isToday: true, events: eventsForDay(events, dayKey(todayStart)) },
      { key: 'tomorrow', label: '내일', isToday: false, events: eventsForDay(events, dayKey(tomorrowStart)) },
    ],
  };
}

/** Week view: Monday–Sunday of the current week, grouped per day (including empty days). */
async function fetchWeekView(auth) {
  const weekStart = startOfWeekMonday(new Date());
  const weekEnd = addDays(weekStart, 7);
  const todayKey = dayKey(new Date());

  const events = await listEvents(auth, weekStart, weekEnd);

  const groups = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const key = dayKey(day);
    groups.push({
      key: String(key),
      label: dayLabel(day, todayKey),
      isToday: key === todayKey,
      events: eventsForDay(events, key),
    });
  }
  return { view: 'week', groups };
}

/** Greedily packs overlapping bar segments into non-overlapping lanes. */
function assignLanes(segments) {
  const laneLastEndCol = [];
  const sorted = [...segments].sort((a, b) => a.startCol - b.startCol || b.endCol - a.endCol);
  for (const seg of sorted) {
    let lane = laneLastEndCol.findIndex((endCol) => endCol < seg.startCol);
    if (lane === -1) {
      lane = laneLastEndCol.length;
      laneLastEndCol.push(seg.endCol);
    } else {
      laneLastEndCol[lane] = seg.endCol;
    }
    seg.lane = lane;
    seg.color = seg.source === 'holiday' ? HOLIDAY_COLOR : PRIMARY_COLOR;
  }
  return { bars: sorted, laneCount: laneLastEndCol.length };
}

/**
 * Month view: a full 6x7 calendar grid (Monday-start) for the target month.
 * Single-day events surface as colored dots per cell; multi-day events are
 * packed into per-week "bar" segments (with lanes so overlapping spans don't
 * visually collide), similar to Google Calendar's month view.
 */
async function fetchMonthView(auth, monthOffset = 0) {
  const monthStart = startOfMonth(new Date());
  monthStart.setMonth(monthStart.getMonth() + monthOffset);
  const todayKey = dayKey(new Date());

  const gridStart = startOfWeekMonday(monthStart);
  const gridEnd = addDays(gridStart, 42);

  const events = await listEvents(auth, gridStart, gridEnd);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const key = dayKey(d);
    cells.push({
      key: String(key),
      day: d.getDate(),
      inMonth: d.getMonth() === monthStart.getMonth(),
      isToday: key === todayKey,
      label: dayLabel(d, todayKey),
      events: eventsForDay(events, key),
    });
  }

  // Every event — single-day included — becomes a lane-packed bar segment, so
  // a day with one event just shows its title in a one-column chip.
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const weekStartDate = addDays(gridStart, w * 7);
    const weekStartMs = weekStartDate.getTime();
    const weekEndMs = addDays(weekStartDate, 7).getTime();

    const segments = events
      .filter((e) => e.endDayKeyInclusive >= weekStartMs && e.startDayKey < weekEndMs)
      .map((e) => {
        const segStartMs = Math.max(e.startDayKey, weekStartMs);
        const segEndMs = Math.min(e.endDayKeyInclusive, weekEndMs - DAY_MS);
        return {
          id: e.id,
          title: e.title,
          source: e.source,
          startCol: Math.round((segStartMs - weekStartMs) / DAY_MS),
          endCol: Math.round((segEndMs - weekStartMs) / DAY_MS),
          isStart: segStartMs === e.startDayKey,
          isEnd: segEndMs === e.endDayKeyInclusive,
        };
      });

    weeks.push(assignLanes(segments));
  }

  const maxLaneCount = weeks.reduce((max, w) => Math.max(max, w.laneCount), 0);

  return {
    view: 'month',
    monthOffset,
    monthLabel: `${monthStart.getFullYear()}년 ${monthStart.getMonth() + 1}월`,
    cells,
    weeks,
    maxLaneCount,
  };
}

/**
 * Creates a single (optionally multi-day) event on the user's primary calendar.
 * `date` is required ('YYYY-MM-DD'); `endDate` defaults to `date`. `time`/`endTime`
 * ('HH:MM') are optional — omitting them creates an all-day event.
 */
async function createEvent(auth, { title, date, endDate, time, endTime, description }) {
  const calendar = google.calendar({ version: 'v3', auth });
  const finalEndDate = endDate && endDate >= date ? endDate : date;

  let start;
  let end;
  if (time) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    start = { dateTime: `${date}T${time}:00`, timeZone: tz };
    end = { dateTime: `${finalEndDate}T${endTime || time}:00`, timeZone: tz };
  } else {
    // All-day events use Google's exclusive end date — the user picks the last
    // inclusive day, so step one day past it.
    const nextDay = addDays(new Date(`${finalEndDate}T00:00:00`), 1);
    const y = nextDay.getFullYear();
    const m = String(nextDay.getMonth() + 1).padStart(2, '0');
    const d = String(nextDay.getDate()).padStart(2, '0');
    start = { date };
    end = { date: `${y}-${m}-${d}` };
  }

  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: { summary: title, description, start, end },
  });
  return res.data;
}

/** Patches only the given fields (title and/or description) of an existing primary-calendar event. */
async function updateEvent(auth, eventId, { title, description }) {
  const calendar = google.calendar({ version: 'v3', auth });
  const resource = {};
  if (title !== undefined) resource.summary = title;
  if (description !== undefined) resource.description = description;
  const res = await calendar.events.patch({ calendarId: 'primary', eventId, resource });
  return res.data;
}

async function deleteEvent(auth, eventId) {
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId: 'primary', eventId });
}

/**
 * Fetches the agenda for the given view ('day' | 'week' | 'month').
 * monthOffset is only used by the month view (0 = current month, ±N = other months).
 */
async function fetchAgenda(userDataDir, view = 'day', monthOffset = 0) {
  const auth = await getAuthorizedClient(userDataDir);

  let result;
  if (view === 'week') result = await fetchWeekView(auth);
  else if (view === 'month') result = await fetchMonthView(auth, monthOffset);
  else result = await fetchDayView(auth);

  return { ...result, fetchedAt: new Date().toISOString() };
}

module.exports = { fetchAgenda, createEvent, updateEvent, deleteEvent };
