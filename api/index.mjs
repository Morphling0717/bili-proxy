export default async function handler(req, res) {
  // 1. 设置跨域头
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

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
    // 接口 A: 用户空间动态（新版 polymer 接口，注意是 host_mid，不是 host_uid）
    const features = "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard";
    const dynamicUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=&features=&web_location=333.1387`;

    // 接口 B: 用户名片
    const cardUrl = `https://api.bilibili.com/x/web-interface/card?mid=&photo=true`;

    // 接口 C: 直播状态专用接口
    const liveStatusUrl = `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=`;

    // 公用 Headers
    const commonHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": `https://space.bilibili.com//dynamic`,
      "Origin": "https://space.bilibili.com",
      "Cookie": fullCookie
    };

    // 3. 并发发起请求
    const [dynamicRes, cardRes, liveRes] = await Promise.all([
      fetch(dynamicUrl, { headers: commonHeaders }),
      fetch(cardUrl, { headers: commonHeaders }),
      fetch(liveStatusUrl, { headers: commonHeaders })
    ]);

    // 4. 处理响应
    if (!dynamicRes.ok) throw new Error(`动态接口 HTTP `);
    if (!cardRes.ok) throw new Error(`卡片接口 HTTP `);
    if (!liveRes.ok) throw new Error(`直播接口 HTTP `);

    const dynamicData = await dynamicRes.json();
    const cardData = await cardRes.json();
    const liveDataRaw = await liveRes.json();

    // 检查业务错误码
    if (dynamicData.code !== 0) throw new Error(`动态API错误:  `);
    if (cardData.code !== 0) throw new Error(`用户卡片API错误:  `);

    // 5. 解析动态数据（新结构：data.items，视频在 module_dynamic.major.archive）
    const items = dynamicData.data?.items || [];
    const videos = [];

    for (const item of items) {
      // 只取「投稿视频」类型
      if (item.type !== "DYNAMIC_TYPE_AV") continue;

      try {
        const moduleDynamic = item.modules?.module_dynamic;
        const archive = moduleDynamic?.major?.archive;
        if (!archive) continue;

        const author = item.modules?.module_author || {};
        const stat = item.modules?.module_stat || {};

        // 播放/弹幕等在 archive.stat 里是字符串（如 "6.5万"）
        // 评论数则在 module_stat.comment.count
        videos.push({
          title: archive.title,
          desc: archive.desc,
          pic: archive.cover,
          bvid: archive.bvid,
          aid: archive.aid,
          url: `https://www.bilibili.com/video//`,
          created: author.pub_ts,
          length: archive.duration_text,           // 现在是文本，如 "05:14"
          play: archive.stat?.play,                 // 字符串，可能是 "6.5万"
          danmaku: archive.stat?.danmaku,
          comment: stat.comment?.count,
          like: stat.like?.count,
          date: author.pub_ts
            ? new Date(author.pub_ts * 1000).toLocaleDateString('zh-CN')
            : ""
        });
      } catch (e) {
        console.error("解析单条动态失败", e);
      }
    }

    // 6. 解析用户信息
    const cardInfo = cardData.data?.card || {};
    const targetLiveInfo = liveDataRaw.data?.[TARGET_UID] || {};

    const userInfo = {
      name: cardInfo.name,
      face: cardInfo.face,
      fans: cardInfo.fans,
      attention: cardInfo.attention,
      is_live: targetLiveInfo.live_status === 1,
      live_title: targetLiveInfo.title || "",
      live_url: targetLiveInfo.room_id ? `https://live.bilibili.com/` : "",
      live_cover: targetLiveInfo.cover_from_user || targetLiveInfo.keyframe || ""
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
