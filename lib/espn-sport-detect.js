'use strict';

/**
 * Detect sport/league via ESPN:
 * 1) Scoreboard match for that date (when the game is listed)
 * 2) Team search: find sports each school plays, take the intersection
 *    (works even when the game is not on today's scoreboard)
 */

const SCOREBOARD_SPORTS = [
  { sport: 'football', league: 'college-football', label: 'NCAA Football', college: true },
  { sport: 'football', league: 'nfl', label: 'NFL' },
  { sport: 'basketball', league: 'mens-college-basketball', label: "NCAA Men's Basketball", college: true },
  { sport: 'basketball', league: 'womens-college-basketball', label: "NCAA Women's Basketball", college: true },
  { sport: 'basketball', league: 'nba', label: 'NBA' },
  { sport: 'basketball', league: 'wnba', label: 'WNBA' },
  { sport: 'baseball', league: 'mlb', label: 'MLB' },
  { sport: 'baseball', league: 'college-baseball', label: 'NCAA Baseball', college: true },
  { sport: 'hockey', league: 'nhl', label: 'NHL' },
  { sport: 'hockey', league: 'mens-college-hockey', label: "NCAA Men's Hockey", college: true },
  { sport: 'soccer', league: 'usa.1', label: 'MLS' },
  { sport: 'soccer', league: 'eng.1', label: 'EPL' },
];

/** league slug → SportsType label */
const LEAGUE_LABELS = {
  'college-football': 'NCAA Football',
  'mens-college-basketball': "NCAA Men's Basketball",
  'womens-college-basketball': "NCAA Women's Basketball",
  'college-baseball': 'NCAA Baseball',
  'mens-college-hockey': "NCAA Men's Hockey",
  'womens-college-hockey': "NCAA Women's Hockey",
  'college-softball': 'NCAA Softball',
  'college-lacrosse': 'NCAA Lacrosse',
  'mens-college-lacrosse': 'NCAA Lacrosse',
  'womens-college-lacrosse': 'NCAA Lacrosse',
  'mens-college-soccer': "NCAA Men's Soccer",
  'womens-college-soccer': "NCAA Women's Soccer",
  'mens-college-volleyball': 'NCAA Volleyball',
  'womens-college-volleyball': 'NCAA Volleyball',
  nfl: 'NFL',
  nba: 'NBA',
  wnba: 'WNBA',
  mlb: 'MLB',
  nhl: 'NHL',
  'usa.1': 'MLS',
  'usa.usl.1': 'USL Championship',
  'usa.usl.l1': 'USL League One',
  'usa.nwsl': 'NWSL',
  'eng.1': 'EPL',
};

/** Prefer these when a school hits multiple overlapping leagues */
const LEAGUE_PRIORITY = [
  'nfl',
  'nba',
  'nhl',
  'mlb',
  'wnba',
  'usa.1',
  'usa.usl.l1',
  'usa.usl.1',
  'eng.1',
  'college-football',
  'mens-college-basketball',
  'womens-college-basketball',
  'college-baseball',
  'mens-college-hockey',
  'womens-college-hockey',
  'college-softball',
  'mens-college-soccer',
  'womens-college-soccer',
  'womens-college-volleyball',
  'mens-college-volleyball',
];

const scoreboardCache = new Map();
const teamSearchCache = new Map();

function gameKey(team1, team2, dateYYYYMMDD) {
  if (!team1 || !team2 || !dateYYYYMMDD) return null;
  const d = String(dateYYYYMMDD).replace(/-/g, '');
  if (d.length !== 8) return null;
  const t1 = String(team1).trim().toLowerCase();
  const t2 = String(team2).trim().toLowerCase();
  const [a, b] = t1 <= t2 ? [t1, t2] : [t2, t1];
  return `${d}|${a}|${b}`;
}

