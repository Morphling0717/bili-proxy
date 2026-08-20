# bili-proxy 2.0

一个部署在 Vercel Functions 上的 Bilibili **公开用户资料与公开内容聚合 API**。

这个版本保留旧接口的 `user`、`video_count`、`videos` 字段，因此原来的前端可以继续使用；同时把单一 UID、单一动态接口重构成通用的分区式采集服务。

## 能获取什么

默认 `section=all` 会尝试返回：

- `profile`：公开头像、昵称、签名、认证、等级、公开统计、置顶视频、直播状态
- `videos`：投稿视频
- `dynamics`：动态、图文、动态视频、转发等公开动态内容
- `articles`：专栏文章
- `audio`：音频投稿
- `collections`：合集与系列
- `favorites`：公开收藏夹目录

按需 section：

- `series_items`：指定系列内的视频，需要 `series_id`
- `season_items`：指定合集内的视频，需要 `season_id`
- `favorite_items`：指定公开收藏夹的内容，需要 `media_id`
- `following` / `followers`：平台允许访客查看时返回公开关系列表，单次最多连续 5 页

本项目只请求访客在网页端能够看到的公开数据，不会返回 Cookie、登录凭证或私密内容，也不包含验证码绕过、代理轮换或高频轰炸逻辑。

## 使用方法

```text
GET /api?mid=3546779356235807
```

只看视频：

```text
GET /api?mid=3546779356235807&section=videos&page=1&page_size=30
```

获取动态下一页：

```text
GET /api?mid=3546779356235807&section=dynamics&offset=<上一次的 next_offset>
```

在单次请求内连续翻页：

```text
GET /api?mid=3546779356235807&section=videos&complete=1&max_pages=10
```

合集/系列/收藏夹内容：

```text
GET /api?mid=<UID>&section=series_items&series_id=<ID>
GET /api?mid=<UID>&section=season_items&season_id=<ID>
GET /api?mid=<UID>&section=favorite_items&media_id=<ID>
```

接口说明：

```text
GET /api?help=1
```

安全诊断（只返回是否成功加载凭证字段，不返回字段内容）：

```text
GET /api?mid=<UID>&section=videos&debug=1
```

## 全量抓取的设计

Vercel Function 不适合在一次请求里无限翻页。`complete=1` 支持每个 section 最多连续 10 页，并设置总上游请求预算。响应中的：

- `next_page`
- `next_offset`
- `has_more`

可以用来继续请求，直到 `has_more=false`。这样即使用户有几千条内容，也能完整抓取，而不会让单个 Function 超时。

## 返回策略

各 section 独立成功或失败。某个接口被 Bilibili 限制时，其他 section 仍然返回：

```json
{
  "success": true,
  "partial": true,
  "sections": {
    "profile": { "ok": true, "data": {} },
    "videos": {
      "ok": false,
      "error": {
        "type": "upstream",
        "upstream": { "http_status": 412, "code": -352 }
      }
    }
  }
}
```

只有全部请求都失败时才返回 HTTP `502`。

## 环境变量

复制 `.env.example` 作为参考，在 Vercel Dashboard 配置：

| 变量 | 必需 | 说明 |
|---|---:|---|
| `BI_COOKIE` | 否 | 完整 Cookie 字符串。部分公开接口在云端 IP 下可能需要有效登录会话。不要提交到 Git。 |
| `TARGET_UID` | 否 | 省略 `mid` 时使用的默认 UID。 |
| `CORS_ORIGIN` | 否 | 限制允许访问 API 的前端来源，默认 `*`。 |
| `BILI_TIMEOUT_MS` | 否 | 上游请求超时，默认 7000ms。 |
| `BILI_USER_AGENT` | 否 | 覆盖默认浏览器 User-Agent。 |

## 稳定性处理

- 从公开 `finger/spi` 接口建立访客设备 Cookie
- 从用户空间 HTML 获取该 UID 对应的 `access_id` / `w_webid`
- 每次启动获取最新 WBI key 并签名
- 补齐网页端要求的动态验证参数
- CDN 缓存 5 分钟，并允许 1 小时 stale-while-revalidate
- 每个 section 局部失败，不让一个失效接口拖垮整份响应
- 输入上限、请求超时、连续翻页上限与总请求预算
- 所有错误信息都会过滤凭证，不在响应或日志中输出 Cookie

## 本地检查

```bash
npm run check
npm test
```

## 兼容旧版

根级字段仍保留：

```json
{
  "success": true,
  "uid": "3546779356235807",
  "user": {},
  "video_count": 30,
  "videos": []
}
```

新项目应优先使用 `sections`，因为其中包含完整分页和每个来源的错误状态。
