# bili-proxy 3.2

部署在 Vercel Functions 上的 Bilibili **公开用户资料与公开内容聚合 API**。

旧版只依赖一个动态接口，而且 URL 中的 UID 参数已经丢失；新版改为分区采集、多来源回退、真实分页游标和局部失败。旧前端仍可读取根级 `user`、`video_count`、`videos`，新项目应优先读取 `sections`。

## 能抓取什么

`section=everything` 会尽可能采集一个用户空间中访客可以看到的公开数据：

- `profile`：头像、昵称、签名、认证、等级、公开统计、置顶稿件、直播状态
- `videos`：公开视频投稿；网页 WBI 接口被风控时自动切到签名 APP 投稿游标接口
- `dynamics`：旧动态历史流与新版 Opus 图文流，合并并去重
- `articles`：公开专栏
- `audio`：公开音频投稿
- `collections`：合集与系列，使用多接口回退
- `favorites`：公开收藏夹目录，可选择继续展开公开收藏夹内容
- `following`：公开关注列表；隐藏时明确标记为 `privacy_restricted`
- `followers`：公开粉丝计数，以及平台当前允许匿名获取的名单；名单源失效时明确报错，不会伪造为空列表
- `public_extras`：代表作、标签、公告、投稿统计、文章统计、获赞、直播资料，以及平台公开时可见的近期互动、游戏、追番和追剧

按 ID 获取内容：

- `series_items`：系列内稿件，需要 `series_id`
- `season_items`：合集内稿件，需要 `season_id`
- `favorite_items`：公开收藏夹内容，需要 `media_id`

本项目只处理公开数据，不绕过登录、验证码、访问控制或用户隐私设置，也不返回 Cookie、令牌或其他凭证。

## 生产地址

```text
https://bili-proxy.vercel.app/api
https://api.uliuli.cc/api
```

## 常用请求

默认兼容模式：

```text
GET /api?mid=3546779356235807
```

最完整的公开数据入口：

```text
GET /api?mid=3546779356235807&section=everything
```

完整抓取投稿：

```text
GET /api?mid=3546779356235807&section=videos&complete=1&max_pages=10&page_size=30
```

抓取动态第一页：

```text
GET /api?mid=3546779356235807&section=dynamics
```

使用响应中的 `next_offset` 继续抓动态：

```text
GET /api?mid=3546779356235807&section=dynamics&offset=<next_offset>
```

单独获取扩展资料：

```text
GET /api?mid=3546779356235807&section=public_extras
```

公开收藏夹目录及内容：

```text
GET /api?mid=3546779356235807&section=favorites&public_force=1&expand_favorites=1
```

合集、系列或收藏夹内内容：

```text
GET /api?mid=<UID>&section=series_items&series_id=<ID>
GET /api?mid=<UID>&section=season_items&season_id=<ID>
GET /api?mid=<UID>&section=favorite_items&media_id=<ID>
```

帮助与安全诊断：

```text
GET /api?help=1
GET /api?mid=<UID>&section=everything&debug=1
```

`debug=1` 只返回请求状态、耗时、回退来源以及 Cookie 字段是否存在，不返回 Cookie 内容。

## 怎样真正抓完整

Vercel Function 不适合在一个请求里无限循环，所以“全量”由两层组成：

1. `section=everything` 先生成一份尽可能完整的公开快照。
2. 对仍有 `has_more=true` 的分区，携带它返回的游标继续请求，直到 `has_more=false`。

各分区的继续方式：

| 分区 | 继续参数 | 响应字段 |
|---|---|---|
| `videos` | `page=<next_page>` | `next_page`, `has_more` |
| `dynamics` | `offset=<next_offset>` | `next_offset`, `next_offsets`, `has_more` |
| `articles` / `audio` | `page=<next_page>` | `next_page`, `has_more` |
| `series_items` / `season_items` / `favorite_items` | `page=<next_page>` | `next_page`, `has_more` |
| `following` / `followers` | `page=<next_page>` | `next_page`, `has_more`, `completeness` |

`complete=1` 可以让单次请求连续抓多页；`max_pages` 最大为 10。内容量更大时仍应继续发下一次请求，而不是无限放大单次 Function。

`section=everything` 默认使用：

- `complete=1`
- `max_pages=5`
- 公开分区请求预算 80
- 最多自动展开 5 个公开收藏夹

