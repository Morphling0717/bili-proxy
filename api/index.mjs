// 文件名：api/index.mjs
export default async function handler(req, res) {
  // 1. 设置跨域头
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // 重要：设置 Vercel 缓存策略 (CDN 缓存 60秒，过期后继续服务旧数据 60秒并后台刷新)
  // 这意味着 1 分钟内无论多少人访问你的接口，Vercel 只会向 B 站发起 1 次请求！
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const fullCookie = process.env.BI_COOKIE;
    const TARGET_UID = "3546779356235807";

    if (!fullCookie) {
      throw new Error("环境变量 BI_COOKIE 未配置");
    }

    // 2. 准备 API URL
    // 接口 A: 动态历史
    const dynamicUrl = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${TARGET_UID}&offset_dynamic_id=0&need_top=1&platform=web`;
    
    // 接口 B: 用户名片 (包含粉丝数、关注数、直播状态) - 这是一个聚合接口，性价比极高
    const cardUrl = `https://api.bilibili.com/x/web-interface/card?mid=${TARGET_UID}&photo=true`;

    // 公用 Headers
    const commonHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": `https://space.bilibili.com/${TARGET_UID}`,
      "Cookie": fullCookie
    };

    // 3. 并发发起请求 (Promise.all 节省时间)
    const [dynamicRes, cardRes] = await Promise.all([
      fetch(dynamicUrl, { headers: commonHeaders }),
      fetch(cardUrl, { headers: commonHeaders })
    ]);

    // 4. 处理响应
    if (!dynamicRes.ok || !cardRes.ok) {
      throw new Error(`B站服务器连接失败: 动态(${dynamicRes.status}) / 用户卡片(${cardRes.status})`);
    }

    const dynamicData = await dynamicRes.json();
    const cardData = await cardRes.json();

    // 检查业务错误码
    if (dynamicData.code !== 0) throw new Error(`动态API错误: ${dynamicData.message}`);
    if (cardData.code !== 0) throw new Error(`用户卡片API错误: ${cardData.message}`);

    // 5. 解析动态数据 (保持你原有的逻辑)
    const cards = dynamicData.data?.cards || [];
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
          console.error("解析单条动态失败", e);
        }
      }
    }

    // 6. 解析用户信息 (直播 + 粉丝)
    const cardInfo = cardData.data?.card || {};
    const liveInfo = dynamicData.data?.card?.live_room || cardData.data?.card?.live_room; 
    // 注意：card接口里的 live_room 有时比 dynamic 里的准，优先用 card 里的

    const userInfo = {
      name: cardInfo.name,
      face: cardInfo.face,
      fans: cardInfo.fans, // 粉丝数
      attention: cardInfo.attention, // 关注数
      is_live: Boolean(cardData.data?.live_room?.liveStatus === 1), // 1 为正在直播
      live_title: cardData.data?.live_room?.title || "",
      live_url: cardData.data?.live_room?.url ? `https://live.bilibili.com/${cardData.data.live_room.roomid}` : "",
      live_cover: cardData.data?.live_room?.cover || ""
    };

    // 7. 返回合并后的数据
    res.status(200).json({
      success: true,
      uid: TARGET_UID,
      user: userInfo,
      video_count: videos.length,
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
