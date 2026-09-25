'use strict';

/**
 * Classify a schedule line via OpenAI, with Gemini fallback on OpenAI 429.
 * Returns the Primary category only (e.g. "Auto Racing", "Basketball").
 *
 * Env:
 *   OPENAI_API_KEY       – primary
 *   OPENAI_SPORT_MODEL   – default gpt-4o-mini
 *   GEMINI_API_KEY       – used when OpenAI 429s or OpenAI key missing
 *   GEMINI_SPORT_MODEL   – default gemini-3.6-flash
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_SPORT_MODEL || 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_SPORT_MODEL || 'gemini-3.6-flash';

/** Circuit open until this timestamp (ms). 0 = closed. */
let openaiCircuitUntil = 0;
let geminiCircuitUntil = 0;
let openaiCircuitLogged = false;
let geminiCircuitLogged = false;
let geminiFallbackLogged = false;

function isOpenAiCircuitOpen() {
  return Date.now() < openaiCircuitUntil;
}

function isGeminiCircuitOpen() {
  return Date.now() < geminiCircuitUntil;
}

function tripOpenAiCircuit(cooldownMs = 60 * 60 * 1000) {
  openaiCircuitUntil = Date.now() + cooldownMs;
}

function tripGeminiCircuit(cooldownMs = 90 * 1000) {
  geminiCircuitUntil = Date.now() + cooldownMs;
}

function resetGeminiCircuit() {
  geminiCircuitUntil = 0;
  geminiCircuitLogged = false;
}

/** Skip OpenAI for this process (e.g. backfill when free tier is exhausted). */
function forceSkipOpenAi() {
  openaiCircuitUntil = Date.now() + 24 * 60 * 60 * 1000;
  openaiCircuitLogged = true;
}

function geminiCircuitRemainingMs() {
  return Math.max(0, geminiCircuitUntil - Date.now());
}

function hasOpenAi() {
  return Boolean(process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim());
}

function hasGemini() {
  return Boolean(process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim());
}

function isConfigured() {
  return hasOpenAi() || hasGemini();
}

const SYSTEM = `You classify sports / motorsports / racing TV listings.
Given a short program title or schedule line, reply with ONLY valid JSON:
{"primaryCategory":"...","subCategory":"..."}
primaryCategory is the high-level sport (e.g. "Auto Racing", "Basketball", "Soccer", "Hockey", "Football", "Baseball", "Golf", "Tennis", "Combat Sports", "Other").
subCategory can be more specific (e.g. "Short Track Stock Car Racing").
If it is not a sports event, use primaryCategory "Other".
No markdown, no extra text.`;

function parsePrimaryFromJsonText(content) {
  if (!content) return null;
  try {
    const cleaned = String(content).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const primary =
      parsed.primaryCategory ||
      parsed.primary_category ||
      parsed['Primary category'] ||
      parsed.PrimaryCategory;
    if (primary && typeof primary === 'string') return primary.trim();
  } catch (_) {
    const m = String(content).match(/Primary\s*category\s*[:\-–]\s*(.+)/i);
    if (m) return m[1].split('\n')[0].replace(/\*+/g, '').trim();
    const m2 = String(content).match(/"primaryCategory"\s*:\s*"([^"]+)"/i);
    if (m2) return m2[1].trim();
  }
  return null;
}

