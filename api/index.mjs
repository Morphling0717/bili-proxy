// 文件名：api/index.mjs
// 注意：后缀必须是 .mjs 以启用 ESM 模块支持

export default async function handler(req, res) {
  // 1. 设置跨域头 (允许你的网站调用)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // 2. 检查环境变量
    // 请务必确认 Vercel 后台已配置 BI_COOKIE
    const fullCookie = process.env.BI_COOKIE;
    const TARGET_UID = "3546779356235807";

    if (!fullCookie) {
      throw new Error("环境变量 BI_COOKIE 未配置");
    }

    // 3. 目标接口：B站动态 API (无需 Wbi 签名)
    const apiUrl = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${TARGET_UID}&offset_dynamic_id=0&need_top=1&platform=web`;

    // 4. 发起请求 (Node 18/20 原生支持 fetch)
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": `https://space.bilibili.com/${TARGET_UID}/dynamic`,
        "Cookie": fullCookie
      }
    });

    if (!response.ok) {
      throw new Error(`B站服务器连接失败: ${response.status}`);
    }

    const data = await response.json();

    // 检查业务错误码
    if (data.code !== 0) {
      // code -403 说明没权限/Cookie失效
      // code -412 说明被风控
      throw new Error(`B站返回错误: ${data.message} (code: ${data.code})`);
    }

    // 5. 解析动态数据
    const cards = data.data?.cards || [];
    const videos = [];

    for (const item of cards) {
      if (item.desc?.type === 8) { // 8 = 投稿视频
        try {
          const cardDetail = JSON.parse(item.card);
          videos.push({
            title: cardDetail.title,
            desc: cardDetail.desc,
            pic: cardDetail.pic,
            bvid: item.desc.bvid || cardDetail.bvid,
            url: `https://www.bilibili.com/video/${item.desc.bvid || cardDetail.bvid}`,
            created: item.desc.timestamp,
            length: cardDetail.duration,
            play: cardDetail.stat?.view,
            comment: cardDetail.stat?.reply,
            date: new Date(item.desc.timestamp * 1000).toLocaleDateString('zh-CN')
          });
        } catch (e) {
          console.error("解析单条动态失败，跳过", e);
        }
      }
    }

    // 6. 返回成功数据
    res.status(200).json({
      success: true,
      uid: TARGET_UID,
      count: videos.length,
      videos: videos
    });

  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "服务器内部错误"
    });
  }
}
