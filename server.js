'use strict';

try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const sqlserver = require('./lib/sqlserver');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json());

app.get('/api/sports-types', async (req, res) => {
  try {
    if (!sqlserver.isConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const list = await sqlserver.getSportsTypes();
    res.json(list);
  } catch (e) {
    console.error('[API] sports-types:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/teams', async (req, res) => {
  try {
    const sportsType = req.query.sportsType;
    if (!sportsType || typeof sportsType !== 'string') {
      return res.status(400).json({ error: 'sportsType query required' });
    }
    if (!sqlserver.isConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const list = await sqlserver.getTeamsForSport(sportsType.trim());
    res.json(list);
  } catch (e) {
    console.error('[API] teams:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const { phone, sportTypes, teamFilters } = req.body || {};
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'phone required' });
    }
    if (!sqlserver.isConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const result = await sqlserver.saveSubscription(
      phone,
      Array.isArray(sportTypes) ? sportTypes : [],
      teamFilters && typeof teamFilters === 'object' ? teamFilters : {}
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[API] subscribe:', e.message);
    res.status(400).json({ error: e.message });
  }
});

const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexHtml = path.join(clientDist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return res.status(404).send('Not found. Run: npm run build:client');
  }
  res.sendFile(indexHtml, (err) => {
    if (err) res.status(404).send('Not found');
  });
});

app.listen(PORT, () => {
  console.error(`Server listening on http://localhost:${PORT}`);
});
