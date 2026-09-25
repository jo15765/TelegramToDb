/**
 * Private Telegram channel – "Live TV - Sport Schedules and announcements"
 *
 * Use this when you CANNOT add a bot as channel admin. It uses YOUR Telegram
 * account to read the private channel. First run: you enter phone + code (and
 * 2FA if you have it); session is saved so later runs need no login.
 *
 * See SETUP-PRIVATE-CHANNEL.md for step-by-step instructions.
 */

// Load .env if present (optional: npm install dotenv)
try {
  require('dotenv').config();
} catch (_) {}

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const { parseMessageText } = require('./lib/parse-sports');
const sqlserver = require('./lib/sqlserver');
const {
  enrichRecordsWithEspnSport,
  formatEspnClassificationLine,
} = require('./lib/espn-sport-detect');
const { enrichUnknownsWithChatGpt } = require('./lib/openai-sport-detect');

// --- Credentials: set in .env or environment ---
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10) || 0;
const API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();
// Your private channel invite link (e.g. https://t.me/+AbCdEfGhIjKlMnOp)
const TELEGRAM_INVITE_LINK = (process.env.TELEGRAM_INVITE_LINK || '').trim();

const SESSION_FILE = process.env.TELEGRAM_SESSION_FILE || path.join(__dirname, '.telegram-session');
const ENV_FILE = path.join(__dirname, '.env');
const ENV_EXAMPLE = path.join(__dirname, '.env.example');

function ensureEnvFile() {
  if (fs.existsSync(ENV_FILE)) return;
  if (fs.existsSync(ENV_EXAMPLE)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
    console.error('\nCreated .env from .env.example. Edit .env and add your credentials, then run again.\n');
  }
}

function checkConfig() {
  ensureEnvFile();
  const missing = [];
  if (!API_ID || !API_HASH || API_HASH === 'your_api_hash_here' || API_HASH === 'your_app_hash_here') {
    missing.push('TELEGRAM_API_ID and TELEGRAM_API_HASH (get them from https://my.telegram.org/apps)');
  }
  const inviteHash = extractInviteHash(TELEGRAM_INVITE_LINK);
  const isPlaceholderLink = !TELEGRAM_INVITE_LINK || /YOUR_INVITE|example\.com/i.test(TELEGRAM_INVITE_LINK);
  const channelTitle = (process.env.TELEGRAM_CHANNEL_TITLE || 'Live TV').trim();
  // Invite is optional if you're already a member — we resolve via dialogs by title.
  if ((isPlaceholderLink || !inviteHash) && !channelTitle) {
    missing.push('TELEGRAM_INVITE_LINK or TELEGRAM_CHANNEL_TITLE (channel name substring, e.g. Live TV)');
  }
  if (missing.length) {
    console.error('\nMissing config. No bot is used — the script signs in as YOU (your Telegram account) to read the channel.\n');
    console.error('Add these to the .env file in this folder:\n');
    console.error('  TELEGRAM_API_ID=your_app_id_number');
    console.error('  TELEGRAM_API_HASH=your_app_hash');
    console.error('  TELEGRAM_CHANNEL_TITLE=Live TV');
    console.error('  TELEGRAM_INVITE_LINK=https://t.me/+YourChannelInviteLink   # optional if already a member\n');
    console.error('Steps:');
    console.error('  1. Go to https://my.telegram.org/apps and create an app (any name). Copy the app’s api_id and api_hash.');
    console.error('     (This lets the script log in as you — no bot, no channel admin needed.)');
    console.error('  2. If you are already in the channel, set TELEGRAM_CHANNEL_TITLE to part of its name.');
    console.error('     Otherwise open the channel → Invite via link → put that in TELEGRAM_INVITE_LINK.');
    console.error('  3. Put the values in .env, then run: npm start');
    console.error('  4. First run only: enter your phone number and the code Telegram sends you.\n');
    throw new Error('Configure .env and run again. See SETUP-PRIVATE-CHANNEL.md for details.');
  }
}

function getTodayEST() {
  return getDateEST(0);
}

/** Return YYYY-MM-DD in EST for a given Date (no locale/format ambiguity). */
function toESTDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** dayOffset: 0 = today, -1 = yesterday, 1 = tomorrow (in EST). Returns YYYY-MM-DD. */
function getDateEST(dayOffset) {
  const d = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
  return toESTDateString(d);
}

