export const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  model_list  TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  -- ── T1 按量/Plan 双通道（v4 B 方案：厂商分组列已移除）──
  billing        TEXT NOT NULL DEFAULT 'usage', -- 计费通道：'usage' = 按量 | 'plan' = 订阅/Token 包
  plan_amount    REAL,                          -- 每期（月）实际消费金额；NULL/0 = 未配置（回退单价链估算）
  plan_currency  TEXT NOT NULL DEFAULT 'CNY',   -- 消费币种：'USD' | 'CNY'（CNY→USD 折算率 7.2）
  plan_anchor_ts INTEGER                        -- 周期起始（epoch 毫秒）；NULL = 当月 1 号
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

-- Command Code 用量记录本地累计：
-- 服务端 /internal/usage 对部分套餐只返回最近 100 条且无游标（实测 GOAT 套餐，跨度仅约 20 分钟），
-- 因此把每次采集到的记录按 (source_id, record_id) 去重累积，供「本地累计」口径的模型明细使用。
CREATE TABLE IF NOT EXISTS cc_usage_records (
  source_id       TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,          -- 记录自身时间（epoch 毫秒）
  model           TEXT NOT NULL,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  tokens_total    INTEGER NOT NULL DEFAULT 0,
  cost            REAL NOT NULL DEFAULT 0,
  first_seen_at   INTEGER NOT NULL,          -- 本地首次采集到的时间（epoch 毫秒）
  PRIMARY KEY (source_id, record_id)
);

CREATE INDEX IF NOT EXISTS idx_cc_usage_source_model ON cc_usage_records(source_id, model);
CREATE INDEX IF NOT EXISTS idx_cc_usage_created ON cc_usage_records(source_id, created_at);

-- 后台采集运行记录：采集成功但"没有新记录"时，cc_usage_records 不留痕迹，
-- 无法判断采集器是否还在跑。这里持久化每轮采集的时间与结果，供 UI 显示"最近采集 X（已 N 轮）"。
CREATE TABLE IF NOT EXISTS cc_collector_state (
  source_id       TEXT PRIMARY KEY,
  last_run_at     INTEGER NOT NULL,
  last_ok_at      INTEGER,
  last_error      TEXT,
  runs            INTEGER NOT NULL DEFAULT 0,
  ok_runs         INTEGER NOT NULL DEFAULT 0,
  total_inserted  INTEGER NOT NULL DEFAULT 0
);

-- 云监控页面用量快照：渲染层页面缓存（lib/cloudMonitorCache.ts）只活在会话内，
-- 这里持久化最近一次成功拉取的归一化用量（monitor:refresh 返回值），
-- 应用重启后首进由此恢复上次数据（再由渲染层按统一自动刷新间隔决定是否静默刷新）。
-- 写入点：页面刷新成功 / 后台采集成功；登出时清除（换账号不残留）。
CREATE TABLE IF NOT EXISTS monitor_snapshots (
  source_id  TEXT PRIMARY KEY,
  usage_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS moa_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`
