-- Subscriptions table: phone number + which sports (and optionally which teams) to get notifications for.
-- Run this on the same database as SportsBroadcasts (e.g. DailySportsData).

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'NotificationSubscriptions')
BEGIN
  CREATE TABLE [dbo].[NotificationSubscriptions] (
    Id            INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Phone         NVARCHAR(20)    NOT NULL,
    SportTypes    NVARCHAR(MAX)   NOT NULL,  -- JSON array: ["NCAA Men's Basketball", "NHL"]
    TeamFilters   NVARCHAR(MAX)   NULL,      -- JSON: { "NCAA Men's Basketball": ["Rutgers", "Michigan"], "NHL": [] }
    CreatedAt     DATETIME2(2)    NOT NULL DEFAULT SYSDATETIME(),
    UNIQUE (Phone)
  );
END
GO
