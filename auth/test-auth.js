// Standalone OAuth + Calendar smoke test — run with `npm run test-auth`.
// Verifies the loopback auth flow and token persistence work before wiring
// anything into the Electron app.
const path = require('path');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('./googleAuth');

const TEST_USER_DATA_DIR = path.join(__dirname, '.test-userdata');

async function main() {
  console.log('Requesting authorized client (will open browser on first run)...');
  const auth = await getAuthorizedClient(TEST_USER_DATA_DIR);
  console.log('Authorized. Token stored at', path.join(TEST_USER_DATA_DIR, 'token.json'));

  const calendar = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const endOfTomorrow = new Date(now);
  endOfTomorrow.setDate(now.getDate() + 2);
  endOfTomorrow.setHours(0, 0, 0, 0);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: endOfTomorrow.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];
  console.log(`\nFetched ${events.length} event(s) for today/tomorrow:\n`);
  for (const ev of events) {
    const start = ev.start.dateTime || ev.start.date;
    console.log(`- [${start}] ${ev.summary}`);
  }
}

main().catch((err) => {
  console.error('Auth test failed:', err);
  process.exit(1);
});