async function classifyWithOpenAi(listingText) {
  if (!hasOpenAi() || isOpenAiCircuitOpen()) return null;

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `what sport classification would you give\n\n${listingText}` },
        ],
      }),
    });
  } catch (e) {
    console.error('[OpenAI] Request failed:', e.message || e);
    return { rateLimited: false, primary: null };
  }

  if (res.status === 429) {
    tripOpenAiCircuit();
    if (!openaiCircuitLogged) {
      openaiCircuitLogged = true;
      console.error('[OpenAI] Rate limited (429). Falling back to Gemini for remaining Unknowns.');
    }
    return { rateLimited: true, primary: null };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[OpenAI] ${res.status}: ${body.slice(0, 200)}`);
    return { rateLimited: false, primary: null };
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { rateLimited: false, primary: parsePrimaryFromJsonText(content), source: 'chatgpt' };
}

const GEMINI_FALLBACK_MODELS = [
  process.env.GEMINI_SPORT_MODEL || 'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
].filter((m, i, arr) => m && arr.indexOf(m) === i);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function geminiGenerateOnce(model, listingText) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY.trim(),
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: `what sport classification would you give\n\n${listingText}` }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
  });
  return res;
}

async function classifyWithGemini(listingText) {
  if (!hasGemini() || isGeminiCircuitOpen()) return null;

  if (!geminiFallbackLogged) {
    geminiFallbackLogged = true;
    console.error(
      `[Gemini] Classifying via ${GEMINI_FALLBACK_MODELS.join(' → ')}` +
         (isOpenAiCircuitOpen() ? ' (after OpenAI rate limit)' : '')
    );
  }

  for (const model of GEMINI_FALLBACK_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await geminiGenerateOnce(model, listingText);
      } catch (e) {
        console.error(`[Gemini] ${model} request failed:`, e.message || e);
        break; // try next model
      }

      if (res.status === 429) {
        tripGeminiCircuit();
        if (!geminiCircuitLogged) {
          geminiCircuitLogged = true;
          console.error(
            `[Gemini] Rate limited (429). Cooling down ${Math.round(geminiCircuitRemainingMs() / 1000)}s before more Gemini calls.`
          );
        }
        return null;
      }

      if (res.status === 503 || res.status === 500) {
        const body = await res.text().catch(() => '');
        if (attempt < 3) {
          const waitMs = 800 * attempt;
          console.error(`[Gemini] ${model} ${res.status} (busy). Retry ${attempt}/3 in ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }
        console.error(`[Gemini] ${model} still ${res.status} after retries. Trying next model. ${body.slice(0, 120)}`);
        break; // next model
      }

      if (res.status === 404) {
        console.error(`[Gemini] ${model} not available (404). Trying next model.`);
        break;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[Gemini] ${model} ${res.status}: ${body.slice(0, 200)}`);
        break;
      }

      const data = await res.json();
      const parts =
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts;
      const content = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : null;
      const primary = parsePrimaryFromJsonText(content);
      if (primary) return { primary, source: 'gemini' };
      const finish =
        data.candidates && data.candidates[0] && data.candidates[0].finishReason;
      if (finish && finish !== 'STOP') {
        console.error(`[Gemini] ${model} no text (finishReason=${finish})`);
      } else if (!content) {
        console.error(`[Gemini] ${model} empty candidate text`);
      } else {
        console.error(`[Gemini] ${model} could not parse primaryCategory from: ${String(content).slice(0, 120)}`);
      }
      return null;
    }
  }

  return null;
}

/**
 * Ask OpenAI (then Gemini on 429 / missing OpenAI) for primary category.
 * @returns {Promise<{ primary: string, source: string, reason?: string }|null>}
 */
async function classifyPrimaryCategoryDetailed(listingText) {
  if (!isConfigured()) return { primary: null, source: null, reason: 'no_api_keys' };
  const text = String(listingText || '').trim();
  if (!text) return { primary: null, source: null, reason: 'empty_text' };

  let openaiNote = null;
  if (hasOpenAi() && !isOpenAiCircuitOpen()) {
    const openaiResult = await classifyWithOpenAi(text);
    if (openaiResult && openaiResult.primary) {
      return { primary: openaiResult.primary, source: 'chatgpt' };
    }
    if (openaiResult && openaiResult.rateLimited) openaiNote = 'openai_429';
    else if (isOpenAiCircuitOpen()) openaiNote = 'openai_circuit_open';
    else openaiNote = 'openai_empty_or_error';
  } else if (hasOpenAi() && isOpenAiCircuitOpen()) {
    openaiNote = 'openai_circuit_open';
  } else {
    openaiNote = 'openai_skipped';
  }

  if (hasGemini()) {
    if (isGeminiCircuitOpen()) {
      return { primary: null, source: null, reason: `${openaiNote}+gemini_circuit_open` };
    }
    const geminiResult = await classifyWithGemini(text);
    if (geminiResult && geminiResult.primary) return geminiResult;
    return {
      primary: null,
      source: null,
      reason: `${openaiNote}+gemini_empty_or_error`,
    };
  }

  return { primary: null, source: null, reason: `${openaiNote}+no_gemini_key` };
}

/** @returns {Promise<string|null>} Primary category or null */
async function classifyPrimaryCategory(listingText) {
  const result = await classifyPrimaryCategoryDetailed(listingText);
  return result && result.primary ? result.primary : null;
}

/**
 * For records still Unknown after ESPN, classify via OpenAI → Gemini fallback.
 * Sets chatGptSport (LLM result) and classificationSource ('chatgpt' | 'gemini').
 */
async function enrichUnknownsWithChatGpt(records, options = {}) {
  if (!isConfigured()) {
    console.error('[LLM] Neither OPENAI_API_KEY nor GEMINI_API_KEY set — skipping Unknown classification.');
    return { lookups: 0, enriched: 0 };
  }

  // Soften load on Gemini free tier (503s) when OpenAI is already rate-limited
  const concurrency = Math.max(
    1,
    parseInt(options.concurrency, 10) || (isOpenAiCircuitOpen() || !hasOpenAi() ? 1 : 3)
  );
  const delayMs = Math.max(
    0,
    parseInt(options.delayMs, 10) ?? (isOpenAiCircuitOpen() || !hasOpenAi() ? 500 : 200)
  );
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const need = [];
  const textToRecords = new Map();
  for (const r of records) {
    if (r.espnSport && r.espnSport !== 'Unknown') continue;
    const text =
      (r.programName && String(r.programName).trim()) ||
      [r.team1, r.team2].filter(Boolean).join(' vs. ') ||
      [r.airChannel, r.sportsType].filter(Boolean).join(' ');
    if (!text) continue;
    const key = text.toLowerCase();
    if (!textToRecords.has(key)) {
      textToRecords.set(key, []);
      need.push(text);
    }
    textToRecords.get(key).push(r);
  }

  if (need.length === 0) return { lookups: 0, enriched: 0 };

  const providers = [
    hasOpenAi() ? `OpenAI(${OPENAI_MODEL})` : null,
    hasGemini() ? `Gemini(${GEMINI_MODEL})` : null,
  ]
    .filter(Boolean)
    .join(' → ');
  console.error(`[LLM] Classifying ${need.length} Unknown listing(s) via ${providers}...`);

  const cache = new Map();
  let done = 0;
  let enriched = 0;
  let llmFailed = 0;

  async function runOne(text) {
    const result = await classifyPrimaryCategoryDetailed(text);
    cache.set(text.toLowerCase(), result);
    done++;
    if (!result || !result.primary) llmFailed++;
    if (onProgress) onProgress(done, need.length);
  }

  for (let i = 0; i < need.length; i += concurrency) {
    if (isOpenAiCircuitOpen() && isGeminiCircuitOpen()) {
      const wait = geminiCircuitRemainingMs() + 500;
      console.error(
        `[LLM] Both circuits open — waiting ${Math.round(wait / 1000)}s for Gemini cooldown (${done}/${need.length} done)…`
      );
      await new Promise((r) => setTimeout(r, wait));
      resetGeminiCircuit();
    }
    if (isOpenAiCircuitOpen() && !hasGemini()) {
      console.error(`[LLM] Stopping early: OpenAI rate-limited and no GEMINI_API_KEY. ${done}/${need.length} done.`);
      break;
    }
    if (!hasOpenAi() && isGeminiCircuitOpen()) {
      const wait = geminiCircuitRemainingMs() + 500;
      console.error(`[LLM] Gemini cooling down ${Math.round(wait / 1000)}s…`);
      await new Promise((r) => setTimeout(r, wait));
      resetGeminiCircuit();
    }
    const batch = need.slice(i, i + concurrency);
    await Promise.all(batch.map((t) => runOne(t)));
    if (delayMs && i + concurrency < need.length) await new Promise((r) => setTimeout(r, delayMs));
  }

  for (const [key, recs] of textToRecords) {
    const result = cache.get(key);
    const sport = result && result.primary ? result.primary : null;
    const source = result && result.source ? result.source : null;
    for (const r of recs) {
      r.chatGptSport = sport;
      if (sport) {
        if (!r.espnSport || r.espnSport === 'Unknown') {
          r.sportsType = sport;
          r.classificationSource = source || 'chatgpt';
        }
        enriched++;
      }
    }
  }

  const skippedUnprocessed = need.length - done;
  console.error(
    `[LLM] Done: attempted=${done}/${need.length}, classified=${enriched}, failed/empty=${llmFailed}` +
      (skippedUnprocessed > 0 ? `, notAttempted=${skippedUnprocessed} (circuit stopped early)` : '')
  );

  return { lookups: need.length, enriched, failed: llmFailed, attempted: done, notAttempted: skippedUnprocessed };
}

module.exports = {
  isConfigured,
  hasOpenAi,
  hasGemini,
  classifyPrimaryCategory,
  classifyPrimaryCategoryDetailed,
  enrichUnknownsWithChatGpt,
  forceSkipOpenAi,
  resetGeminiCircuit,
  isGeminiCircuitOpen,
  isOpenAiCircuitOpen,
  geminiCircuitRemainingMs,
  tripGeminiCircuit,
};