function parseDayArg() {
  const argv = process.argv.slice(2);
  if (argv.includes('--last30') || argv.includes('--last-30')) return 'last30';
  const daysIdx = argv.indexOf('--days');
  if (daysIdx !== -1 && argv[daysIdx + 1] != null) {
    const n = parseInt(argv[daysIdx + 1], 10);
    if (!Number.isNaN(n) && n >= 1) return n; // number of days back
  }
  if (argv.includes('--yesterday')) return -1;
  const dayIdx = argv.indexOf('--day');
  if (dayIdx !== -1 && argv[dayIdx + 1] != null) {
    const n = parseInt(argv[dayIdx + 1], 10);
    if (!Number.isNaN(n)) return n; // -1 = yesterday, 0 = today, etc.
  }
  return 0;
}

const DAY_OFFSET = parseDayArg();
const DAYS_BACK = typeof DAY_OFFSET === 'number' && DAY_OFFSET > 0 ? DAY_OFFSET : (DAY_OFFSET === 'last30' ? 30 : null);

function getESTDateString(date) {
  if (date == null) return toESTDateString(new Date());
  const d = (typeof date === 'number' && date < 1e12)
    ? new Date(date * 1000)
    : (date instanceof Date ? date : new Date(date));
  return toESTDateString(d);
}

