'use strict';

const sql = require('mssql');

function getConfig() {
  const host = (process.env.MSSQL_HOST || '').trim();
  const port = parseInt(process.env.MSSQL_PORT || '1433', 10);
  const user = (process.env.MSSQL_USER || '').trim();
  const password = (process.env.MSSQL_PASSWORD || '').trim();
  const database = (process.env.MSSQL_DATABASE || '').trim();
  const table = (process.env.MSSQL_TABLE || 'SportsBroadcasts').trim();
  if (!host || !user || !password || !database) return null;
  const trustCert = /^(1|true|yes)$/i.test((process.env.MSSQL_TRUST_SERVER_CERTIFICATE || '').trim());
  return {
    server: host,
    port,
    user,
    password,
    database,
    table,
    options: {
      encrypt: true,
      trustServerCertificate: trustCert,
      enableArithAbort: true,
    },
    connectionTimeout: 30000,
    requestTimeout: 30000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
}

function isConfigured() {
  return getConfig() !== null;
}

/** Normalize time string to HH:mm:ss and validate; return null if invalid. */
function normalizeTimeForSql(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = m[3] != null ? parseInt(m[3], 10) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Convert HH:mm:ss to a Date (epoch day) so mssql sql.Time accepts it. Uses UTC so the stored time is the literal hour (e.g. 19:00 for 7 PM ET) with no timezone conversion. Returns null if timeStr is invalid. */
function timeStringToDate(timeStr) {
  const normalized = normalizeTimeForSql(timeStr);
  if (!normalized) return null;
  const [h, min, sec] = normalized.split(':').map((n) => parseInt(n, 10));
  return new Date(Date.UTC(1970, 0, 1, h, min, sec));
}

/** Default time when feed has no parseable time (AirTime column does not allow nulls). Use midnight. */
const DEFAULT_AIR_TIME = new Date(Date.UTC(1970, 0, 1, 0, 0, 0));

/** Normalize text for SQL: replace accented/Unicode chars with ASCII equivalents so insert never fails on collation/encoding.
 * Also strips ranking prefixes like "#13 " so "#13 Boston College" becomes "Boston College". */
function normalizeTextForSql(val) {
  if (val == null || typeof val !== 'string') return val;
  try {
    return val
      .replace(/#\d+\s*/g, ' ')   // remove "#13 ", "#1 ", etc. (rank prefixes)
      .replace(/\s{2,}/g, ' ')    // collapse multiple spaces left after removal
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[àáâãäåāăą]/gi, 'a')
      .replace(/[èéêëēė]/gi, 'e')
      .replace(/[ìíîïī]/gi, 'i')
      .replace(/[òóôõöō]/gi, 'o')
      .replace(/[ùúûüū]/gi, 'u')
      .replace(/[ñń]/gi, 'n')
      .replace(/[ýÿ]/gi, 'y')
      .replace(/[çćč]/gi, 'c')
      .replace(/[ß]/gi, 'ss')
      .replace(/[œ]/gi, 'oe')
      .replace(/[æ]/gi, 'ae')
      .trim();
  } catch (_) {
    let s = String(val).replace(/#\d+\s*/g, ' ').replace(/\s{2,}/g, ' ');
    return s.replace(/ñ/gi, 'n').replace(/[áéíóúü]/gi, (c) => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' }[c.toLowerCase()] || c)).trim();
  }
}

/**
 * @param {Array<{ sportsType: string, team1: string|null, team2: string|null, airDate: string|null, airTime: string|null, airChannel: string|null, programName: string|null }>} records
 * @param {string} [telegramLink]
 * @returns {Promise<{ inserted: number, errors: string[], skippedCount: number }>}
 */
async function insertBroadcasts(records, telegramLink = null) {
  const config = getConfig();
  if (!config) {
    console.error('[SQL] insertBroadcasts: MSSQL not configured (missing host/user/password/database in .env).');
    return { inserted: 0, errors: ['MSSQL not configured'], skippedCount: 0 };
  }

  const tableName = config.table.replace(/[^\w\[\].]/g, '');
  const link = telegramLink && telegramLink.length <= 500 ? telegramLink : null;
  let inserted = 0;
  let skippedCount = 0;
  const errors = [];

  console.error(`[SQL] insertBroadcasts: received ${records.length} record(s), table=${tableName}`);

  let pool;
  try {
    pool = await sql.connect({
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
    console.error('[SQL] Connected to database.');
  } catch (e) {
    const msg = e.message || String(e);
    errors.push(msg);
    console.error('[SQL] Connection failed:', msg);
    if (/unable to verify the first certificate|certificate|CERTIFICATE/.test(msg)) {
      errors.push('Tip: Add MSSQL_TRUST_SERVER_CERTIFICATE=true to your .env for cloud SQL Server.');
    }
    return { inserted: 0, errors, skippedCount: 0 };
  }

  for (let idx = 0; idx < records.length; idx++) {
    const r = records[idx];
    const hasTeams = r.team1 || r.team2;
    const hasProgramName = r.programName && String(r.programName).trim().length > 0;
    const hasChannel = r.airChannel && String(r.airChannel).trim().length > 0;
    // Only skip when we have nothing to store (no program name, no channel, no teams)
    if (!hasProgramName && !hasChannel && !hasTeams) {
      skippedCount++;
      const pn = (r.programName || '').trim();
      console.error(`[SQL] Row ${idx + 1}/${records.length}: SKIP (no programName, no airChannel, no teams) sportsType="${(r.sportsType || '').slice(0, 30)}" programName="${pn.slice(0, 50)}${pn.length > 50 ? '...' : ''}"`);
      continue;
    }
    try {
      const request = pool.request();
      request.input('sportsType', sql.NVarChar(100), normalizeTextForSql(r.sportsType) || '');
      request.input('team1', sql.NVarChar(200), r.team1 ? normalizeTextForSql(r.team1) : null);
      request.input('team2', sql.NVarChar(200), r.team2 ? normalizeTextForSql(r.team2) : null);
      request.input('airDate', sql.Date, r.airDate ? new Date(r.airDate + 'T12:00:00Z') : null);
      request.input('airTime', sql.Time, timeStringToDate(r.airTime) ?? DEFAULT_AIR_TIME);
      request.input('airChannel', sql.NVarChar(150), r.airChannel ? normalizeTextForSql(r.airChannel) : null);
      request.input('programName', sql.NVarChar(sql.MAX), hasProgramName ? normalizeTextForSql(String(r.programName).trim()) : null);
      request.input('telegramLink', sql.NVarChar(500), link);
      const espnVal = r.espnSport && r.espnSport !== 'Unknown' ? normalizeTextForSql(r.espnSport) : null;
      const gptVal = r.chatGptSport && r.chatGptSport !== 'Unknown' ? normalizeTextForSql(r.chatGptSport) : null;
      let source = r.classificationSource || null;
      if (!source) {
        if (espnVal) source = 'espn';
        else if (gptVal) source = 'chatgpt';
        else source = 'parsed';
      }
      request.input('espnSport', sql.NVarChar(100), espnVal);
      request.input('chatGptSport', sql.NVarChar(100), gptVal);
      request.input('classificationSource', sql.NVarChar(20), source);
      await request.query(`
        INSERT INTO [dbo].[${tableName}] (
          SportsType, Team1, Team2, AirDate, AirTime, AirChannel, ProgramName, TelegramLink,
          EspnSport, ChatGptSport, ClassificationSource
        )
        VALUES (
          @sportsType, @team1, @team2, @airDate, @airTime, @airChannel, @programName, @telegramLink,
          @espnSport, @chatGptSport, @classificationSource
        );
      `);
      inserted++;
      console.error(`[SQL] Row ${idx + 1}/${records.length}: INSERT OK sportsType="${(r.sportsType || '').slice(0, 25)}" team1="${(r.team1 || '')}" team2="${(r.team2 || '')}" airDate=${r.airDate || 'null'} airChannel="${(r.airChannel || '').slice(0, 20)}"`);
    } catch (e) {
      const errMsg = e.message || String(e);
      errors.push(`Row: ${errMsg}`);
      console.error(`[SQL] Row ${idx + 1}/${records.length}: INSERT FAILED:`, errMsg);
    }
  }

  try {
    await pool.close();
  } catch (_) {}

  console.error(`[SQL] insertBroadcasts done: inserted=${inserted} skipped=${skippedCount} errors=${errors.length}`);
  return { inserted, errors, skippedCount };
}

/** Get a shared pool for API use. Caller must not close it. */
let apiPool = null;
async function getPool() {
  const config = getConfig();
  if (!config) return null;
  if (apiPool) return apiPool;
  try {
    apiPool = await sql.connect({
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
    return apiPool;
  } catch (e) {
    apiPool = null;
    throw new Error('Database connection failed: ' + (e.message || String(e)));
  }
}

const broadcastsTable = () => {
  const config = getConfig();
  const name = config && config.table ? String(config.table).replace(/[^\w\[\].]/g, '') : '';
  return name || 'SportsBroadcasts';
};

/** Get distinct SportsType values from SportsBroadcasts, alphabetical. */
async function getSportsTypes() {
  const pool = await getPool();
  if (!pool) return [];
  const table = broadcastsTable();
  try {
    const result = await pool.request().query(`
      SELECT DISTINCT SportsType FROM [dbo].[${table}] WHERE SportsType IS NOT NULL AND RTRIM(LTRIM(SportsType)) != '' ORDER BY SportsType
    `);
    return (result.recordset || []).map((r) => r.SportsType);
  } catch (e) {
    const msg = e.message || String(e);
    if (/Invalid object name|does not exist/i.test(msg)) {
      throw new Error(`Table "${table}" not found. Create the SportsBroadcasts table or set MSSQL_TABLE in .env.`);
    }
    throw new Error('Query failed: ' + msg);
  }
}

/** Get distinct team names (Team1 and Team2) for a given SportsType, alphabetical. */
async function getTeamsForSport(sportsType) {
  const pool = await getPool();
  if (!pool || !sportsType) return [];
  const table = broadcastsTable();
  const result = await pool.request()
    .input('sportsType', sql.NVarChar(100), String(sportsType).trim())
    .query(`
      SELECT Team1 AS Team FROM [dbo].[${table}] WHERE SportsType = @sportsType AND Team1 IS NOT NULL AND RTRIM(LTRIM(Team1)) != ''
      UNION
      SELECT Team2 AS Team FROM [dbo].[${table}] WHERE SportsType = @sportsType AND Team2 IS NOT NULL AND RTRIM(LTRIM(Team2)) != ''
      ORDER BY Team
    `);
  const teams = (result.recordset || []).map((r) => r.Team);
  return [...new Set(teams)];
}

/** Save or update subscription (upsert by phone). */
async function saveSubscription(phone, sportTypes, teamFilters) {
  const pool = await getPool();
  if (!pool) throw new Error('Database not configured');
  const phoneNorm = String(phone).replace(/\D/g, '');
  if (!phoneNorm || phoneNorm.length < 10) throw new Error('Invalid phone number');
  const sportTypesJson = JSON.stringify(Array.isArray(sportTypes) ? sportTypes : []);
  const teamFiltersJson = teamFilters && typeof teamFilters === 'object' ? JSON.stringify(teamFilters) : null;
  await pool.request()
    .input('phone', sql.NVarChar(20), phoneNorm)
    .input('sportTypes', sql.NVarChar(sql.MAX), sportTypesJson)
    .input('teamFilters', sql.NVarChar(sql.MAX), teamFiltersJson)
    .query(`
      MERGE [dbo].[NotificationSubscriptions] AS t
      USING (SELECT @phone AS Phone, @sportTypes AS SportTypes, @teamFilters AS TeamFilters) AS s ON t.Phone = s.Phone
      WHEN MATCHED THEN UPDATE SET SportTypes = s.SportTypes, TeamFilters = s.TeamFilters
      WHEN NOT MATCHED THEN INSERT (Phone, SportTypes, TeamFilters) VALUES (s.Phone, s.SportTypes, s.TeamFilters);
    `);
  return { phone: phoneNorm };
}

/** Run post-insert cleanup proc [dbo].[LastSecondUpdate]. */
async function runLastSecondUpdate() {
  const config = getConfig();
  if (!config) throw new Error('Database not configured');

  let pool;
  try {
    pool = await sql.connect({
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
    console.error('[SQL] Running stored procedure [dbo].[LastSecondUpdate]...');
    await pool.request().execute('dbo.LastSecondUpdate');
    console.error('[SQL] [dbo].[LastSecondUpdate] finished.');
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (_) {}
    }
  }
}

module.exports = {
  getConfig,
  isConfigured,
  insertBroadcasts,
  getPool,
  getSportsTypes,
  getTeamsForSport,
  saveSubscription,
  runLastSecondUpdate,
};
