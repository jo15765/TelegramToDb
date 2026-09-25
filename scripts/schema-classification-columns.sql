-- Add ESPN + ChatGPT classification columns to SportsBroadcasts.
-- Safe to run once; skip if columns already exist.

IF COL_LENGTH('dbo.SportsBroadcasts', 'EspnSport') IS NULL
  ALTER TABLE [dbo].[SportsBroadcasts] ADD [EspnSport] NVARCHAR(100) NULL;

IF COL_LENGTH('dbo.SportsBroadcasts', 'ChatGptSport') IS NULL
  ALTER TABLE [dbo].[SportsBroadcasts] ADD [ChatGptSport] NVARCHAR(100) NULL;

IF COL_LENGTH('dbo.SportsBroadcasts', 'ClassificationSource') IS NULL
  ALTER TABLE [dbo].[SportsBroadcasts] ADD [ClassificationSource] NVARCHAR(20) NULL;
