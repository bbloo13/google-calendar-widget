// Shared between gmailService.js and naverService.js — mail body cleanup
// that isn't specific to either provider's API shape.

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      // Join same-row table cells with a separator before the generic tag
      // strip below would otherwise erase the column boundary between them
      // entirely (leaving two adjacent cells looking like unrelated lines).
      .replace(/<\/(td|th)>\s*/gi, ' | ')
      // A single newline for every block close, `<p>` included — a lot of
      // transactional mail wraps every short field in its own <p>, which
      // isn't a "paragraph" in the prose sense; treating it as one put a
      // full blank line between every field.
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      // Cell-join leaves a trailing " | " before each row's own newline.
      .replace(/\s*\|\s*\n/g, '\n')
  );
}

/** True if a string that's supposed to be plain text actually still has HTML tags in it — some senders mislabel their HTML body this way. */
function looksLikeHtml(text) {
  return /<[a-z][^>]*>/i.test(text);
}

/**
 * True if the HTML body contains a real table. A sender's plain-text
 * alternative almost always renders a table as one cell per line with no
 * column separator at all (mailparser's own auto-generated fallback does
 * the same) — information the HTML's <td>/<tr> structure still has, so for
 * table-bearing mail the HTML (via stripHtml's cell-joining above) reads
 * better than trusting the "plain" part at face value.
 */
function hasTable(html) {
  return /<table[\s>]/i.test(html || '');
}

/**
 * Drops every blank line rather than just collapsing runs of them. Real-world
 * HTML email markup (nested tables, spacer divs, a `<p>` per short field)
 * produces wildly different amounts of stray blank lines per sender/template,
 * and no fixed collapse threshold survives contact with all of them; the one
 * rule that can't fail this way is "no blank lines at all" — this reads a
 * little denser for genuinely multi-paragraph mail, but never produces the
 * stretched-out, one-line-per-screen mess a missed case leaves behind.
 */
function normalizeWhitespace(text) {
  // Runs even on text that never went through stripHtml — trusted "plain"
  // parts often still carry raw entities like &nbsp; (as with the stripHtml
  // path, this is a harmless no-op if they're already decoded).
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

module.exports = { stripHtml, looksLikeHtml, hasTable, normalizeWhitespace };