function extractInviteHash(link) {
  const s = String(link || '').trim();
  const match = s.match(/t\.me\/\+([A-Za-z0-9]+)/) || s.match(/^\+?([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return fs.readFileSync(SESSION_FILE, 'utf8').trim();
    }
  } catch (_) {}
  return '';
}

function saveSession(sessionString) {
  try {
    fs.writeFileSync(SESSION_FILE, sessionString, 'utf8');
  } catch (e) {
    console.error('Could not save session:', e.message);
  }
}

async function findChannelInDialogs(client) {
  const targetTitle = (process.env.TELEGRAM_CHANNEL_TITLE || 'Live TV').trim();
  console.error(`[Telegram] Looking for channel in dialogs matching "${targetTitle}"...`);
  const dialogs = await client.getDialogs({ limit: 500 });
  const found = dialogs.find(
    (d) => d.entity && d.title && d.title.toLowerCase().includes(targetTitle.toLowerCase())
  );
  if (found) {
    console.error(`[Telegram] Found channel in dialogs: "${found.title}"`);
    return found.entity;
  }
  const channelTitles = dialogs
    .filter((d) => d.entity && d.isChannel)
    .map((d) => d.title)
    .slice(0, 20);
  if (channelTitles.length) {
    console.error('[Telegram] Channels in your dialogs (first 20):', channelTitles.join(' | '));
  }
  return null;
}

async function getChannelEntity(client, inviteHash) {
  // Already a member? Resolve from dialogs first — no invite needed.
  const fromDialogs = await findChannelInDialogs(client);
  if (fromDialogs) return fromDialogs;

  // Not in dialogs yet: try joining via invite link.
  if (!inviteHash) {
    throw new Error(
      'Channel not found in your dialogs and no invite hash. Set TELEGRAM_CHANNEL_TITLE to match the channel name, or set a valid TELEGRAM_INVITE_LINK.'
    );
  }
  try {
    console.error('[Telegram] Channel not in dialogs; trying invite link...');
    const updates = await client.invoke(
      new Api.messages.ImportChatInvite({ hash: inviteHash })
    );
    if (updates && updates.chats && updates.chats.length) {
      return updates.chats[0];
    }
  } catch (e) {
    const msg = e.message || '';
    if (
      msg.includes('USER_ALREADY_PARTICIPANT') ||
      msg.includes('Already') ||
      msg.includes('INVITE_HASH_EXPIRED') ||
      msg.includes('INVITE_HASH_INVALID')
    ) {
      const again = await findChannelInDialogs(client);
      if (again) return again;
      throw new Error(
        `Invite failed (${msg.split('\n')[0]}). You may already be a member — set TELEGRAM_CHANNEL_TITLE in .env to part of the channel name (e.g. Live TV), then run again.`
      );
    }
    throw e;
  }
  return null;
}

async function fetchPrivateChannelSchedule() {
  checkConfig();
  const inviteHash = extractInviteHash(TELEGRAM_INVITE_LINK);

  const sessionString = loadSession();
  const client = new TelegramClient(
    new StringSession(sessionString),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  await client.start({
    phoneNumber: async () => await ask('Phone number (e.g. +1234567890): '),
    password: async () => await ask('2FA password (or press Enter if none): '),
    phoneCode: async () => await ask('Code from Telegram: '),
    onError: (err) => console.error(err),
  });

  const newSession = client.session.save();
  if (newSession) saveSession(newSession);

  const channel = await getChannelEntity(client, inviteHash);
  if (!channel) {
    throw new Error('Could not get channel. Check the invite link.');
  }

  const programs = [];
  let count = 0;
  let dayEST = null;
  let cutoffDateEST = null;

  if (DAYS_BACK != null) {
    // Fetch last N days (e.g. --last30 or --days 30)
    cutoffDateEST = getDateEST(-DAYS_BACK);
    dayEST = getDateEST(0); // today, for report
    console.error(`Fetching posts from the last ${DAYS_BACK} days (${cutoffDateEST} to ${dayEST} EST)...\n`);
    for await (const message of client.iterMessages(channel, { limit: 10000, waitTime: 0 })) {
      if (!message || !message.date) continue;
      count++;
      const msgDateEST = getESTDateString(message.date);
      if (msgDateEST < cutoffDateEST) break;
      const text = (message.text || '').trim();
      if (!text) continue;
      programs.push({
        text,
        datetime: message.date,
        url: (() => {
          const cid = String(channel.id ?? '').replace(/^-100/, '');
          const mid = message.id || '';
          return cid && mid ? `https://t.me/c/${cid}/${mid}` : '';
        })(),
      });
    }
  } else {
    // Single-day mode (today, yesterday, or --day N)
    dayEST = getDateEST(DAY_OFFSET);
    console.error(`Filtering for date: ${dayEST} (EST). Fetching until we pass that day...\n`);
    for await (const message of client.iterMessages(channel, { limit: 10000, waitTime: 0 })) {
      if (!message || !message.date) continue;
      count++;
      const msgDateEST = getESTDateString(message.date);
      if (msgDateEST < dayEST) break;
      if (msgDateEST !== dayEST) continue;
      const text = (message.text || '').trim();
      if (!text) continue;
      programs.push({
        text,
        datetime: message.date,
        url: (() => {
          const cid = String(channel.id ?? '').replace(/^-100/, '');
          const mid = message.id || '';
          return cid && mid ? `https://t.me/c/${cid}/${mid}` : '';
        })(),
      });
    }
  }

  programs.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  // Merge continuation messages (Telegram limits ~4096 chars per message; channel may split one block into multiple)
  const merged = [];
  for (let i = 0; i < programs.length; i++) {
    let text = programs[i].text;
    let url = programs[i].url;
    let datetime = programs[i].datetime;
    // If this message doesn't end with a Telegram link, next message may be the rest of the same post
    while (i + 1 < programs.length && !/\bhttps:\/\/t\.me\/\S+\s*$/.test(text.trimEnd()) && !programs[i + 1].text.trimStart().startsWith('--- ')) {
      i++;
      text += '\n' + programs[i].text;
      url = programs[i].url || url;
    }
    merged.push({ text, url, datetime });
  }
  const programsToUse = merged.length > 0 ? merged : programs;

  if (sqlserver.isConfigured()) {
    console.error(`[SQL] MSSQL configured. DB insert disabled — logging records only. Table would be: ${process.env.MSSQL_TABLE || 'SportsBroadcasts'}`);
    console.error(`[SQL] Processing ${programsToUse.length} message(s).\n`);
  } else {
    console.error('[SQL] MSSQL not configured (missing .env: MSSQL_HOST, MSSQL_USER, MSSQL_PASSWORD, MSSQL_DATABASE). Logging records only.');
  }

  const classifiedLines = [];
  {
    let totalParsed = 0;
    let totalSkipped = 0;
    let totalInserted = 0;
    let totalDbSkipped = 0;
    const allErrors = [];
    for (let i = 0; i < programsToUse.length; i++) {
      const p = programsToUse[i];
      const lines = p.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let records = parseMessageText(p.text);
      console.error(`[SQL] Message ${i + 1}/${programsToUse.length}: ${lines.length} lines → ${records.length} record(s) parsed`);
      if (records.length === 0) {
        console.error(`[SQL] Message ${i + 1}: no records, skipping.`);
        continue;
      }
      // Enrich SportsType via ESPN scoreboard API (team names + date)
      const espnResult = await enrichRecordsWithEspnSport(records, {
        onProgress: (done, total) => {
          if (total > 5 && (done % 10 === 0 || done === total)) {
            console.error(`[ESPN] Message ${i + 1}: lookups ${done}/${total}`);
          }
        },
      });
      if (espnResult.lookups > 0) {
        console.error(
          `[ESPN] Message ${i + 1}: ${espnResult.lookups} unique games → ${espnResult.enriched} classified, ${espnResult.unknown} unknown`
        );
      }
      // Anything ESPN couldn't classify → ChatGPT Primary category
      for (const r of records) {
        if (!r.espnSport) r.espnSport = null;
      }
      const gptResult = await enrichUnknownsWithChatGpt(records, {
        onProgress: (done, total) => {
          if (done === total || done % 5 === 0) {
            console.error(`[OpenAI] Message ${i + 1}: ChatGPT lookups ${done}/${total}`);
          }
        },
      });
      if (gptResult.lookups > 0) {
        console.error(
          `[LLM] Message ${i + 1}: ${gptResult.lookups} Unknown(s) → ${gptResult.enriched} classified` +
            (gptResult.failed != null ? `, ${gptResult.failed} LLM failed/empty` : '') +
            (gptResult.notAttempted ? `, ${gptResult.notAttempted} not attempted` : '')
        );
      }
      // Canonical SportsType: ESPN > LLM (ChatGPT/Gemini) > parsed
      for (const r of records) {
        if (r.espnSport) {
          r.sportsType = r.espnSport;
          r.classificationSource = 'espn';
        } else if (r.chatGptSport) {
          r.sportsType = r.chatGptSport;
          r.classificationSource = r.classificationSource || 'chatgpt';
        } else {
          r.classificationSource = r.classificationSource || 'parsed';
        }
      }
      const withChannel = records.filter((r) => r.airChannel && r.airChannel.trim().length > 0).length;
      totalParsed += records.length;
      totalSkipped += records.length - withChannel;
      for (const r of records) {
        classifiedLines.push(formatEspnClassificationLine(r));
      }
      console.error(`[SQL] Message ${i + 1}: calling insertBroadcasts for ${records.length} record(s)...`);
      const { inserted, errors, skippedCount } = await sqlserver.insertBroadcasts(records, p.url || null);
      totalInserted += inserted;
      totalDbSkipped += skippedCount;
      allErrors.push(...errors);
      console.error(
        `[SQL] Message ${i + 1}: inserted=${inserted} skipped=${skippedCount} errors=${errors.length}`
      );
    }
    if (totalParsed > 0) {
      console.error(
        `[SQL] Total: ${totalParsed} parsed, ${totalInserted} inserted, ${classifiedLines.length} classified lines` +
          (totalDbSkipped ? `, ${totalDbSkipped} skipped` : '') +
          (allErrors.length ? `, ${allErrors.length} errors` : '')
      );
    }
    if (allErrors.length > 0) {
      console.error('[SQL] Insert errors:', allErrors.slice(0, 10).join('; '), allErrors.length > 10 ? `... (+${allErrors.length - 10} more)` : '');
    }

    if (sqlserver.isConfigured()) {
      try {
        await sqlserver.runLastSecondUpdate();
      } catch (e) {
        console.error('[SQL] LastSecondUpdate failed:', e.message || e);
      }
    }
    console.log('all done');
  }

  await client.disconnect();
  rl.close();

  return {
    programs,
    classifiedLines,
    dayEST: dayEST || getDateEST(0),
    total: programs.length,
    allMessages: count,
    dayLabel: DAYS_BACK != null ? `last ${DAYS_BACK} days` : (DAY_OFFSET === 0 ? 'today' : DAY_OFFSET === -1 ? 'yesterday' : `day ${DAY_OFFSET}`),
    daysBack: DAYS_BACK,
    cutoffDateEST: cutoffDateEST || null,
  };
}

function printReport(data) {
  const label = data.dayLabel || 'today';
  const range = data.cutoffDateEST && data.dayEST ? `${data.cutoffDateEST} to ${data.dayEST}` : data.dayEST;
  console.log(`\nSports schedule – ${label}\n`);
  if (range) console.log(`Date range (EST): ${range}\n`);
  console.log(`Posts: ${data.total} (of ${data.allMessages} checked)\n`);

  const lines = data.classifiedLines || [];
  if (lines.length === 0) {
    if (!data.programs.length) {
      console.log(`No posts found.\n`);
      return;
    }
    console.log('No classified lines (parse/ESPN produced nothing). Raw posts:\n');
    data.programs.forEach((p, i) => {
      console.log(`--- ${i + 1} ---`);
      console.log(p.text);
      console.log('');
    });
    return;
  }

  console.log(`Classified events (${lines.length}):\n`);
  for (const line of lines) {
    console.log(line);
  }
  console.log('');
}

(async () => {
  try {
    const data = await fetchPrivateChannelSchedule();
    printReport(data);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
