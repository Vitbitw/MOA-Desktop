export const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  model_list  TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  -- ── 旧的来源级计费通道列（billing/plan_*）：v5 已下沉到 provider_accounts，
  --    仅在迁移期存在（database.ts 迁移把值搬进账号表后 DROP），新代码不读不写 ──
  billing        TEXT NOT NULL DEFAULT 'usage',
  plan_amount    REAL,
  plan_currency  TEXT NOT NULL DEFAULT 'CNY',
  plan_anchor_ts INTEGER
);

-- ── v5 厂商账号：一个来源（厂商）下可挂无限个账号，通道 / 订阅费 / API Key 全部挂在账号上 ──
-- 默认账号 id = providers.id（零迁移：历史 request_logs.models.providerId 与 key-store 的
-- providerKeys[providerId] 原样即为该默认账号的 id）。每来源有且仅有一个 active=1 的账号。
CREATE TABLE IF NOT EXISTS provider_accounts (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',   -- 账号备注名；空 = UI 按通道显示
  billing       TEXT NOT NULL DEFAULT 'usage', -- 'usage' = 按量 | 'plan' = 订阅/Token 包
  plan_amount   REAL,                        -- 每期（月）实际消费金额；NULL/0 = 未配置
  plan_currency TEXT NOT NULL DEFAULT 'CNY',
  plan_anchor_ts INTEGER,
  active        INTEGER NOT NULL DEFAULT 0,  -- 当前调用/记账账号（每来源至多一个）
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider ON provider_accounts(provider_id);

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

-- 用量记录本地累计（Command Code / Xiaomi MiMo 共用，按账号隔离）：
--   Command Code：服务端 /internal/usage 对部分套餐只返回最近 100 条且无游标（实测 GOAT 套餐，
--     跨度仅约 20 分钟），把每次采集到的记录按 (account_id, record_id) 去重累积。
--   Xiaomi MiMo：服务端 /usage/detail/list 返回「日期×模型」聚合行，按 (date|model) 自然键
--     upsert 累积（跨月只增不减）；requests 记录该行的请求次数（CC 逐条记录恒为 1）。
--   列名沿用 source_id（省一次重建表），**实际存放 MonitorAccount.id**——默认账号 id = 源 id，
--   历史行因此原样有效；同源不同账号各占自己的分区，读取/清空互不串号。
CREATE TABLE IF NOT EXISTS cc_usage_records (
  source_id       TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,          -- 记录自身时间（epoch 毫秒）
  model           TEXT NOT NULL,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  tokens_total    INTEGER NOT NULL DEFAULT 0,
  cost            REAL NOT NULL DEFAULT 0,
  requests        INTEGER NOT NULL DEFAULT 1, -- 该记录代表的请求次数（聚合行为行内 requestCount）
  first_seen_at   INTEGER NOT NULL,          -- 本地首次采集到的时间（epoch 毫秒）
  PRIMARY KEY (source_id, record_id)
);

CREATE INDEX IF NOT EXISTS idx_cc_usage_source_model ON cc_usage_records(source_id, model);
CREATE INDEX IF NOT EXISTS idx_cc_usage_created ON cc_usage_records(source_id, created_at);

-- 后台采集运行记录：采集成功但"没有新记录"时，cc_usage_records 不留痕迹，
-- 无法判断采集器是否还在跑。这里持久化每轮采集的时间与结果，供 UI 显示"最近采集 X（已 N 轮）"。
-- source_id 同上：实际存放 MonitorAccount.id（账号级隔离）。
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
-- source_id 同上：实际存放 MonitorAccount.id（一账号一行，换账号不串快照）。
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
