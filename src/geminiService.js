const fs = require('fs');
const https = require('https');
const path = require('path');

const KEY_PATH = path.join(__dirname, '..', 'gemini-key.json');
const MODEL = 'gemini-3.6-flash';

let cachedApiKey = null;
function loadApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const raw = fs.readFileSync(KEY_PATH, 'utf-8');
  cachedApiKey = JSON.parse(raw).apiKey;
  return cachedApiKey;
}

function isConfigured() {
  return fs.existsSync(KEY_PATH);
}

function generateContent(prompt) {
  const apiKey = loadApiKey();
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    // This is a straightforward text-transform task, not something that
    // benefits from the model reasoning first — thinking mode on by default
    // burns hundreds of tokens and adds latency for no quality gain here.
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${MODEL}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        // Collect raw Buffer chunks and decode once at the end — appending
        // each chunk to a string separately (`data += chunk`) implicitly
        // UTF-8-decodes every chunk on its own, and a multi-byte character
        // (Korean included) that happens to land split across a chunk
        // boundary comes out corrupted on both sides of the split.
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            reject(new Error(`Gemini API returned unparseable response (${res.statusCode})`));
            return;
          }
          if (res.statusCode === 429) {
            // The full quota-exceeded body is a wall of docs links and metric
            // names meant for a developer reading logs, not a toast — a
            // free-tier per-minute cap is the only realistic way to hit this.
            reject(new Error('잠시 요청이 몰려서 한도를 넘었어요. 잠시 후 다시 시도해주세요.'));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(parsed.error?.message || `Gemini API error ${res.statusCode}`));
            return;
          }
          const text = (parsed.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
          resolve(text.trim());
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Cleans up an already-roughly-extracted mail body: drops boilerplate
 * (footers, unsubscribe links, tracking cruft) and normalizes spacing —
 * more robust than hand-rolled regex/whitespace rules since it reads the
 * text's actual structure instead of pattern-matching leftover HTML
 * artifacts, which vary a lot between senders' templates. Keeps whatever
 * language the mail is already in. Only called for table-bearing mail (see
 * `hasTable` in mailTextUtils.js) — the input's `셀1 | 셀2 | 셀3` lines are
 * our own best-effort flattening of an HTML <table>'s rows, not markdown;
 * this is what asks Gemini to turn that back into something readable.
 */
async function cleanMailContent(roughText) {
  const prompt = `다음은 이메일 본문에서 1차로 추출한 텍스트야. "셀1 | 셀2 | 셀3" 처럼 세로선으로 구분된 줄은 원래 표(테이블)였던 부분이야 — 이 구조를 사람이 읽기 편한 형태(예: 항목별 줄바꿈, "라벨: 값" 형식 등)로 자연스럽게 정리해줘. 실제 사람이 읽어야 할 내용만 남기고, 광고 배너/푸터/구독 취소 링크 같은 건 빼줘. 날짜, 가격, URL 같은 구체적인 정보는 절대 빠뜨리거나 바꾸지 마. 언어는 절대 바꾸지 말고 원문 그대로 둬 — 번역하지 마. 정리된 본문 텍스트만 출력하고 다른 설명은 붙이지 마.\n\n---\n${roughText}`;
  return generateContent(prompt);
}

/** Translates mail text (already-cleaned) into Korean. */
async function translateToKorean(text) {
  const prompt = `다음 텍스트를 자연스러운 한국어로 번역해줘. 번역 결과만 출력하고 다른 설명은 붙이지 마.\n\n---\n${text}`;
  return generateContent(prompt);
}

module.exports = { isConfigured, cleanMailContent, translateToKorean };
