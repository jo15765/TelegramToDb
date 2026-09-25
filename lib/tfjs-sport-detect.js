'use strict';

/**
 * Classify sport type using TensorFlow.js Universal Sentence Encoder (no API key).
 * Embeds "team1 vs team2 date" and compares to sport label embeddings via cosine similarity.
 */

// Polyfill for Node 23+ where util.isNullOrUndefined was removed (required by tfjs-node)
const util = require('util');
if (typeof util.isNullOrUndefined !== 'function') {
  util.isNullOrUndefined = (val) => val === null || val === undefined;
}
if (typeof util.isArray !== 'function') {
  util.isArray = (val) => Array.isArray(val);
}

// Prefer Node backend for performance (optional: falls back to default if tfjs-node not installed)
try {
  require('@tensorflow/tfjs-node');
} catch (_) {}

const tf = require('@tensorflow/tfjs');
const use = require('@tensorflow-models/universal-sentence-encoder');

const SPORT_LABELS = [
  "NCAA Men's Basketball",
  "NCAA Women's Basketball",
  "NCAA Baseball",
  "NCAA Football",
  "NCAA Softball",
  "NCAA Volleyball",
  "League One Volleyball",
  "NCAA Lacrosse",
  "NCAA Hockey",
  "NHL",
  "NBA",
  "MLB",
  "NFL",
  "MLS",
];

/** Richer descriptions for embedding so USE can separate e.g. NHL from college basketball, football from basketball. */
const SPORT_LABEL_DESCRIPTIONS = [
  "NCAA Men's Basketball college basketball March Madness winter spring",
  "NCAA Women's Basketball college basketball women's March Madness winter spring",
  "NCAA Baseball college baseball spring summer",
  "NCAA Football college football American football fall season",
  "NCAA Softball college softball women's spring summer",
  "NCAA Volleyball college volleyball indoor",
  "League One Volleyball professional volleyball women's",
  "NCAA Lacrosse college lacrosse spring",
  "NCAA Hockey college ice hockey",
  "NHL National Hockey League professional ice hockey",
  "NBA National Basketball Association professional basketball",
  "MLB Major League Baseball professional baseball",
  "NFL National Football League professional American football",
  "MLS Major League Soccer professional soccer",
];

/** NCAA Football in-season months (1=Jan for bowl, 8–12 = Aug–Dec). Feb–July = off-season. */
const NCAA_FOOTBALL_MONTHS = new Set([1, 8, 9, 10, 11, 12]);

/** Known NHL team names (substring match, lowercase) to prefer NHL when both teams match. */
const NHL_TEAM_SUBSTRINGS = new Set([
  'rangers', 'islanders', 'devils', 'bruins', 'sabres', 'penguins', 'flyers', 'capitals', 'hurricanes',
  'panthers', 'lightning', 'maple leafs', 'senators', 'canadiens', 'red wings', 'blackhawks', 'predators',
  'blues', 'jets', 'wild', 'avalanche', 'stars', 'flames', 'oilers', 'canucks', 'kraken', 'knights',
  'coyotes', 'sharks', 'kings', 'ducks',
]);

/** Known pro/League One volleyball team names (substring match) so we don't label as NBA. */
const VOLLEYBALL_TEAM_SUBSTRINGS = new Set([
  'charging', 'palms', 'vibe', 'mojo', 'supernovas', 'valkyries', 'fury', 'rise',
]);

const GENERIC_SPORT_TYPES = new Set([
  'ESPN+',
  'Sports',
  'Sportsnet+',
  'TSN+',
  'Unknown',
  'Peacock',
  'Paramount+',
  'DAZN',
  'MAX USA',
  'Fanatiz',
]);

/** Minimum cosine similarity to accept a label (else return "Other"). */
const CONFIDENCE_THRESHOLD = parseFloat(process.env.TFJS_SPORT_CONFIDENCE_THRESHOLD || '0.25', 10) || 0.25;

let modelPromise = null;
let labelEmbeddings = null;

function getModel() {
  if (!modelPromise) {
    modelPromise = use.load();
  }
  return modelPromise;
}

/**
 * Compute cosine similarity between one vector and each row of a matrix.
 * input: [1, dim], labels: [numLabels, dim]. Returns [1, numLabels] of similarities.
 */
function cosineSimilarity(inputTensor, labelTensor) {
  const a = tf.tidy(() => {
    const i = tf.div(inputTensor, tf.norm(inputTensor, 'euclidean', -1, true));
    const l = tf.div(labelTensor, tf.norm(labelTensor, 'euclidean', -1, true));
    return tf.matMul(i, l, false, true);
  });
  return a;
}

/**
 * Build label embeddings once and cache (use rich descriptions so USE separates sports better).
 */
async function getLabelEmbeddings() {
  if (labelEmbeddings) return labelEmbeddings;
  const model = await getModel();
  const emb = await model.embed(SPORT_LABEL_DESCRIPTIONS);
  labelEmbeddings = emb;
  return labelEmbeddings;
}

function isGenericSportType(sportsType) {
  if (!sportsType || typeof sportsType !== 'string') return true;
  const normalized = sportsType.trim();
  return GENERIC_SPORT_TYPES.has(normalized) || normalized.length <= 4;
}

/**
 * Classify sport from matchup text using USE embeddings + cosine similarity.
 * Applies date heuristics (NCAA Football only in-season) and NHL team-name boost.
 * @param {string} team1
 * @param {string} team2
 * @param {string} [dateYYYYMMDD]
 * @param {string} [programName]
 * @returns {Promise<string|null>} Sport label or "Other" or null on error
 */
