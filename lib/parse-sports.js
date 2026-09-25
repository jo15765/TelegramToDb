'use strict';

/**
 * Parse Telegram sports message text into records for SportsBroadcasts.
 * Handles formats like:
 *   EPL01: Aston Villa 19:30 Chelsea 04/03
 *   NBA 01: Oklahoma City Thunder vs New York Knicks @ 07:00 PM ET
 *   MLB 01 | Houston Astros at Baltimore Orioles 04 Mar 01:05 PM ET
 *   ESPN+ 125 : Little Rock vs. Lindenwood @ Mar 04 09:30 PM ET
 */

const SPORT_PREFIXES = [
  'NCAA Baseball', 'NCAA Football', 'NCAA Basketball', 'EPL', 'NBA', 'NHL', 'MLB', 'NCAAB', 'NCAAW', 'NCAA', 'BIG10+', 'SEC+', 'ESPN+',
  'Peacock', 'Paramount+', 'DAZN', 'TSN+', 'Sportsnet+', 'MAX USA', 'Fanatiz',
  'AHL', 'OHL', 'WHL', 'Tennis', 'Flo Racing', 'Coupang', 'Sky Sports', 'TV2_NO', 'Tv4 Play'
];

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// Line formats with explicit capture groups for DB columns (single capturing parens per group)
const TSN_PLUS_REGEX = /^(TSN\+\s+\d+)\s*:\s*([^:@-]+?)(?:\s*:\s*([^@]+?))?(?:\s*-\s*([^@]+?))?\s*@\s*([A-Za-z]{3}\s+\d{1,2})\s+(\d{1,2}:\d{2}\s+[AP]M\s+ET)/i;
// Sportsnet+ : Channel : Team1 @ Team2 @ Date Time — allow \s* before colon after channel
const SPORTSNET_PLUS_REGEX = /^([A-Za-z+]+\s+\d+)\s*:\s*(?:.*?:\s*)?([A-Za-z .'\-]+?)\s*@\s*([A-Za-z .'\-]+?)(?:\s*\(.*?\))?\s*@\s*([A-Za-z]{3}\s+\d{1,2})\s+(\d{1,2}:\d{2}\s+[AP]M\s+ET)/i;

/** Parse "Feb 03" or "Feb 3" into YYYY-MM-DD. */
function parseMonthDayDate(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})$/i);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (!month) return null;
  const day = parseInt(m[2], 10);
  if (day < 1 || day > 31) return null;
  const year = new Date().getFullYear();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Extract team1/team2 from TSN+ program description (e.g. "Clemson vs. Virginia", "HV71 vs. Linkoping HC", "Morikawa & Schauffele", "Lando Norris - Australian..."). */
