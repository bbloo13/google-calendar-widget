/**
 * "Add to calendar" quick-add popup (title + date range, optional time),
 * shared by the widget and notes windows. Resolves with the payload for the
 * add-calendar-event IPC call, or null if the user cancelled.
 */
function showAddEventPopup({ title = '', description = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'eventPopup__overlay';

    const box = document.createElement('div');
    box.className = 'eventPopup__box';
    box.innerHTML = `
      <div class="eventPopup__title">일정에 추가</div>
      <label class="eventPopup__field">
        <span>제목</span>
        <input type="text" class="ep-title" />
      </label>
      <label class="eventPopup__field">
        <span>날짜</span>
        <span class="eventPopup__range">
          <input type="date" class="ep-date" />
          <span>~</span>
          <input type="date" class="ep-endDate" />
        </span>
      </label>
      <label class="eventPopup__field eventPopup__checkboxField">
        <input type="checkbox" class="ep-allDay" checked />
        <span>종일</span>
      </label>
      <label class="eventPopup__field ep-timeField" style="display:none">
        <span>시간</span>
        <span class="eventPopup__range">
          <input type="time" class="ep-startTime" />
          <span>~</span>
          <input type="time" class="ep-endTime" />
        </span>
      </label>
      <div class="eventPopup__btns">
        <button class="eventPopup__btn" data-action="cancel">취소</button>
        <button class="eventPopup__btn eventPopup__btn--primary" data-action="confirm">추가</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const titleInput = box.querySelector('.ep-title');
    const dateInput = box.querySelector('.ep-date');
    const endDateInput = box.querySelector('.ep-endDate');
    const allDayInput = box.querySelector('.ep-allDay');
    const timeField = box.querySelector('.ep-timeField');
    const startTimeInput = box.querySelector('.ep-startTime');
    const endTimeInput = box.querySelector('.ep-endTime');

    const todayISO = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    titleInput.value = title;
    dateInput.value = todayISO();
    endDateInput.value = todayISO();

    dateInput.addEventListener('change', () => {
      endDateInput.min = dateInput.value;
      if (endDateInput.value < dateInput.value) endDateInput.value = dateInput.value;
    });
    allDayInput.addEventListener('change', () => {
      timeField.style.display = allDayInput.checked ? 'none' : 'flex';
    });

    // Google rejects a timed event whose end isn't after its start ("The
    // specified time range is empty"), so the end time follows the start the
    // way the end date does: one hour later by default, capped at 23:59 so it
    // never wraps past midnight. "HH:MM" strings compare correctly as text.
    const toMinutes = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const oneHourAfter = (t) => {
      const n = Math.min(toMinutes(t) + 60, 23 * 60 + 59);
      return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    };
    const endNotAfterStartSameDay = () =>
      endDateInput.value === dateInput.value && endTimeInput.value <= startTimeInput.value;

    // Once the user sets the end time themselves it stops tracking the start
    // — it's only corrected if it would end up at or before the start.
    let endTimeEdited = false;
    startTimeInput.addEventListener('change', () => {
      if (!startTimeInput.value) return;
      if (!endTimeEdited || !endTimeInput.value || endNotAfterStartSameDay()) {
        endTimeInput.value = oneHourAfter(startTimeInput.value);
      }
    });
    endTimeInput.addEventListener('change', () => {
      endTimeEdited = !!endTimeInput.value; // clearing it hands control back to the start time
      if (endTimeInput.value && startTimeInput.value && endNotAfterStartSameDay()) {
        endTimeInput.value = oneHourAfter(startTimeInput.value);
      }
    });

    const finish = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });

    box.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
    box.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      const finalTitle = titleInput.value.trim() || '제목 없음';
      const date = dateInput.value;
      if (!date) return;
      const endDate = endDateInput.value >= date ? endDateInput.value : date;
      const payload = { title: finalTitle, date, endDate, description };
      if (!allDayInput.checked) {
        payload.time = startTimeInput.value || '09:00';
        payload.endTime = endTimeInput.value || oneHourAfter(payload.time);
        // Covers what the live handlers can't see, e.g. a multi-day range
        // narrowed back to a single day after the times were already set.
        if (endDate === date && payload.endTime <= payload.time) payload.endTime = oneHourAfter(payload.time);
      }
      finish(payload);
    });

    titleInput.focus();
    titleInput.select();
  });
}