async function classifySportByTeams(team1, team2, dateYYYYMMDD, programName) {
  if (!team1 || !team2) return null;

  const parts = [`${team1} vs ${team2}`];
  if (dateYYYYMMDD) parts.push(String(dateYYYYMMDD).replace(/-/g, ''));
  if (programName && typeof programName === 'string') {
    parts.push(programName.trim().slice(0, 150));
  }
  const inputText = parts.join(' ');

  try {
    const model = await getModel();
    const labelEmb = await getLabelEmbeddings();

    const inputEmb = await model.embed([inputText]);
    const sim = cosineSimilarity(
      inputEmb.gather([0]),
      labelEmb
    );
    const scores = await sim.data();
    sim.dispose();
    inputEmb.dispose();

    // Indices in SPORT_LABELS
    const idxNcaaFootball = SPORT_LABELS.indexOf("NCAA Football");
    const idxNHL = SPORT_LABELS.indexOf("NHL");
    const idxVolleyball = SPORT_LABELS.indexOf("League One Volleyball");

    // Date heuristic: NCAA Football is Aug–Jan. Downweight heavily outside that (Feb–July = basketball/baseball season).
    const month = dateYYYYMMDD ? parseInt(String(dateYYYYMMDD).replace(/-/g, '').slice(4, 6), 10) : null;
    if (month >= 1 && month <= 12 && idxNcaaFootball >= 0 && !NCAA_FOOTBALL_MONTHS.has(month)) {
      scores[idxNcaaFootball] *= 0.12;
    }

    // If both teams look like NHL teams, boost NHL score so we don't return NCAA basketball.
    const t1 = String(team1).trim().toLowerCase();
    const t2 = String(team2).trim().toLowerCase();
    const looksLikeNhl = (t) => [...NHL_TEAM_SUBSTRINGS].some((s) => t.includes(s));
    if (idxNHL >= 0 && looksLikeNhl(t1) && looksLikeNhl(t2)) {
      scores[idxNHL] += 0.25;
    }

    // If both teams look like pro/League One volleyball (e.g. New York Charging, California Palms), boost volleyball so we don't return NBA.
    const looksLikeVolleyball = (t) => [...VOLLEYBALL_TEAM_SUBSTRINGS].some((s) => t.includes(s));
    if (idxVolleyball >= 0 && looksLikeVolleyball(t1) && looksLikeVolleyball(t2)) {
      scores[idxVolleyball] += 0.35;
    }

    let bestIdx = 0;
    let bestScore = scores[0];
    for (let i = 1; i < SPORT_LABELS.length; i++) {
      if (scores[i] > bestScore) {
        bestScore = scores[i];
        bestIdx = i;
      }
    }

    if (bestScore < CONFIDENCE_THRESHOLD) return 'Other';
    return SPORT_LABELS[bestIdx];
  } catch (err) {
    console.error('[TF.js] classifySportByTeams error:', err.message);
    return null;
  }
}

function gameKey(team1, team2, dateYYYYMMDD) {
  if (!team1 || !team2 || !dateYYYYMMDD) return null;
  const d = String(dateYYYYMMDD).replace(/-/g, '');
  if (d.length !== 8) return null;
  const t1 = String(team1).trim().toLowerCase();
  const t2 = String(team2).trim().toLowerCase();
  const [a, b] = t1 <= t2 ? [t1, t2] : [t2, t1];
  return `${d}|${a}|${b}`;
}

/**
 * Enrich records with generic sportsType using TF.js classification. Deduplicates by (team1, team2, date).
 *
 * @param {Array<{ team1?: string|null, team2?: string|null, airDate?: string|null, sportsType?: string, programName?: string|null }>} records
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 */
async function enrichRecordsWithTfjsSport(records, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const keysToRecords = new Map();
  const keyToInput = new Map();
  const uniqueKeys = new Set();

  for (const r of records) {
    if (!r.team1 || !r.team2 || !r.airDate) continue;
    if (!isGenericSportType(r.sportsType)) continue;

    const key = gameKey(r.team1, r.team2, r.airDate);
    if (!key) continue;

    uniqueKeys.add(key);
    if (!keysToRecords.has(key)) {
      keysToRecords.set(key, []);
      keyToInput.set(key, {
        team1: r.team1,
        team2: r.team2,
        date: r.airDate,
        programName: r.programName || null,
      });
    }
    keysToRecords.get(key).push(r);
  }

  const keyList = [...uniqueKeys];
  if (keyList.length === 0) return { lookups: 0, enriched: 0 };

  const cache = new Map();
  let done = 0;

  for (const key of keyList) {
    const input = keyToInput.get(key);
    if (!input) continue;
    try {
      const sport = await classifySportByTeams(
        input.team1,
        input.team2,
        input.date,
        input.programName
      );
      if (sport && sport !== 'Other') cache.set(key, sport);
    } catch (_) {}
    done++;
    if (onProgress) onProgress(done, keyList.length);
  }

  let enriched = 0;
  for (const [key, recs] of keysToRecords) {
    const sport = cache.get(key);
    if (sport) {
      for (const r of recs) {
        r.sportsType = sport;
        enriched++;
      }
    }
  }

  return { lookups: keyList.length, enriched };
}

module.exports = {
  classifySportByTeams,
  enrichRecordsWithTfjsSport,
  gameKey,
  isGenericSportType,
  SPORT_LABELS,
  getModel,
};