可以通过 `public_request_budget`、`favorite_folder_limit` 等参数收紧，但不会超过服务端硬上限。

## 投稿抓取策略

1. 先尝试网页 WBI 投稿接口。
2. 如果遇到 `412`、`-352`、`-412` 等风控，自动切到签名的 BiliDroid APP 投稿接口。
3. APP 接口使用最后一条稿件的 `aid` 作为游标，并按 `bvid/aid` 跨页去重。
4. Chromium 只作为手动开启的最后回退，因为云端浏览器发出的内部 API 请求仍可能受到同样风控。

手动开启 Chromium：

```text
GET /api?mid=<UID>&section=videos&browser=1
GET /api?mid=<UID>&section=videos&browser_force=1
```

默认 `BROWSER_FALLBACK=0`。

## 动态抓取策略

- 先尝试旧空间动态历史流。
- 同时尝试新版 Opus 空间流。
- 两个来源按动态 ID 合并去重。
- 顶层统一返回 `next_offset`；调用方不需要区分内部流。
- `next_offsets.opus` 和 `next_offsets.legacy` 保留给需要精细控制的调用方。

## 关系链的完整性标记

关系名单比计数更容易受到用户隐私和平台接口限制，因此返回结果会明确区分：

- `complete`：已读完当前公开名单
- `public_page`：只返回当前公开页，仍可继续
- `privacy_restricted`：公开计数大于零，但账号隐藏了名单
- `public_cap_reached`：达到匿名公开名单上限
- `upstream_limit_reached`：名单接口停止继续返回
- 分区 `ok=false`：公开计数存在，但当前公开名单来源不可用

服务不会把“隐私隐藏”或“上游失效”伪装成 `0` 条。

## 返回结构

各分区独立成功或失败，一个分区失效不会拖垮整份响应：

```json
{
  "success": true,
  "partial": true,
  "version": "3.2.0",
  "mode": "everything",
  "uid": "3546779356235807",
  "sections": {
    "profile": { "ok": true, "data": {} },
    "videos": {
      "ok": true,
      "source": "app_archive_cursor",
      "data": {
        "items": [],
        "total": 119,
        "has_more": false,
        "next_page": null
      }
    },
    "dynamics": {
      "ok": true,
      "data": {
        "items": [],
        "has_more": true,
        "next_offset": "..."
      }
    },
    "following": {
      "ok": true,
      "data": {
        "total": 121,
        "accessible_total": 0,
        "privacy_restricted": true,
        "completeness": "privacy_restricted"
      }
    }
  }
}
```

只有所有请求都失败时才返回 HTTP `502`。只要至少一个分区成功，就返回 HTTP `200`，并通过 `partial` 告知是否存在受限或失败分区。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---:|---|
| `BI_COOKIE` | 否 | 完整 Cookie。失效登录字段会在公开回退层自动清除，不会回传。 |
| `TARGET_UID` | 否 | 省略 `mid` 时使用的默认 UID。 |
| `CORS_ORIGIN` | 否 | 允许访问 API 的前端来源，默认 `*`。 |
| `BILI_TIMEOUT_MS` | 否 | 普通上游请求超时。 |
| `BILI_USER_AGENT` | 否 | 普通公开请求 User-Agent。 |
| `APP_FALLBACK` | 否 | 设为 `0` 关闭 APP 投稿回退，默认开启。 |
| `BROWSER_FALLBACK` | 否 | 设为 `1` 开启 Chromium 最后回退，默认关闭。 |
| `BILI_BROWSER_USER_AGENT` | 否 | Chromium User-Agent。 |
| `CHROME_EXECUTABLE_PATH` | 否 | 本地调试 Chrome 路径。 |

## 稳定性措施

- Vercel 新加坡 `sin1` 区域和 Fluid Compute
- Node.js 24 运行时
- 访客设备 Cookie 与最新 WBI key 启动
- 失效 `SESSDATA/bili_jct` 自动剥离后匿名重试
- APP `aid` 游标翻页、跨页去重和真实总数校验
- 动态双流合并与统一游标
- 合集多接口回退、收藏夹可见性区分
- 关系计数交叉校验，区分隐私、公开上限和上游失效
- 每项请求超时、连续翻页上限和总请求预算
- CDN 缓存与 `stale-while-revalidate`
- 错误按分区隔离，诊断信息不泄露凭证

## 本地检查

```bash
npm install
npm run check
npm test
```