function normalizeTeamName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b(?:university|u\.?|college|col\.?|state|st\.?|school)\b\.?/gi, '')
    .replace(/[.\s']/g, '')
    .trim();
}

function normalizeKeepState(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b(?:university|u\.?|college|col\.?|school)\b\.?/gi, '')
    .replace(/[.\s']/g, '')
    .trim();
}

function teamMatches(a, b) {
  const variants = (n) => [...new Set([normalizeTeamName(n), normalizeKeepState(n)].filter(Boolean))];
  const as = variants(a);
  const bs = variants(b);
  for (const na of as) {
    for (const nb of bs) {
      if (na === nb || (nb.length >= 3 && na.includes(nb)) || (na.length >= 3 && nb.includes(na))) return true;
    }
  }
  return false;
}

function competitorNames(comp) {
  const t = (comp && comp.team) || {};
  return [t.displayName, t.shortDisplayName, t.location, t.name, t.abbreviation].filter(Boolean);
}

function labelForLeague(league, fallbackLabel) {
  if (!league) return fallbackLabel || 'Unknown';
  if (LEAGUE_LABELS[league]) return LEAGUE_LABELS[league];
  if (fallbackLabel && /team$/i.test(fallbackLabel)) {
    return fallbackLabel.replace(/\s*Team\s*$/i, '').trim();
  }
  return league;
}

async function fetchScoreboard(sport, league, dateStr, college) {
  const cacheKey = `${dateStr}|${sport}|${league}`;
  if (scoreboardCache.has(cacheKey)) return scoreboardCache.get(cacheKey);

  const promise = (async () => {
    let url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateStr}`;
    if (college) url += '&groups=50&limit=500';
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  })().catch(() => []);

  scoreboardCache.set(cacheKey, promise);
  return promise;
}

async function detectViaScoreboard(team1, team2, dateStr) {
  for (const s of SCOREBOARD_SPORTS) {
    const events = await fetchScoreboard(s.sport, s.league, dateStr, s.college);
    for (const event of events) {
      const comps = event.competitions && event.competitions[0] && event.competitions[0].competitors;
      if (!comps || comps.length < 2) continue;
      const namesA = competitorNames(comps[0]);
      const namesB = competitorNames(comps[1]);
      const matchAB =
        namesA.some((n) => teamMatches(n, team1)) && namesB.some((n) => teamMatches(n, team2));
      const matchBA =
        namesA.some((n) => teamMatches(n, team2)) && namesB.some((n) => teamMatches(n, team1));
      if (matchAB || matchBA) return s.label;
    }
  }
  return null;
}

/**
 * Search ESPN for a team name; return list of { league, label, location, displayName }.
 */
async function searchTeamLeagues(teamName) {
  const key = String(teamName).trim().toLowerCase();
  if (!key) return [];
  if (teamSearchCache.has(key)) return teamSearchCache.get(key);

  const promise = (async () => {
    const url =
      'https://site.web.api.espn.com/apis/common/v3/search?query=' +
      encodeURIComponent(teamName) +
      '&limit=25';
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const out = [];
    for (const it of items) {
      if (it.type !== 'team' || !it.league) continue;
      // Require the result to actually refer to this school/club
      const hay = [it.location, it.displayName, it.name, it.abbreviation].filter(Boolean).join(' ');
      if (!teamMatches(hay, teamName) && !teamMatches(it.location || '', teamName)) continue;
      out.push({
        league: it.league,
        label: labelForLeague(it.league, it.label),
        location: it.location || '',
        displayName: it.displayName || '',
        sport: it.sport || '',
      });
    }
    return out;
  })().catch(() => []);

  teamSearchCache.set(key, promise);
  return promise;
}

function pickBestLeague(shared) {
  if (!shared.length) return null;
  if (shared.length === 1) return shared[0];
  shared.sort((a, b) => {
    const ia = LEAGUE_PRIORITY.indexOf(a.league);
    const ib = LEAGUE_PRIORITY.indexOf(b.league);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return shared[0];
}

/**
 * Classify by intersecting ESPN search results for both teams.
 */
async function detectViaTeamSearch(team1, team2) {
  const [a, b] = await Promise.all([searchTeamLeagues(team1), searchTeamLeagues(team2)]);
  if (!a.length || !b.length) {
    // One side only: still useful for pro clubs / unique names
    const only = a.length ? a : b;
    if (only.length === 1) return only[0].label;
    if (only.length > 1) {
      const best = pickBestLeague(only);
      return best ? best.label : null;
    }
    return null;
  }

  const leaguesB = new Set(b.map((x) => x.league));
  const shared = a.filter((x) => leaguesB.has(x.league));
  // Dedupe by league
  const byLeague = new Map();
  for (const s of shared) {
    if (!byLeague.has(s.league)) byLeague.set(s.league, s);
  }
  const unique = [...byLeague.values()];
  const best = pickBestLeague(unique);
  return best ? best.label : null;
}

/**
 * Look up sport by team1, team2 and optional date.
 * @returns {Promise<string>} Sport label or "Unknown"
 */
async function detectSport(team1, team2, dateYYYYMMDD) {
  if (!team1 || !team2) return 'Unknown';

  const dateStr = dateYYYYMMDD ? String(dateYYYYMMDD).replace(/-/g, '') : '';
  if (dateStr.length === 8) {
    const fromBoard = await detectViaScoreboard(team1, team2, dateStr);
    if (fromBoard) return fromBoard;
  }

  const fromSearch = await detectViaTeamSearch(team1, team2);
  return fromSearch || 'Unknown';
}

async function enrichRecordsWithEspnSport(records, options = {}) {
  const concurrency = Math.max(1, parseInt(options.concurrency, 10) || 4);
  const delayMs = Math.max(0, parseInt(options.delayMs, 10) ?? 40);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const keysToRecords = new Map();
  const keyToTriple = new Map();
  const uniqueKeys = new Set();
  for (const r of records) {
    if (!r.team1 || !r.team2) continue;
    const key = gameKey(r.team1, r.team2, r.airDate || '00000000') || `${r.team1}|${r.team2}`;
    uniqueKeys.add(key);
    if (!keysToRecords.has(key)) {
      keysToRecords.set(key, []);
      keyToTriple.set(key, { team1: r.team1, team2: r.team2, date: r.airDate });
    }
    keysToRecords.get(key).push(r);
  }

  const keyList = [...uniqueKeys];
  if (keyList.length === 0) return { lookups: 0, enriched: 0, unknown: 0 };

  const cache = new Map();
  let done = 0;

  async function runOne(key) {
    const triple = keyToTriple.get(key);
    if (!triple) return;
    try {
      cache.set(key, await detectSport(triple.team1, triple.team2, triple.date));
    } catch (_) {
      cache.set(key, 'Unknown');
    }
    done++;
    if (onProgress) onProgress(done, keyList.length);
  }

  for (let i = 0; i < keyList.length; i += concurrency) {
    const batch = keyList.slice(i, i + concurrency);
    await Promise.all(batch.map((k) => runOne(k)));
    if (delayMs && i + concurrency < keyList.length) await new Promise((r) => setTimeout(r, delayMs));
  }

  let enriched = 0;
  let unknown = 0;
  for (const [key, recs] of keysToRecords) {
    const sport = cache.get(key) || 'Unknown';
    for (const r of recs) {
      r.espnSport = sport === 'Unknown' ? null : sport;
      if (sport && sport !== 'Unknown') {
        r.sportsType = sport;
        r.classificationSource = 'espn';
        enriched++;
      } else {
        unknown++;
      }
    }
  }

  return { lookups: keyList.length, enriched, unknown };
}

function formatEspnClassificationLine(record) {
  const line = (record.programName && String(record.programName).trim()) || buildFallbackLine(record);
  const espn = record.espnSport || 'Unknown';
  const gpt = record.chatGptSport || '';
  const final = record.sportsType || espn || gpt || 'Unknown';
  if (gpt && (!record.espnSport || record.espnSport === 'Unknown')) {
    return `${line} -- API sports classification -- ${espn} -- ChatGPT -- ${gpt}`;
  }
  return `${line} -- API sports classification -- ${final}`;
}

function buildFallbackLine(r) {
  const ch = r.airChannel || '';
  const teams = [r.team1, r.team2].filter(Boolean).join(' vs. ');
  const when = [r.airDate, r.airTime].filter(Boolean).join(' ');
  return [ch, teams, when].filter(Boolean).join(' | ') || '(untitled)';
}

module.exports = {
  detectSport,
  enrichRecordsWithEspnSport,
  formatEspnClassificationLine,
  searchTeamLeagues,
  gameKey,
  SPORTS: SCOREBOARD_SPORTS,
};
