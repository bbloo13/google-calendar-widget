// Verifies week/month grouping logic against the real userData token.
const path = require('path');
const { fetchAgenda } = require('../src/calendarService');

const REAL_USERDATA = path.join(process.env.APPDATA, 'calendar-widget');

async function main() {
  for (const view of ['day', 'week', 'month']) {
    const agenda = await fetchAgenda(REAL_USERDATA, view);
    console.log(`\n=== ${view} ===`);
    for (const g of agenda.groups) {
      console.log(`${g.label}${g.isToday ? ' [TODAY]' : ''}: ${g.events.length} event(s)`);
      for (const ev of g.events) console.log(`  - ${ev.time} ${ev.title}`);
    }
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
