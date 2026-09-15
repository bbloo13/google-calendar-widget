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
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            reject(new Error(`Gemini API returned unparseable response (${res.statusCode})`));
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
 * language the mail is already in.
 */
async function cleanMailContent(roughText) {
  const prompt = `다음은 이메일 본문에서 1차로 추출한 텍스트야. 실제 사람이 읽어야 할 내용만 남기고, 광고 배너/푸터/구독 취소 링크 같은 건 빼줘. 불필요하게 벌어진 줄 간격은 정리하되 문단 구분은 자연스럽게 유지해줘. 언어는 절대 바꾸지 말고 원문 그대로 둬 — 번역하지 마. 정리된 본문 텍스트만 출력하고 다른 설명은 붙이지 마.\n\n---\n${roughText}`;
  return generateContent(prompt);
}

/** Translates mail text (already-cleaned) into Korean. */
async function translateToKorean(text) {
  const prompt = `다음 텍스트를 자연스러운 한국어로 번역해줘. 번역 결과만 출력하고 다른 설명은 붙이지 마.\n\n---\n${text}`;
  return generateContent(prompt);
}

module.exports = { isConfigured, cleanMailContent, translateToKorean };
