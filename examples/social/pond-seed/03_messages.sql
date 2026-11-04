-- Who messages whom: mostly within a team, some across teams, and a few connectors
-- (every 25th person) who talk to everyone. weight = messages sent.
CREATE OR REPLACE TABLE demo.social.messages AS
WITH pairs AS (
  SELECT
    i AS sender,
    CASE
      WHEN k < 6 THEN (i % 6) + 6 * ((i // 6 + 1 + (hash(i, k) % 49)::INT) % 50)   -- same team
      ELSE (hash(i, k, 'x') % 300)::INT                                             -- anyone
    END AS recipient,
    1 + (hash(i, k, 'n') % 12)::INT AS messages
  FROM range(300) a(i), range(8) b(k)
  WHERE k < 7 OR i % 25 = 0
  UNION ALL
  SELECT i, (hash(i, k, 'hub') % 300)::INT, 1 + (hash(i, k) % 4)::INT
  FROM range(0, 300, 25) a(i), range(25) b(k)
)
SELECT sender, recipient, sum(messages)::INT AS weight
FROM pairs
WHERE sender <> recipient
GROUP BY ALL;
