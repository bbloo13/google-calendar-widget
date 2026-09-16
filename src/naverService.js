const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { stripHtml, looksLikeHtml, hasTable, normalizeWhitespace } = require('./mailTextUtils');

const IMAP_HOST = 'imap.naver.com';
const IMAP_PORT = 993;

function getAccountsPath(userDataDir) {
  return path.join(userDataDir, 'naver-accounts.json');
}

/** Every Naver account added so far — { email, password } each. Never leaves this machine (not in the git repo, not in the Drive-hosted app-settings folder). */
function listAccounts(userDataDir) {
  try {
    const raw = fs.readFileSync(getAccountsPath(userDataDir), 'utf-8');
    return JSON.parse(raw).accounts || [];
  } catch (_) {
    return [];
  }
}

function saveAccounts(userDataDir, accounts) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(getAccountsPath(userDataDir), JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
}

/** Adds an account after confirming the credentials actually work (a bad password otherwise wouldn't surface until the next list-today call). */
async function addAccount(userDataDir, email, password) {
  const accounts = listAccounts(userDataDir);
  if (accounts.some((a) => a.email === email)) {
    throw new Error('이미 추가된 계정이에요.');
  }
  await withClient({ email, password }, async () => {}); // throws if login fails
  accounts.push({ email, password });
  saveAccounts(userDataDir, accounts);
}

/**
 * imapflow throws every NO/BAD server response as a generic `Error("Command
 * failed")`, with the server's actual reason tucked away in `.responseText`
 * — surfacing that (when present) is the difference between a useful error
 * ("Invalid credentials") and this one being a dead end for the user.
 */
function describeImapError(err) {
  if (err && err.responseText) return new Error(err.responseText);
  return err;
}

// Keyed by account email. A fresh TLS connect + IMAP login is ~1s and the
// first mailbox SELECT after that is another ~400ms on Naver's server —
// paid on every single mail open when each call opened and tore down its
// own connection. Keeping one connection alive per account and reusing it
// makes every call after the first pay only for the command it actually
// needs (a re-SELECT of an already-selected mailbox is ~free).
const activeClients = new Map();

function makeClient(account) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    // Naver's IMAP wants the bare ID, not the full address — "bbloo", not
    // "bbloo@naver.com" — unlike Gmail. Authentication fails with the full
    // address even when the password is correct.
    auth: { user: account.email.split('@')[0], pass: account.password },
    logger: false,
  });
  // A dropped/idle-timed-out connection emits 'close' on its own — that's
  // the signal to stop reusing it, not something withClient's try/catch
  // sees. Without an 'error' listener too, Node treats an unhandled one as
  // a fatal error and crashes the whole app.
  client.on('error', () => {});
  client.on('close', () => {
    if (activeClients.get(account.email) === client) activeClients.delete(account.email);
  });
  return client;
}

async function withClient(account, fn) {
  let client = activeClients.get(account.email);
  if (!client || !client.usable) {
    client = makeClient(account);
    try {
      await client.connect();
    } catch (err) {
      throw describeImapError(err);
    }
    activeClients.set(account.email, client);
  }
  try {
    return await fn(client);
  } catch (err) {
    // Whatever just failed makes this connection suspect (auth revoked,
    // server-side hiccup mid-command) — drop it so the next call reconnects
    // fresh rather than reusing a client that may keep failing the same way.
    activeClients.delete(account.email);
    client.close();
    throw describeImapError(err);
  }
}

// imapflow formats a Date for IMAP's date-only SEARCH criteria by reading
// its *UTC* date (`date.toISOString().slice(0, 10)`) — a plain local
// midnight (new Date(y, m, d)) for a positive UTC offset like KST (+9) is
// still mid-afternoon the previous day in UTC, so that read always comes
// back "yesterday" and the server searches SINCE a day too early, no
// matter what time it actually is locally. Building at UTC midnight of the
// local calendar date instead keeps the date toISOString() reads in sync
// with what "today" means locally, regardless of the offset direction.
function startOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** Today's messages for one Naver account: envelope + flags only, same shape as gmailService's listTodayMessages. */
async function listTodayMessages(account) {
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since: startOfToday() }, { uid: true });
      if (!uids || uids.length === 0) return { total: 0, unread: 0, messages: [] };

      // uids from search() are UIDs, not sequence numbers — fetchAll needs
      // { uid: true } as its separate third (options) argument to address
      // the range that way; bundling it into the query object instead (as
      // an earlier version of this code did) makes it silently treat these
      // numbers as sequence numbers, which don't exist that high in a large
      // mailbox, so it fetches nothing without erroring.
      const fetched = await client.fetchAll(uids, { envelope: true, flags: true }, { uid: true });
      const rows = fetched.map((m) => {
        const from = (m.envelope && m.envelope.from && m.envelope.from[0]) || {};
        return {
          id: String(m.uid),
          from: from.name || from.address || '',
          subject: (m.envelope && m.envelope.subject) || '(제목 없음)',
          date: m.envelope && m.envelope.date ? new Date(m.envelope.date).toISOString() : '',
          isUnread: !m.flags || !m.flags.has('\\Seen'),
        };
      });
      rows.sort((a, b) => new Date(b.date) - new Date(a.date));

      return { total: rows.length, unread: rows.filter((r) => r.isUnread).length, messages: rows };
    } finally {
      lock.release();
    }
  });
}

/** Full content for the reading view. Also marks it \Seen, like opening mail anywhere else does. */
async function getMessage(account, uid) {
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidNum = Number(uid);
      const { content } = await client.download(uidNum, undefined, { uid: true });
      const parsed = await simpleParser(content);
      await client.messageFlagsAdd({ uid: uidNum }, ['\\Seen'], { uid: true });

      const hasAttachment = (parsed.attachments || []).some((att) => att.contentDisposition !== 'inline');

      // mailparser already prefers text/plain and falls back to a stripped
      // version of text/html on its own — stripHtml/looksLikeHtml/hasTable
      // here are the same defensive backstops gmailService uses: a mislabeled
      // "plain" part that's really raw HTML, or one that (tags or not) is a
      // naive one-cell-per-line table dump the HTML's <td>/<tr> structure
      // reads better than.
      let rawText;
      if (parsed.html && hasTable(parsed.html)) rawText = stripHtml(parsed.html);
      else if (parsed.text && looksLikeHtml(parsed.text)) rawText = stripHtml(parsed.text);
      else if (parsed.text) rawText = parsed.text;
      else if (parsed.html) rawText = stripHtml(parsed.html);
      else rawText = '';

      const from = parsed.from && parsed.from.value && parsed.from.value[0];
      return {
        id: uid,
        from: (from && (from.name || from.address)) || '',
        subject: parsed.subject || '(제목 없음)',
        date: parsed.date ? parsed.date.toISOString() : '',
        text: normalizeWhitespace(rawText),
        hasAttachment,
        hasTable: !!(parsed.html && hasTable(parsed.html)),
      };
    } finally {
      lock.release();
    }
  });
}

module.exports = { listAccounts, addAccount, listTodayMessages, getMessage };
