# MiMo 平台 POST 端点 ph query 要求（修复说明）

日期：2026-09-26
报障：云监控 MiMo 面板「刚登录就提示登录已过期（Cookie 约 24h 有效），请重新登录」。

## 现象与误判

- 任意时刻点刷新都报「登录已过期」，与是否刚登录无关（容易误以为是登录捕获/凭证时效问题）。
- UI 文案来自 `refreshMimoUsage` 的判定：6 个端点任一 401/403 → `session_expired`。

## 根因（实证）

平台网关（MiFE）对 **POST 端点**额外要求 URL query 带 `api-platform_ph`：

- 值 = 同名 cookie 去首尾双引号后 URL 编码（平台 Set-Cookie 会把值用 `"` 包裹，如 `api-platform_ph="wZksK9y0Ho/f+n1ukVgddA=="`）。
- 官网前端（main chunk 模块 29618，请求层 `p()`）对**所有 POST** 都会注入：`params = { api-platform_ph: <document.cookie 去引号值>, ...params }` → 拼进 query。
- 缺失或带引号（`%22...%22`）→ 网关判定未登录：**401 + `loginUrl` + Set-Cookie 清 `api-platform_serviceToken`/`userId`**（Max-Age=0）。
- GET 端点无此要求。

真实凭证实测矩阵（同一份 cookie）：

| 请求 | 状态 |
| --- | --- |
| 5 个 GET（balance / tokenPlan×3 / usage） | 200 ✅ |
| `POST /usage/detail/list`（无 ph） | 401 |
| `POST` + ph 带引号 | 401 |
| `POST` + ph 去引号 | 200 ✅ |

官网控制台自身请求抓包：`POST /api/v1/usage/detail/list?api-platform_ph=wZksK9y0Ho%2Ff%2Bn1ukVgddA%3D%3D` → 200。

POST body 形态对齐官网（`{year, month, apiKeys?, batch?}`）；`Accept-Language`/`x-timeZone`/Origin/Referer/UA 均非必需项（全部对照过）。

## 修复（src/main/monitoring/mimo.ts）

1. `mimoPost`：从凭证 Cookie 头解析 `api-platform_ph`（`cookieValue` 去首尾引号）→ `?api-platform_ph=${encodeURIComponent(ph)}`；缺 ph 时优雅退化（不带 query）。
2. `REQUIRED_COOKIES` 增加 `api-platform_ph`：登录轮询只有集齐 4 个真实 cookie（serviceToken/userId/slh/ph）才算捕获成功，避免保存「GET 可用、POST 不可用」的中间态凭证。
3. 回归：`npm run test:mimo-request`（14 断言：URL 形态、缺 ph 退化、401/network/not_authenticated 分层）；`test:login-window` 的 MiMo fixture 对齐真实 4-cookie 形态。

## 约束（未来改动注意）

- **MiMo 平台任何 POST 端点都必须带 ph query**（含将来可能接入的 `/usage/plugin/list`、`/usage/export` 等）；`mimoPost` 已统一处理，勿绕过它直接 fetch。
- ph 随登录会话产生，**每次刷新实时从凭证提取**（不要缓存成常量）。
- 网关 401 会顺带 Set-Cookie 清登录 cookie —— 不影响应用侧保存的凭证串（node fetch 无 cookie jar），但意味着「点重新登录 → 再登录 → 再 401」的循环在修复前无法自愈。