function extractTeamsFromTsnDescription(desc) {
  if (!desc || typeof desc !== 'string') return { team1: null, team2: null };
  const s = desc.trim();
  const trimOne = (x) => x.trim().replace(/\s+/g, ' ').slice(0, 200);

  // "X vs. Y" — split on vs. and take last two segments; team1 = text after last " - " or " : " in left part
  const vsMatch = s.match(/\s+vs?\.?\s+/i);
  if (vsMatch) {
    const idx = s.search(/\s+vs?\.?\s+/i);
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx + vsMatch[0].length).trim();
    const team2 = trimOne(sanitizeTeamName(right)); // strip leading (8), trailing (Round Robin)/(Stadium 4)
    let team1Part = left;
    const lastDash = team1Part.lastIndexOf(' - ');
    const lastColon = team1Part.lastIndexOf(': ');
    const cut = Math.max(lastDash, lastColon);
    if (cut >= 0) team1Part = team1Part.slice(cut + (lastDash >= lastColon ? 3 : 2)).trim();
    const team1 = trimOne(sanitizeTeamName(team1Part));
    if (team1 && team2) return { team1, team2 };
  }

  // "X & Y" at end (e.g. "Feat. Morikawa & Schauffele") — strip prefix from left part
  const amp = s.match(/\s(?:Feat\.?\s*)?([A-Za-z0-9\s.'\-]+?)\s+&\s+([A-Za-z0-9\s.'\-]+?)\s*$/i);
  if (amp) {
    let t1 = amp[1].trim();
    const lastDash = t1.lastIndexOf(' - ');
    const lastColon = t1.lastIndexOf(': ');
    if (Math.max(lastDash, lastColon) >= 0) t1 = t1.slice((lastDash >= lastColon ? lastDash + 3 : lastColon + 2)).trim();
    t1 = t1.replace(/^Feat\.?\s*/i, '');
    return { team1: trimOne(t1), team2: trimOne(amp[2]) };
  }

  // "X / Y" at end (e.g. "McIlroy/Hovland")
  const slash = s.match(/\s([A-Za-z0-9\s.'\-]+?)\s*\/\s*([A-Za-z0-9\s.'\-]+?)\s*$/i);
  if (slash) return { team1: trimOne(slash[1]), team2: trimOne(slash[2]) };

  // Single participant "X - Event" — match last " - Name - Event" so we get "Max Verstappen" from "...Camera - Max Verstappen - Australian..."
  const single = s.match(/.+\s+-\s+([A-Za-z0-9\s.'\-:]+)\s+-\s+([A-Z][a-z].*)$/i);
  if (single) {
    const afterDash = single[2].trim();
    if (!/^Day\s*#?\d|^Stadium\s/i.test(afterDash)) {
      let name = trimOne(single[1]);
      if (name.includes(': ')) name = trimOne(name.slice(name.lastIndexOf(': ') + 2));
      if (name.length >= 2 && !/^(the|and|for|day|round|game|stadium|feat\.?|board|camera|1\s+on|\d+\s+\w+)$/i.test(name)) {
        return { team1: name, team2: null };
      }
    }
  }
  // Fallback: "Name - Event" with no other " - " before it (e.g. "Lando Norris - Australian...")
  const singleAlt = s.match(/\s([A-Za-z0-9\s.'\-]+?)\s+-\s+([A-Z][a-z].*)$/i);
  if (singleAlt) {
    const afterDash = singleAlt[2].trim();
    if (!/^Day\s*#?\d|^Stadium\s/i.test(afterDash)) {
      let name = trimOne(singleAlt[1]);
      const lastColon = singleAlt[1].lastIndexOf(': ');
      if (lastColon >= 0) name = trimOne(singleAlt[1].slice(lastColon + 2));
      if (name.length >= 2 && !/^(the|and|for|day|round|game|stadium|feat\.?|board|camera|1\s+on|\d+\s+\w+)$/i.test(name)) {
        return { team1: name, team2: null };
      }
    }
  }
  return { team1: null, team2: null };
}

/** Normalize line for DB: replace accented/Unicode chars with ASCII so parsing and insert never fail. */
function normalizeLineForDb(val) {
  if (val == null || typeof val !== 'string') return val;
  try {
    return val
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[ñń]/gi, 'n')
      .replace(/[àáâãäåāăą]/gi, 'a')
      .replace(/[èéêëēė]/gi, 'e')
      .replace(/[ìíîïī]/gi, 'i')
      .replace(/[òóôõöō]/gi, 'o')
      .replace(/[ùúûüū]/gi, 'u')
      .replace(/[ýÿ]/gi, 'y')
      .replace(/[çćč]/gi, 'c')
      .replace(/ß/gi, 'ss')
      .trim();
  } catch (_) {
    return val.replace(/ñ/gi, 'n').replace(/[áéíóúü]/gi, (c) => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' }[c.toLowerCase()] || c));
  }
}

/**
 * @param {string} text - Full message text
 * @returns {Array<{ sportsType: string, team1: string|null, team2: string|null, airDate: string|null, airTime: string|null, airChannel: string|null, programName: string|null }>}
 */
function parseMessageText(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results = [];
  let defaultChannel = null;
  let defaultDate = null;

  for (const line of lines) {
    const rec = parseLine(line);
    if (rec) {
      if (rec.airChannel) defaultChannel = rec.airChannel;
      else if (defaultChannel) rec.airChannel = defaultChannel;
      if (rec.airDate) defaultDate = rec.airDate;
      else if (defaultDate) rec.airDate = defaultDate;
      results.push(rec);
    }
  }

  return results;
}

/**
 * @param {string} line - Raw line (will be stored as programName)
 * @returns {{ sportsType: string, team1: string|null, team2: string|null, airDate: string|null, airTime: string|null, airChannel: string|null, programName: string|null } | null}
 */
function parseLine(line) {
  line = normalizeLineForDb(line) || line;
  const rawLine = line;
  let sportsType = null;
  let airChannel = null;

  // Skip separator lines (dashes/equals only) and section headers like "TV2_NO Events 05.03.2026"
  if (/^[\s\-=]+$/.test(line)) return null;
  if (/^[A-Za-z0-9_+]+\s+Events\s+\d{1,2}\.\d{1,2}\.\d{4}$/i.test(line.trim())) return null;

  // --- TSN+ format: Channel : SportsType (optional : and - parts) @ Feb 03 08:30 AM ET ---
  const tsnMatch = line.match(TSN_PLUS_REGEX);
  if (tsnMatch) {
    const channel = tsnMatch[1].trim();
    const part2 = tsnMatch[2] ? tsnMatch[2].trim() : '';
    const part3 = tsnMatch[3] ? tsnMatch[3].trim() : '';
    const part4 = tsnMatch[4] ? tsnMatch[4].trim() : '';
    const sportsTypeParts = [part2, part3, part4].filter(Boolean);
    const parsedSportsType = sportsTypeParts.length > 0 ? sportsTypeParts.join(' - ') : 'Sports';
    // SportsType = everything before the first " - " (e.g. "PGA TOUR Live", "NCAA Women's SEC Championship")
    const sportsTypeShort = (parsedSportsType.split(/\s+-\s+/)[0] || parsedSportsType).trim().slice(0, 100);
    const description = sportsTypeParts.join(' - ');
    const teams = extractTeamsFromTsnDescription(description);
    const dateStr = tsnMatch[5] ? tsnMatch[5].trim() : '';
    const timeStr = tsnMatch[6] || '';
    const airDate = parseMonthDayDate(dateStr);
    const airTime = normalizeTime(timeStr);
    return {
      sportsType: sportsTypeShort,
      team1: teams.team1,
      team2: teams.team2,
      airDate,
      airTime,
      airChannel: channel.slice(0, 150),
      programName: rawLine && rawLine.trim() ? rawLine.trim() : null,
    };
  }

  // --- Sportsnet+ format: Channel : Team1 @ Team2 @ Feb 3 10:00 PM ET ---
  const sportsnetMatch = line.match(SPORTSNET_PLUS_REGEX);
  if (sportsnetMatch) {
    const channel = sportsnetMatch[1].trim();
    const team1 = sportsnetMatch[2] ? sportsnetMatch[2].trim() : null;
    const team2 = sportsnetMatch[3] ? sportsnetMatch[3].trim() : null;
    const dateStr = sportsnetMatch[4] ? sportsnetMatch[4].trim() : '';
    const timeStr = sportsnetMatch[5] || '';
    const airDate = parseMonthDayDate(dateStr);
    const airTime = normalizeTime(timeStr);
    return {
      sportsType: (channel.split(/\s+/)[0] || 'Sports').slice(0, 100),
      team1: team1 ? team1.slice(0, 200) : null,
      team2: team2 ? team2.slice(0, 200) : null,
      airDate,
      airTime,
      airChannel: channel.slice(0, 150),
      programName: rawLine && rawLine.trim() ? rawLine.trim() : null,
    };
  }

  // --- Generic channel prefix (ESPN+, NBA, etc.) ---
  const prefixMatch = line.match(/^([A-Za-z0-9+&\s\/]+?(?:\s+\d+)?)\s*[:\|]\s*/);
  if (prefixMatch) {
    const prefix = prefixMatch[1].trim();
    for (const sport of SPORT_PREFIXES) {
      if (prefix.includes(sport)) {
        sportsType = sport.replace(/\s*\/\s*.*$/, '').trim();
        if (prefix.length <= 80) airChannel = prefix;
        break;
      }
    }
    if (!sportsType && prefix.length <= 60) {
      sportsType = prefix.split(/\s+/)[0] || 'Sports';
      airChannel = prefix;
    }
    line = line.slice(prefixMatch[0].length).trim();
  } else {
    // Line has no " : " or " | " — treat whole line as channel if it matches a known channel pattern (e.g. "ESPN+ 60", "NBA 01")
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 80) {
      for (const sport of SPORT_PREFIXES) {
        const channelPattern = new RegExp('^' + sport.replace(/[+]/g, '\\+').replace(/\s+/g, '\\s*') + '(?:\\s+\\d+)?\\s*$', 'i');
        if (channelPattern.test(trimmed)) {
          sportsType = sport.replace(/\s*\/\s*.*$/, '').trim();
          airChannel = trimmed;
          line = '';
          break;
        }
      }
    }
  }

  if (!sportsType) sportsType = 'Sports';

  const dateTime = extractDateAndTime(line);
  const teams = extractTeams(line);
  const hasData = teams.team1 || teams.team2 || dateTime.date || dateTime.time || airChannel || (rawLine && rawLine.trim().length > 0);
  if (!hasData) return null;

  return {
    sportsType: sportsType.slice(0, 100),
    team1: teams.team1 ? teams.team1.slice(0, 200) : null,
    team2: teams.team2 ? teams.team2.slice(0, 200) : null,
    airDate: dateTime.date || null,
    airTime: dateTime.time || null,
    airChannel: airChannel ? airChannel.slice(0, 150) : null,
    programName: rawLine && rawLine.trim() ? rawLine.trim() : null,
  };
}

function extractDateAndTime(line) {
  let date = null;
  let time = null;

  // Prefer "HH:MM AM/PM ET" (or EST/EDT) so we keep 12-hour and don't treat "07:00 ET" as 7 AM
  const et = line.match(/\d{1,2}:\d{2}\s*(AM|PM)\s*(?:ET|EST|EDT)/i);
  if (et) {
    time = normalizeTime(et[0]);
  }
  if (!time) {
    const etOptional = line.match(/\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:ET|EST|EDT)/i);
    if (etOptional) time = normalizeTime(etOptional[0]);
  }
  if (!time) {
    const utc = line.match(/\d{1,2}:\d{2}\s*(AM|PM)\s*UTC/i);
    if (utc) time = normalizeTime(utc[0]);
  }
  if (!time) {
    const utcOptional = line.match(/\d{1,2}:\d{2}\s*(?:AM|PM)?\s*UTC/i);
    if (utcOptional) time = normalizeTime(utcOptional[0]);
  }
  if (!time) {
    const hhmm = line.match(/(?:^|[\s@])(\d{1,2}):(\d{2})(?:\s|$)/);
    if (hhmm) {
      const hour = parseInt(hhmm[1], 10);
      const min = parseInt(hhmm[2], 10);
      if (hour >= 0 && hour <= 23 && min >= 0 && min <= 59) {
        time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
      }
    }
  }

  const mar04 = line.match(/(?:Mar|Jan|Feb|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i);
  if (mar04) {
    const monthName = mar04[0].split(/\s+/)[0];
    const month = MONTHS[monthName] || 1;
    const day = parseInt(mar04[1], 10);
    const year = new Date().getFullYear();
    date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (!date) {
    const ddmmyy = line.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (ddmmyy) {
      const d = ddmmyy[1];
      const m = ddmmyy[2];
      const y = ddmmyy[3] ? (ddmmyy[3].length === 2 ? `20${ddmmyy[3]}` : ddmmyy[3]) : new Date().getFullYear();
      date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  if (!date) {
    const ddMar = line.match(/\b(\d{1,2})\s+(Mar|Jan|Feb|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
    if (ddMar) {
      const day = parseInt(ddMar[1], 10);
      const month = MONTHS[ddMar[2]] || 1;
      const year = new Date().getFullYear();
      date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return { date, time };
}

/** Remove trailing parenthetical (e.g. " (Quarterfinal #4)", " (Round Robin)") from team names. */
function stripTrailingParens(s) {
  if (s == null || typeof s !== 'string') return s;
  return s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
}

/** Remove leading seed/rank in parens (e.g. "(8)", "(#1)") from team names. */
function stripLeadingSeed(s) {
  if (s == null || typeof s !== 'string') return s;
  return s.replace(/^\s*\(\#?\d+\)\s*/gi, '').trim();
}

/** Clean team name: strip leading (8)/(#1) and trailing (Round Robin) etc. */
function sanitizeTeamName(s) {
  return stripTrailingParens(stripLeadingSeed(s));
}

function normalizeTime(s) {
  s = s.replace(/\s*(ET|EST|EDT|UTC|CET|GMT)\s*/gi, '').trim();
  const match = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const sec = match[3] != null ? parseInt(match[3], 10) : 0;
  if (match[4]) {
    if (match[4].toUpperCase() === 'PM' && h < 12) h += 12;
    if (match[4].toUpperCase() === 'AM' && h === 12) h = 0;
  }
  if (h < 0 || h > 23 || m < 0 || m > 59 || sec < 0 || sec > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function extractTeams(line) {
  // Allow # and () in names (e.g. "(8) Michigan State"); seeds/trailing parens stripped by sanitizeTeamName.
  // Optional (Round Robin) or (Quarterfinal #4) after team2 is not captured; we match it so group2 stays clean.
  const vs = line.match(/([A-Za-z0-9\s\.\'\-&#()]+?)\s+(?:vs?\.?|v\.?)\s+([A-Za-z0-9\s\.\'\-&#()]+?)(?:\s*\([^)]*\))?(?:\s+@|\s+\d|$)/i);
  if (vs) {
    return {
      team1: sanitizeTeamName(vs[1].trim().replace(/\s+/g, ' ')),
      team2: sanitizeTeamName(vs[2].trim().replace(/\s+/g, ' ')),
    };
  }
  // "at" or " @ " only when not followed by month (e.g. avoid "Show @ Mar 04" as team1 @ team2)
  const atMatch = line.match(/([A-Za-z0-9\s\.\'\-&#()]+?)\s+at\s+([A-Za-z0-9\s\.\'\-&#()]+?)(?:\s*\([^)]*\))?(?:\s+\d{2}\/\d{2}|\s+@|\s+\d|$)/i);
  if (atMatch) {
    return {
      team1: sanitizeTeamName(atMatch[1].trim().replace(/\s+/g, ' ')),
      team2: sanitizeTeamName(atMatch[2].trim().replace(/\s+/g, ' ')),
    };
  }
  const atSymbol = line.match(/([A-Za-z0-9\s\.\'\-&#()]+?)\s+@\s+([A-Za-z0-9\s\.\'\-&#()]+?)(?:\s*\([^)]*\))?(?:\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\s+\d|$)/i);
  if (atSymbol) {
    const afterAt = atSymbol[2].trim();
    // Don't treat "Show @ Mar 04" as team1 @ team2 — next part is a month (date)
    if (!/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\s|$)/i.test(afterAt)) {
      return {
        team1: sanitizeTeamName(atSymbol[1].trim().replace(/\s+/g, ' ')),
        team2: sanitizeTeamName(afterAt.replace(/\s+/g, ' ')),
      };
    }
  }
  const eplStyle = line.match(/([A-Za-z0-9\s\.\&\-\'#()]+?)\s+(\d{1,2}):(\d{2})\s+([A-Za-z0-9\s\.\&\-\'#()]+?)(?:\s*\([^)]*\))?(?:\s+\d{2}\/\d{2}|$)/);
  if (eplStyle && !/\s*(?:AM|PM)\s*ET$/i.test(line)) {
    return {
      team1: sanitizeTeamName(eplStyle[1].trim().replace(/\s+/g, ' ')),
      team2: sanitizeTeamName(eplStyle[4].trim().replace(/\s+/g, ' ')),
    };
  }
  return { team1: null, team2: null };
}

module.exports = { parseMessageText, parseLine };
