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
        payload.endTime = endTimeInput.value || payload.time;
      }
      finish(payload);
    });

    titleInput.focus();
    titleInput.select();
  });
}
