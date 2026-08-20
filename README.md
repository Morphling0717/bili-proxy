# bili-proxy 3.2

部署在 Vercel Functions 上的 Bilibili **公开用户资料与公开内容聚合 API**。服务按内容类型使用多级公开接口、签名 APP 投稿游标、动态双游标、分页和局部失败策略，不再把成败押在单个容易触发 `412/-352` 风控的网页接口上。

旧版根级 `user`、`video_count`、`videos` 字段仍然保留；新项目应优先读取 `sections`。

## 能抓取什么

`section=everything` 会尽可能收集一个用户空间对访客公开的内容：

- `profile`：昵称、头像、签名、认证、等级、公开统计、置顶稿件、直播状态
- `videos`：全部公开视频投稿；网页 WBI 接口被风控时自动切换到签名 APP 投稿游标
- `dynamics`：旧动态流与新版 Opus 图文流并行分页、合并和去重
- `articles`：公开专栏
- `audio`：公开音频投稿
- `collections`：合集与系列，多接口回退
- `favorites`：创建及收藏的公开收藏夹，可继续展开公开收藏夹内容
- `following`：公开关注列表；名单被隐藏时保留总数并标记隐私限制
- `followers`：公开粉丝窗口；名单接口不可用时保留总数，不会把整次请求打成 502
- `public_extras`：代表作、标签、公告、近期点赞、近期投币、近期游戏、追番、追剧

按 ID 获取明细：

- `series_items`：系列内稿件，需要 `series_id`
- `season_items`：合集内稿件，需要 `season_id`
- `favorite_items`：公开收藏夹内容，需要 `media_id`

只采集公开接口能够返回的数据。空间主人隐藏的分区会返回明确状态，不会尝试绕过登录、验证码、隐私设置或访问控制。

## 常用请求

默认聚合：

```text
GET /api?mid=3546779356235807
```

尽可能完整的公开资料：

```text
GET /api?mid=3546779356235807&section=everything
```

完整抓取投稿：

```text
GET /api?mid=3546779356235807&section=videos&complete=1&max_pages=10&page_size=30
```

增强动态抓取：

```text
GET /api?mid=3546779356235807&section=dynamics&complete=1&max_pages=10&public_force=1
```

公开关注与粉丝：

```text
GET /api?mid=<UID>&section=following&complete=1&max_pages=10
GET /api?mid=<UID>&section=followers&complete=1&max_pages=10
```

合集、系列和公开收藏夹内容：

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

## 分区选择

`section` 可以传单个分区或逗号分隔的多个分区：

```text
GET /api?mid=<UID>&section=profile,videos,dynamics,collections
```

支持的聚合别名：

- `all`：默认核心公开内容
- `everything` / `full`：尽可能完整的公开内容

## 分页与完整性

`complete=1` 会在一次请求内连续读取多页，`max_pages` 最大为 10。不同分区会返回适用的继续游标：

- `next_page`
- `next_offset`
- `has_more`
- 动态的 `streams.legacy_space.next_offset`
- 动态的 `streams.opus_feed_space.next_offset`

动态的旧流和 Opus 流使用不同游标。v3.2 会分别推进两条流，已经结束的一条不会阻止另一条继续抓取；合并结果按动态 ID 去重。

Vercel Function 不适合无限循环。内容超过单次页数或请求预算时，调用方应携带返回的页码或偏移继续请求，直到 `has_more=false`。

`section=everything` 默认开启连续分页，并设置公开分区总请求预算，避免单个超大账号拖垮整次函数调用。预算达到上限时会返回继续游标，而不是假装已经抓完。

## 投稿抓取策略

1. 先尝试网页 WBI 投稿接口。
2. 遇到 `412`、`-352`、`-412` 等风控时，自动切换到签名的 BiliDroid APP 投稿游标接口。
3. APP 接口使用最后一条稿件的 `aid` 翻页，并按 `bvid/aid` 跨页去重。
4. Chromium 只作为可选的最后手段，因为云端浏览器内部请求仍可能被同样的风控拦截。

手动开启 Chromium：

```text
GET /api?mid=<UID>&section=videos&browser=1
GET /api?mid=<UID>&section=videos&browser_force=1
```

