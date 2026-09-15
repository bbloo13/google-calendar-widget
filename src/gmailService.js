const { google } = require('googleapis');

// Cached the same way driveService caches its client — rebuilt only when the
// auth object itself changes (e.g. after a dead-token self-heal).
let cachedGmail = null;
let cachedGmailAuth = null;
function gmailClient(auth) {
  if (!cachedGmail || cachedGmailAuth !== auth) {
    cachedGmail = google.gmail({ version: 'v1', auth });
    cachedGmailAuth = auth;
  }
  return cachedGmail;
}

function header(headers, name) {
  const found = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address is returned as-is. */
function displayNameFromHeader(raw) {
  const match = raw.match(/^"?([^"<]+)"?\s*<[^>]+>$/);
  return match ? match[1].trim() : raw;
}

function todayQueryRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const fmt = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `after:${fmt(start)} before:${fmt(end)}`;
}

/** Today's messages for this account: lightweight (headers only, no body) — enough for a list row plus the unread badge count. Also returns the account's own address, so the widget can label the row by who it actually is once there's more than one. */
async function listTodayMessages(auth) {
  const gmail = gmailClient(auth);
  const [listRes, profileRes] = await Promise.all([
    gmail.users.messages.list({ userId: 'me', q: todayQueryRange(), maxResults: 50 }),
    gmail.users.getProfile({ userId: 'me' }),
  ]);
  const email = profileRes.data.emailAddress;
  const ids = listRes.data.messages || [];
  if (ids.length === 0) return { email, total: 0, unread: 0, messages: [] };

  const messages = await Promise.all(
    ids.map(({ id }) =>
      gmail.users.messages
        .get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
        .then((res) => res.data)
    )
  );

  const rows = messages.map((m) => ({
    id: m.id,
    from: displayNameFromHeader(header(m.payload.headers, 'From')),
    subject: header(m.payload.headers, 'Subject') || '(제목 없음)',
    date: header(m.payload.headers, 'Date'),
    isUnread: (m.labelIds || []).includes('UNREAD'),
  }));
  // Gmail's search order is already newest-first; messages.get responses can
  // arrive out of order once fetched in parallel, so re-sort by date to match.
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));

  return { email, total: rows.length, unread: rows.filter((r) => r.isUnread).length, messages: rows };
}

function decodeBody(data) {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // A single newline for every block close, `<p>` included — a lot of
    // transactional mail (like this) wraps every short field in its own
    // <p>, which isn't a "paragraph" in the prose sense; treating it as one
    // put a full blank line between every field.
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Drops every blank line rather than just collapsing runs of them — applied
 * to whichever text extractContent settles on. Real-world HTML email markup
 * (nested tables, spacer divs, a `<p>` per short field) produces wildly
 * different amounts of stray blank lines per sender/template, and no fixed
 * collapse threshold survives contact with all of them; the one rule that
 * can't fail this way is "no blank lines at all" — this reads a little
 * denser for genuinely multi-paragraph mail, but never produces the
 * stretched-out, one-line-per-screen mess a missed case leaves behind.
 */
function normalizeWhitespace(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Walks the MIME part tree for the best plain-text body (falling back to the
 * HTML part, stripped of tags, when there's no text/plain alternative — a
 * lot of newsletter/marketing mail only sends HTML) and whether any part
 * looks like a real attached file. "Real" is a judgment call: Gmail's own
 * web client marks genuine attachments `Content-Disposition: attachment`,
 * while inline signature/logo images (also often carrying a filename) are
 * marked `inline` — so a named part is only counted unless it's explicitly
 * inline, not the other way around.
 */
function extractContent(payload) {
  let plainText = null;
  let htmlText = null;
  let hasAttachment = false;

  function walk(part) {
    if (!part) return;
    if (part.filename) {
      const disposition = header(part.headers, 'Content-Disposition');
      if (!/inline/i.test(disposition)) hasAttachment = true;
    }
    if (part.mimeType === 'text/plain' && part.body && part.body.data && !plainText) {
      plainText = decodeBody(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body && part.body.data && !htmlText) {
      htmlText = decodeBody(part.body.data);
    }
    (part.parts || []).forEach(walk);
  }
  walk(payload);

  const rawText = plainText || (htmlText ? stripHtml(htmlText) : '');
  return { text: normalizeWhitespace(rawText), hasAttachment };
}

/** Full content for the reading view — from/subject/date plus the extracted text and attachment flag. Also marks it read, like opening mail anywhere else does. */
async function getMessage(auth, messageId) {
  const gmail = gmailClient(auth);
  const [res] = await Promise.all([
    gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' }),
    gmail.users.messages.modify({ userId: 'me', id: messageId, resource: { removeLabelIds: ['UNREAD'] } }),
  ]);
  const { payload } = res.data;
  const { text, hasAttachment } = extractContent(payload);
  return {
    id: res.data.id,
    from: displayNameFromHeader(header(payload.headers, 'From')),
    subject: header(payload.headers, 'Subject') || '(제목 없음)',
    date: header(payload.headers, 'Date'),
    text,
    hasAttachment,
  };
}

module.exports = { listTodayMessages, getMessage };
