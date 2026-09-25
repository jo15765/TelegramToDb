-- SportsBroadcasts table (optional full DDL for new installs)
-- If the table already exists, run only the ALTER below to add ProgramName.

-- CREATE TABLE [dbo].[SportsBroadcasts] (
--   Id            INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
--   SportsType    NVARCHAR(100)  NULL,
--   Team1         NVARCHAR(200) NULL,
--   Team2         NVARCHAR(200) NULL,
--   AirDate       DATE           NULL,
--   AirTime       TIME           NULL,
--   AirChannel    NVARCHAR(150)  NULL,
--   TelegramLink  NVARCHAR(500)  NULL
-- );

-- Add program name column (raw message line / program title).
-- Use NVARCHAR(MAX) so Unicode (e.g. ñ in "Español") is stored correctly.
-- Also see scripts/schema-classification-columns.sql for EspnSport / ChatGptSport.
ALTER TABLE [dbo].[SportsBroadcasts]
  ADD [ProgramName] NVARCHAR(MAX) NULL;

-- If you previously added ProgramName as VARCHAR(MAX), alter to NVARCHAR(MAX):
-- ALTER TABLE [dbo].[SportsBroadcasts] ALTER COLUMN [ProgramName] NVARCHAR(MAX) NULL;

-- =============================================================================
-- Fix duplicate key errors: include AirChannel in unique index
-- =============================================================================
-- The index UX_SportsBroadcasts_UniqueGame is on (SportsType, Team1, Team2, AirDate, AirTime).
-- Rows with no teams and same date/time (e.g. ESPN+ 62, ESPN+ 63, ...) all collide.
-- Run this to drop the old index and create one that includes AirChannel so each
-- channel (ESPN+ 62, ESPN+ 63, etc.) is distinct.
--
-- DROP INDEX [UX_SportsBroadcasts_UniqueGame] ON [dbo].[SportsBroadcasts];
-- CREATE UNIQUE NONCLUSTERED INDEX [UX_SportsBroadcasts_UniqueGame]
--   ON [dbo].[SportsBroadcasts] ( SportsType, Team1, Team2, AirDate, AirTime, AirChannel )
--   WHERE AirChannel IS NOT NULL;
--
-- If you prefer to allow full duplicates (e.g. re-run inserts everything again),
-- just drop the index and do not recreate it:
--
-- DROP INDEX [UX_SportsBroadcasts_UniqueGame] ON [dbo].[SportsBroadcasts];
