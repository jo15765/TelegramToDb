/**
 * Telegram Sports Schedule – "Live TV - Sport Schedules and announcements"
 *
 * Fetches posts from a Telegram channel and prints programs for the current day (EST).
 * No login required; channel must be public. You need the channel username (from t.me/ link).
 */

const { telegram_scraper } = require('telegram-scraper');

// Set your channel username here (the part after t.me/ in the channel link).
// Must be a PUBLIC channel (e.g. t.me/ChannelName). Private invite links (t.me/+xxx) do not work.
const TELEGRAM_CHANNEL = 'YourChannelUsername';

function getTodayEST() {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function getESTDateString(isoOrDate) {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return d.toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

async function getSportsScheduleFromTelegram(channelUsername) {
  let username = String(channelUsername || '').replace(/^@/, '').trim();

  // If they passed a full t.me URL, extract the username (last path segment).
  if (username.startsWith('http://') || username.startsWith('https://')) {
    try {
      const u = new URL(username);
      const path = u.pathname.replace(/^\/+|\/+$/g, '');
      // Private invite links look like t.me/+0aNWxHw19zJkYzQ0 — scraper can't use these.
      if (path.startsWith('+')) {
        throw new Error(
          'Private invite links (t.me/+xxx) are not supported. This script only works with PUBLIC channels that have a username. ' +
            'Ask the channel admin for the public link (e.g. t.me/ChannelName) or use a tool that logs in with your Telegram account.'
        );
      }
      username = path.split('/').pop() || ''; // "s/ChannelName" -> "ChannelName"
    } catch (e) {
      if (e.message && e.message.includes('Private invite')) throw e;
      username = '';
    }
  }

  // Telegram usernames: letters, numbers, underscores, hyphens (no spaces).
  username = username.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');

  if (!username) {
    throw new Error(
      'Invalid channel: use the username only (e.g. LiveTVSportSchedules), or a full t.me/ link. No spaces.'
    );
  }

  const targetUrl = `https://t.me/s/${username}`;
  try {
    new URL(targetUrl);
  } catch (e) {
    throw new Error(`Invalid channel username "${username}": ${e.message}`);
  }

  const raw = await telegram_scraper(username);
  const messages = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
  const dayEST = getTodayEST();

  const programs = messages
    .filter((m) => {
      const dt = m.datetime || m.date;
      if (!dt) return false;
      return getESTDateString(dt) === dayEST;
    })
    .map((m) => ({
      text: m.message_text || m.text || '',
      datetime: m.datetime || m.date,
      url: m.message_url || m.url,
      dateEST: m.datetime ? getESTDateString(m.datetime) : dayEST,
      views: m.views
    }))
    .sort((a, b) => new Date(a.datetime || 0) - new Date(b.datetime || 0));

  return {
    programs,
    dayEST,
    total: programs.length,
    allMessages: messages.length
  };
}

function printReport(data) {
  console.log(`\nSports schedule for ${data.dayEST} (EST) – from Telegram\n`);
  console.log(`Posts today: ${data.total} (of ${data.allMessages} fetched)\n`);
  if (data.programs.length === 0) {
    console.log('No posts found for today. Try again later or check the channel username.\n');
    return;
  }
  data.programs.forEach((p, i) => {
    const time = p.datetime
      ? new Date(p.datetime).toLocaleString('en-US', {
          timeZone: 'America/New_York',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      : '';
    console.log(`--- ${i + 1} ---`);
    if (time) console.log(`Time (EST): ${time}`);
    console.log(p.text.slice(0, 500) + (p.text.length > 500 ? '...' : ''));
    if (p.url) console.log(p.url);
    console.log('');
  });
}

async function main() {
  const channel =
    TELEGRAM_CHANNEL ||
    process.env.TELEGRAM_CHANNEL ||
    process.env.TELEGRAM_CHANNEL_USERNAME ||
    process.argv[2];
  if (!channel || channel === 'YourChannelUsername') {
    console.error('Set TELEGRAM_CHANNEL at the top of index.js, or use env/argument.');
    console.error('');
    console.error('In code: edit the TELEGRAM_CHANNEL constant in index.js (line ~11).');
    console.error('Or: TELEGRAM_CHANNEL=MyChannel node index.js');
    console.error('Or: node index.js MyChannel');
    process.exit(1);
  }
  try {
    const data = await getSportsScheduleFromTelegram(channel);
    printReport(data);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
