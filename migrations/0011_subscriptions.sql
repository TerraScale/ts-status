-- Subscriptions to incident updates by email or webhook (Discord, Slack or
-- generic), confirmed by double opt-in, optionally limited to components;
-- and the outbox of messages to deliver, with retries.
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'webhook')),
  -- The email address, or the webhook URL.
  target TEXT NOT NULL,
  flavor TEXT NOT NULL DEFAULT 'email' CHECK (flavor IN ('email', 'discord', 'slack', 'generic')),
  -- Component ids to hear about; empty means all.
  components TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(components)),
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, target)
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  -- A confirmation request, or an incident update (update_id).
  kind TEXT NOT NULL CHECK (kind IN ('confirm', 'update')),
  update_id TEXT REFERENCES incident_updates(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  -- The delivery run holding the message while it sends, so overlapping
  -- runs never send it twice.
  claim TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subscriber_id, update_id)
);
CREATE INDEX outbox_due_idx ON outbox(sent_at, next_attempt_at);
