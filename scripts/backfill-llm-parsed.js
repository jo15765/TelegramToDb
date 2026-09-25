'use strict';

/**
 * Re-classify existing SportsBroadcasts rows that are still ClassificationSource='parsed'
 * with no ChatGptSport — sends ProgramName through Gemini (OpenAI skipped by default).
 *
 * Usage:
 *   npm run backfill:llm -- --limit=30
 *   npm run backfill:llm -- --limit=30 --dry-run
 *   npm run backfill:llm -- --limit=30 --with-openai
 *   npm run backfill:llm -- --limit=30 --delay=8000
 */

try {
  require('dotenv').config();
} catch (_) {}

const sql = require('mssql');
const sqlserver = require('../lib/sqlserver');
const {
  classifyPrimaryCategoryDetailed,
  isConfigured,
  hasGemini,
  hasOpenAi,
  forceSkipOpenAi,
  resetGeminiCircuit,
  isGeminiCircuitOpen,
  geminiCircuitRemainingMs,
} = require('../lib/openai-sport-detect');

const DRY_RUN = process.argv.includes('--dry-run');
const WITH_OPENAI = process.argv.includes('--with-openai');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
const delayArg = process.argv.find((a) => a.startsWith('--delay='));
const DELAY_MS = delayArg ? parseInt(delayArg.split('=')[1], 10) : 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Skip placeholder / empty listings that shouldn't get an LLM label. */
function isJunkProgramName(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  const q = (s.match(/\?/g) || []).length;
  if (q >= 3 && q / s.replace(/\s/g, '').length > 0.15) return true;
  const hasMatchup = /\bvs\.?\b|\bat\b|\bv\b/i.test(s) || /\d{1,2}:\d{2}/.test(s);
  if (!hasMatchup && /^(Serie A|Bundesliga|Ligue\s*1|NWSL|MonoMAX|National League)/i.test(s)) {
    return true;
  }
  return false;
}

async function classifyWithWait(name, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (isGeminiCircuitOpen()) {
      const wait = geminiCircuitRemainingMs() + 1000;
      console.error(`waiting ${Math.round(wait / 1000)}s for Gemini cooldown…`);
      await sleep(wait);
      resetGeminiCircuit();
    }

    const classified = await classifyPrimaryCategoryDetailed(name);
    if (classified && classified.primary) return classified;

    const reason = (classified && classified.reason) || 'no LLM value';
    if (reason.includes('gemini_circuit_open') && attempt < maxRetries) {
      const wait = Math.max(geminiCircuitRemainingMs(), 90 * 1000);
      console.error(`rate-limited (${reason}). wait ${Math.round(wait / 1000)}s, retry ${attempt}/${maxRetries}…`);
      await sleep(wait);
      resetGeminiCircuit();
      continue;
    }
    return classified;
  }
  return { primary: null, reason: 'max_retries' };
}

async function main() {
  if (!sqlserver.isConfigured()) {
    console.error('MSSQL not configured in .env');
    process.exit(1);
  }
  if (!isConfigured()) {
    console.error('Need OPENAI_API_KEY and/or GEMINI_API_KEY in .env');
    process.exit(1);
  }
  if (!hasGemini()) {
    console.error('GEMINI_API_KEY required for backfill (OpenAI free tier is usually exhausted).');
    process.exit(1);
  }

  // Default: skip OpenAI — it 429s immediately and wastes the first call
  if (!WITH_OPENAI) {
    forceSkipOpenAi();
    console.error('[Backfill] Gemini-only mode (pass --with-openai to try OpenAI first)');
  }

  const config = sqlserver.getConfig();
  const table = (config.table || 'SportsBroadcasts').replace(/[^\w\[\].]/g, '');
  console.error(
    `[Backfill] Gemini` +
      (WITH_OPENAI && hasOpenAi() ? ' + OpenAI' : '') +
      `, delay=${DELAY_MS}ms` +
      (DRY_RUN ? ' (dry-run)' : '')
  );

  const pool = await sql.connect({
    server: config.server,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    options: config.options,
    connectionTimeout: config.connectionTimeout,
    requestTimeout: config.requestTimeout,
    pool: config.pool,
  });

  const top = LIMIT > 0 ? `TOP (${LIMIT})` : '';
  const result = await pool.request().query(`
    SELECT ${top}
      Id, ProgramName, SportsType, EspnSport, ChatGptSport, ClassificationSource
    FROM [dbo].[${table}]
    WHERE ClassificationSource = 'parsed'
      AND (ChatGptSport IS NULL OR LTRIM(RTRIM(ChatGptSport)) = '')
      AND ProgramName IS NOT NULL
      AND LTRIM(RTRIM(ProgramName)) <> ''
    ORDER BY Id
  `);

  const rows = result.recordset || [];
  console.error(`[Backfill] Found ${rows.length} parsed row(s) with empty ChatGptSport`);

  let skippedJunk = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row.ProgramName).trim();
    if (isJunkProgramName(name)) {
      skippedJunk++;
      console.error(`[Backfill] ${i + 1}/${rows.length} Id=${row.Id} SKIP junk: ${name.slice(0, 70)}`);
      continue;
    }

    process.stderr.write(`[Backfill] ${i + 1}/${rows.length} Id=${row.Id} … `);
    const classified = await classifyWithWait(name);
    if (!classified || !classified.primary) {
      failed++;
      console.error(`FAIL (${(classified && classified.reason) || 'no LLM value'})`);
      await sleep(DELAY_MS);
      continue;
    }

    const primary = classified.primary;
    const source = classified.source || 'gemini';
    console.error(`→ ${primary} (${source})`);

    if (!DRY_RUN) {
      await pool
        .request()
        .input('id', sql.Int, row.Id)
        .input('sport', sql.NVarChar(100), primary)
        .input('source', sql.NVarChar(20), source)
        .query(`
          UPDATE [dbo].[${table}]
          SET ChatGptSport = @sport,
              SportsType = @sport,
              ClassificationSource = @source
          WHERE Id = @id
        `);
    }
    updated++;
    await sleep(DELAY_MS);
  }

  try {
    await pool.close();
  } catch (_) {}

  console.log(
    `\n[Backfill] done. updated=${updated} failed=${failed} skippedJunk=${skippedJunk}` +
      (DRY_RUN ? ' (dry-run, no DB writes)' : '')
  );
  console.log('all done');
}

main().catch((e) => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
