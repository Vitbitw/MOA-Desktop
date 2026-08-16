export const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  model_list  TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'api',
  engine_id   TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  mode        TEXT NOT NULL DEFAULT 'aggregate',
  sub_models  TEXT NOT NULL DEFAULT '[]',
  agg_config  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  title_edited INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'aggregate',
  sub_outputs     TEXT,
  token_usage     TEXT,
  timestamp       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
  request_id      TEXT PRIMARY KEY,
  timestamp       INTEGER NOT NULL,
  client_ip       TEXT NOT NULL DEFAULT '127.0.0.1',
  source          TEXT NOT NULL DEFAULT 'chat',
  moa_mode        TEXT NOT NULL DEFAULT 'direct',
  sub_count       INTEGER NOT NULL DEFAULT 1,
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost            REAL NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  success         INTEGER NOT NULL DEFAULT 1,
  error_detail    TEXT,
  models          TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON request_logs(timestamp DESC);

CREATE TABLE IF NOT EXISTS moa_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_engines (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  engine_type TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  binary_path TEXT,
  port        INTEGER,
  status      TEXT NOT NULL DEFAULT 'stopped',
  version     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_models (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  gguf_path        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  hf_repo          TEXT NOT NULL,
  hf_file          TEXT NOT NULL,
  quantization     TEXT,
  status           TEXT NOT NULL DEFAULT 'downloaded',
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_models_status ON local_models(status);
`