默认 `BROWSER_FALLBACK=0`。

## 关注与粉丝列表语义

关系分区使用三层证据链：

1. 先请求常规网页关系接口。
2. 登录态失效或网页接口被风控时，切换到匿名游戏端公开列表。
3. 同时查询公开关系统计，用于区分“确实为 0”“名单隐藏”和“公开名单当前不可用”。

关键字段：

- `total`：公开统计中的真实总数；无法确认时为 `null`
- `accessible_total`：当前公开列表实际取得的数量
- `privacy_restricted=true`：关注总数大于 0，但目标关闭了关注名单展示
- `public_list_unavailable=true`：公开名单接口没有返回可用条目，但总数仍可取得；这是非致命状态
- `privacy_restricted=null`：名单为空且统计接口也不可用，无法判断是空、隐藏还是上游暂时不可用
- `completeness=privacy_restricted`：名单明确受隐私设置限制
- `completeness=public_list_unavailable`：总数明确，但公开名单窗口不可用
- `completeness=indeterminate_empty_list`：证据不足，不会把未知情况伪报成 0
- `public_cap=100`：匿名粉丝公开窗口最多前 100 人

粉丝名单不可用不会令该分区返回 502，也不会伪造前 100 名；API 会返回真实总数、空条目和明确状态。

## 返回结构

每个分区独立成功或失败，一个分区失效不会拖垮整份响应：

```json
{
  "success": true,
  "partial": false,
  "version": "3.2.0",
  "uid": "3546779356235807",
  "sections": {
    "videos": {
      "ok": true,
      "source": "app_archive_cursor",
      "data": {
        "items": [],
        "total": 119,
        "has_more": false
      }
    },
    "following": {
      "ok": true,
      "source": "biligame_public_relation",
      "data": {
        "items": [],
        "total": 121,
        "privacy_restricted": true,
        "completeness": "privacy_restricted"
      }
    },
    "followers": {
      "ok": true,
      "source": "biligame_public_relation",
      "data": {
        "items": [],
        "total": 2057,
        "accessible_total": 0,
        "public_cap": 100,
        "privacy_restricted": false,
        "public_list_unavailable": true,
        "completeness": "public_list_unavailable"
      }
    }
  }
}
```

只有所有请求都失败时才返回 HTTP `502`。输入错误、帮助页和预检请求保留各自的正常状态码。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---:|---|
| `BI_COOKIE` | 否 | 完整 Cookie。失效登录字段会在公开回退层自动清除，不会回传。 |
| `TARGET_UID` | 否 | 省略 `mid` 时使用的默认 UID。 |
| `CORS_ORIGIN` | 否 | 允许访问 API 的前端来源，默认 `*`。 |
| `BILI_TIMEOUT_MS` | 否 | 普通上游请求超时。 |
| `BILI_USER_AGENT` | 否 | 普通公开请求 User-Agent。 |
| `APP_FALLBACK` | 否 | 设为 `0` 关闭 APP 投稿回退，默认开启。 |
| `RELATION_FALLBACK` | 否 | 设为 `0` 关闭匿名公开关系回退，默认开启。 |
| `BROWSER_FALLBACK` | 否 | 设为 `1` 开启 Chromium 最后回退，默认关闭。 |
| `BILI_BROWSER_USER_AGENT` | 否 | Chromium User-Agent。 |
| `CHROME_EXECUTABLE_PATH` | 否 | 本地调试 Chrome 路径。 |

## 稳定性措施

- Vercel 新加坡 `sin1` 区域和 Fluid Compute
- Node.js 24 运行时
- 访客设备 Cookie 与最新 WBI key 启动
- 失效 `SESSDATA/bili_jct` 自动剥离后匿名重试
- APP `aid` 游标翻页、跨页去重和真实总数校验
- 动态旧流与 Opus 流独立推进、合并去重
- 合集多级回退、公开收藏夹可见性区分
- 匿名关系回退、公开总数佐证和粉丝前 100 人上限标记
- 每项请求超时、连续翻页上限和总请求预算
- CDN 缓存与 `stale-while-revalidate`
- 错误按分区隔离，诊断信息不泄露凭证

## 本地检查

```bash
npm install
npm run check
npm test
```
