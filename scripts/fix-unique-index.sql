-- Fix: 151 duplicate key errors on UX_SportsBroadcasts_UniqueGame
--
-- Cause: The unique index is on (SportsType, Team1, Team2, AirDate, AirTime) only.
-- Rows like ESPN+ 62, ESPN+ 63, ... with Team1/Team2 NULL and same date/time all
-- collide, so only one inserts and the rest fail.
--
-- Fix: Include AirChannel in the index so each channel (ESPN+ 62, ESPN+ 63, etc.)
-- is distinct. Run this script against your SportsBroadcasts database.
--

-- Drop the existing index
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UX_SportsBroadcasts_UniqueGame'
    AND object_id = OBJECT_ID('dbo.SportsBroadcasts')
)
  DROP INDEX [UX_SportsBroadcasts_UniqueGame] ON [dbo].[SportsBroadcasts];
GO

-- Recreate with AirChannel so each channel line is unique
CREATE UNIQUE NONCLUSTERED INDEX [UX_SportsBroadcasts_UniqueGame]
  ON [dbo].[SportsBroadcasts] ( SportsType, Team1, Team2, AirDate, AirTime, AirChannel )
  WHERE AirChannel IS NOT NULL;
GO
