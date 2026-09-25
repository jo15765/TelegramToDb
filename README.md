# TelegramToDb

Read sports schedule posts from a **Telegram** channel (public scraper or **private channel** via your account), parse listings, classify sport type (ESPN → OpenAI/Gemini), and **insert into Microsoft SQL Server**. Optional **React** UI for phone notification subscriptions.

Repository: [github.com/jo15765/TelegramToDb](https://github.com/jo15765/TelegramToDb)

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![SQL Server](https://img.shields.io/badge/SQL%20Server-MSSQL-red)

---

## What this project does

| Component | File | Purpose |
|-----------|------|---------|
| Public channel (no login) | `index.js` | Scrape **public** `t.me/s/ChannelName` via `telegram-scraper`; print today’s posts (EST) |
| Private channel (your account) | `private-channel.js` | **Main pipeline**: GramJS (`telegram` package), read private channel, parse, classify, **write to DB** |
| Web API + UI | `server.js` + `client/` | Express API; Vite/React app for sport/team **subscription** preferences |
| Parsing | `lib/parse-sports.js` | Turn message text into broadcast rows |
| ESPN classify | `lib/espn-sport-detect.js` | Match teams/date to ESPN scoreboard |
| LLM classify | `lib/openai-sport-detect.js` | OpenAI + Gemini fallback for unknown sports |
| Database | `lib/sqlserver.js` | Inserts + subscription API |
| SQL scripts | `scripts/*.sql` | Table schema and migrations |
| Backfill | `scripts/backfill-llm-parsed.js` | Re-run LLM on existing `parsed` rows |

---

## Architecture (private channel flow)

```text
Telegram channel messages
        ↓
private-channel.js (GramJS + your session)
        ↓
parse-sports.js → structured records
        ↓
espn-sport-detect.js → sport type (when possible)
        ↓
openai-sport-detect.js → ChatGPT / Gemini for Unknown
        ↓
sqlserver.js → INSERT SportsBroadcasts
        ↓
[dbo].[LastSecondUpdate] stored procedure (if present)
```

---

## Requirements

- **Node.js** 18+ (recommended)
- **npm** packages (see Setup — root `package.json` may need to exist locally; the GitHub repo may not include it yet)
- **Microsoft SQL Server** (Azure SQL or on-prem)
- **Telegram**:
  - Public mode: public channel username only
  - Private mode: [my.telegram.org](https://my.telegram.org/apps) **api_id** + **api_hash**, membership in the channel
- **Optional LLM keys**: OpenAI and/or Google Gemini (for unknown sport classification)
- **Optional**: ESPN APIs used by `espn-sport-detect.js` (no key in code — public scoreboard)

---

## Sensitive files — do NOT commit to GitHub

### Never commit (add to `.gitignore`)

| File / pattern | Why |
|----------------|-----|
| **`.env`** | All secrets (already in `.gitignore` on repo) |
| **`.telegram-session`** | Saved Telegram login session — **full account access** if leaked |
| **`.env.local`**, **`.env.production`** | Environment overrides |

**Important:** Repo `.gitignore` currently only lists `.env`. You should extend it:

```gitignore
.env
.env.*
!.env.example
.telegram-session
node_modules/
client/dist/
```

If **`.telegram-session`** or **`.env`** were ever pushed, **rotate Telegram session** (delete session file and re-login), **rotate API keys**, and consider **git history cleanup**.

### Do not put real values in tracked files

| File | Safe to commit? |
|------|-----------------|
| `index.js` | Yes — uses placeholder `YourChannelUsername` or env |
| `private-channel.js` | Yes — reads credentials from **environment only** |
| `lib/sqlserver.js` | Yes — env-only |
| `lib/openai-sport-detect.js` | Yes — env-only |
| `server.js` | Yes |

### Environment variables (keep in `.env` only)

Create **`.env`** in the project root (copy from `.env.example` if you add one):

```env
# --- Telegram (private-channel.js) ---
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=your_api_hash_from_my_telegram_org
TELEGRAM_CHANNEL_TITLE=Live TV
TELEGRAM_INVITE_LINK=https://t.me/+YourPrivateInviteHash
TELEGRAM_SESSION_FILE=.telegram-session

# --- SQL Server ---
MSSQL_HOST=your-server.database.windows.net
MSSQL_PORT=1433
MSSQL_USER=your_user
MSSQL_PASSWORD=your_password
MSSQL_DATABASE=your_database
MSSQL_TABLE=SportsBroadcasts
MSSQL_TRUST_SERVER_CERTIFICATE=true

# --- LLM (optional) ---
OPENAI_API_KEY=sk-...
OPENAI_SPORT_MODEL=gpt-4o-mini
GEMINI_API_KEY=...
GEMINI_SPORT_MODEL=gemini-3.6-flash

# --- Public scraper (index.js) ---
TELEGRAM_CHANNEL=PublicChannelUsername

# --- Web server ---
PORT=3000
```

Commit **`.env.example`** with empty placeholders instead of real values.

---

## Database setup (step-by-step)

1. Connect to your SQL Server instance.
2. Run scripts in order (adjust database name as needed):
   - `scripts/schema.sql` — main `SportsBroadcasts` table
   - `scripts/schema-classification-columns.sql` — ESPN/LLM columns if upgrading
   - `scripts/schema-subscriptions.sql` — `NotificationSubscriptions` for the React UI
   - `scripts/fix-unique-index.sql` — if you hit duplicate index issues
3. Ensure stored procedure **`[dbo].[LastSecondUpdate]`** exists on your server if you rely on post-insert cleanup (referenced in `lib/sqlserver.js`).

---

## Install and run (step-by-step)

### 1. Clone

```bash
git clone https://github.com/jo15765/TelegramToDb.git
cd TelegramToDb
```

### 2. Install dependencies

If the repo includes `package.json`:

```bash
npm install
cd client && npm install && cd ..
```

Expected root dependencies (from code): `telegram`, `dotenv`, `mssql`, `telegram-scraper`, `express`, `cors`, and others used by `lib/`. If `package.json` is missing from GitHub, recreate it locally or copy from your working machine — do not commit secrets into it.

### 3. Configure `.env`

Follow the template above. Get Telegram API credentials from [https://my.telegram.org/apps](https://my.telegram.org/apps).

### 4. Private channel ingest (main job)

First run (interactive login — phone + SMS code + 2FA if enabled):

```bash
node private-channel.js
```

Or, if `package.json` defines it:

```bash
npm start
```

**CLI date options:**

| Flag | Meaning |
|------|---------|
| (default) | Today (EST) |
| `--yesterday` | Yesterday |
| `--day -1` | Same as yesterday |
| `--day 0` | Today |
| `--last30` or `--last-30` | Last 30 days |
| `--days 7` | Last 7 days |

Example:

```bash
node private-channel.js --yesterday
node private-channel.js --days 30
```

Session is saved to `.telegram-session` (or `TELEGRAM_SESSION_FILE`).

### 5. Public channel (read-only test, no DB)

```bash
TELEGRAM_CHANNEL=YourPublicChannel node index.js
# or
node index.js YourPublicChannel
```

Does **not** work with `t.me/+privateInvite` links.

### 6. Web UI + API

Build the client:

```bash
cd client
npm run build
cd ..
```

Start the server:

```bash
node server.js
```

Open [http://localhost:3000](http://localhost:3000) — subscribe with phone, sports, and optional teams.

API routes:

- `GET /api/sports-types`
- `GET /api/teams?sportsType=Basketball`
- `POST /api/subscribe` — body: `{ phone, sportTypes, teamFilters }`

### 7. Backfill LLM classifications

```bash
node scripts/backfill-llm-parsed.js --limit=30
node scripts/backfill-llm-parsed.js --limit=30 --dry-run
node scripts/backfill-llm-parsed.js --limit=30 --with-openai
```

Requires `GEMINI_API_KEY` (and optionally `OPENAI_API_KEY`).

---

## Project layout

```text
TelegramToDb/
├── index.js                 # Public channel scraper (console)
├── private-channel.js       # Private channel → DB pipeline
├── server.js                # Express + static React build
├── .gitignore               # Should include .env + .telegram-session
├── lib/
│   ├── parse-sports.js
│   ├── espn-sport-detect.js
│   ├── openai-sport-detect.js
│   ├── sqlserver.js
│   └── tfjs-sport-detect.js
├── scripts/
│   ├── schema.sql
│   ├── schema-subscriptions.sql
│   ├── schema-classification-columns.sql
│   ├── fix-unique-index.sql
│   └── backfill-llm-parsed.js
└── client/                  # Vite + React subscription UI
    └── src/App.jsx
```

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| Missing config on start | `.env` in project root; `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, channel title or invite |
| Channel not found | `TELEGRAM_CHANNEL_TITLE` substring matches dialog name; or valid invite link |
| MSSQL connection / certificate | `MSSQL_*` vars; try `MSSQL_TRUST_SERVER_CERTIFICATE=true` |
| LLM skipped | Set `OPENAI_API_KEY` and/or `GEMINI_API_KEY` |
| UI “Database not configured” | Same MSSQL env vars; run schema scripts |
| UI 404 | Run `npm run build` in `client/` so `client/dist` exists |
| OpenAI 429 | Normal on free tier; Gemini fallback runs automatically |

---

## Legal and compliance

- Use only for channels and data you are **allowed** to access.
- Respect **Telegram Terms of Service** and rate limits.
- SMS notifications (mentioned in UI) require your own provider (e.g. Twilio) — not fully wired in this repo alone.
- LLM/API usage may incur **costs**; monitor quotas.

---

## Suggested repo hygiene before public GitHub

1. Extend **`.gitignore`** (session file, `node_modules`, `client/dist`).
2. Add **`.env.example`** (no secrets).
3. Add root **`package.json`** with scripts: `start`, `build:client`, `backfill:llm` if missing from remote.
4. Remove **`target/`**, **`out/`**, or committed build artifacts if present (prefer build in CI/local only).
5. Confirm **no `.telegram-session`** or **`.env`** in git history: `git log --all -- .env .telegram-session`

---

## License

Add a `LICENSE` file when you choose one (for example MIT).

---

## Author

**jo15765** — [TelegramToDb on GitHub](https://github.com/jo15765/TelegramToDb)
