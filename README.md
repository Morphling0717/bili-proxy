# bili-proxy 3.0

部署在 Vercel Functions 上的 Bilibili **公开用户资料与公开内容聚合 API**。它不再依赖一个容易被 `412/-352` 风控拦截的网页投稿接口，而是按内容类型采用多级公开接口、分页游标和局部失败策略。

旧版的根级 `user`、`video_count`、`videos` 字段仍保留；新项目应优先读取 `sections`。

## 已覆盖的公开内容

`section=everything` 会尽可能抓取一个用户空间中访客可见的内容：

- `profile`：头像、昵称、签名、认证、等级、公开统计、置顶稿件、直播状态
- `videos`：全部公开视频投稿；网页接口被风控时自动切到签名 APP 投稿接口
- `dynamics`：旧动态流与新版 Opus 图文流合并、去重
- `articles`：公开专栏
- `audio`：公开音频投稿
- `collections`：合集与系列，多接口回退
- `favorites`：创建与收藏的公开收藏夹；可继续展开收藏夹内容
- `following` / `followers`：平台允许匿名访问时返回公开关注与粉丝列表
- `public_extras`：代表作、标签、公告、近期点赞、近期投币、近期游戏、追番、追剧

按 ID 获取内容：

- `series_items`：系列内稿件，需要 `series_id`
- `season_items`：合集内稿件，需要 `season_id`
- `favorite_items`：公开收藏夹内容，需要 `media_id`

只采集公开接口能够返回的数据。空间主人隐藏的分区会标为 `empty_or_not_public` 或保留上游错误，不会尝试绕过登录、验证码、隐私设置或访问控制。

## 常用请求

默认聚合：

```text
GET /api?mid=3546779356235807
```

最完整模式：

```text
GET /api?mid=3546779356235807&section=everything
```

完整抓取投稿：

```text
GET /api?mid=3546779356235807&section=videos&complete=1&max_pages=10&page_size=30
```

增强动态抓取：

```text
GET /api?mid=3546779356235807&section=dynamics&public_force=1&complete=1&max_pages=5
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

`debug=1` 只返回请求状态、耗时以及 Cookie 字段是否存在，不返回 Cookie 内容。

## 分页与完整性

`complete=1` 会在一次请求中连续读取多页；`max_pages` 最大为 10。不同分区会返回适用的继续游标：

- `next_page`
- `next_offset`
- Opus 流的 `streams.opus_feed_space.next_offset`
- `has_more`

Vercel Function 不适合无限循环。用户内容超过单次上限时，调用方应携带返回的页码或偏移继续请求，直到 `has_more=false`。

`section=everything` 默认：

- `complete=1`
- `max_pages=5`
- 公开分区请求预算 80
- 最多自动展开 5 个公开收藏夹

可以通过 `public_request_budget`、`favorite_folder_limit` 等参数收紧，但不会超过服务端硬上限。

## 投稿抓取策略

1. 先尝试网页 WBI 投稿接口。
2. 如果遇到 `412`、`-352`、`-412` 等风控，切换到签名的 BiliDroid APP 投稿游标接口。
3. APP 接口使用最后一条稿件的 `aid` 翻页，并对 `bvid/aid` 去重。
4. Chromium 只作为手动开启的最后手段，因为云端页面内部请求也可能被同样的风控拦截。

开启 Chromium：

```text
GET /api?mid=<UID>&section=videos&browser=1
GET /api?mid=<UID>&section=videos&browser_force=1
```

默认 `BROWSER_FALLBACK=0`。

## 返回结构

每个分区独立成功或失败；一个分区失效不会拖垮整份响应：

```json
{
  "success": true,
  "partial": true,
  "version": "3.0.0",
  "uid": "3546779356235807",
  "sections": {
    "profile": { "ok": true, "data": {} },
    "videos": {
      "ok": true,
      "source": "app_archive_cursor",
      "data": {
        "items": [],
        "total": 119,
        "has_more": false
      }
    },
    "followers": {
      "ok": false,
      "error": { "type": "upstream", "message": "..." }
    }
  }
}
```

只有所有请求都失败时才返回 HTTP `502`。输入错误、帮助页和预检请求会保留各自的正常状态码。

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
- 动态双流合并、合集三级回退、收藏夹可见性区分
- 每项请求超时、连续翻页上限、总请求预算
- CDN 缓存和 `stale-while-revalidate`
- 错误按分区隔离，诊断信息不泄露凭证

## 本地检查

```bash
npm install
npm run check
npm test
```
