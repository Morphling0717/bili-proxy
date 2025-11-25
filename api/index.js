export default async function handler(req, res) {
  // 1. 设置跨域头，允许你的网站访问
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // ==========================================
  // 配置区域
  // ==========================================
  const TARGET_UID = "3546779356235807"; 

  // 获取环境变量
  const fullCookie = process.env.BI_COOKIE;

  if (!fullCookie) {
    return res.status(500).json({ error: "Environment Variable BI_COOKIE is missing" });
  }

  // ==========================================
  // 核心逻辑：切换到动态接口 (无需 Wbi 签名)
  // ==========================================
  // host_uid: 目标用户ID
  // offset_dynamic_id: 0 代表第一页
  const apiUrl = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${TARGET_UID}&offset_dynamic_id=0&need_top=1&platform=web`;

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        // 必须伪装 Referer 为动态页面
        "Referer": `https://space.bilibili.com/${TARGET_UID}/dynamic`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": fullCookie // 必须带 Cookie
      }
    });

    if (!response.ok) {
      throw new Error(`Upstream Network Error: ${response.status}`);
    }

    const data = await response.json();

    // 检查 B 站业务逻辑
    if (data.code !== 0) {
      throw new Error(`Bilibili API Error: ${data.message} (code: ${data.code}) - Cookie 可能已失效或没有访问权限`);
    }

    // 解析动态列表
    // 动态接口返回的数据很杂（包含转发、文字、图片），我们需要筛选出“投稿视频”
    const cards = data.data?.cards || [];
    const videos = [];

    for (const item of cards) {
      // type = 8 代表“投稿视频”
      if (item.desc?.type === 8) {
        try {
          // 视频详情被压缩在一个 JSON 字符串里，需要二次解析
          const cardDetail = JSON.parse(item.card);
          
          videos.push({
            title: cardDetail.title,
            desc: cardDetail.desc,
            pic: cardDetail.pic, // 封面
            bvid: item.desc.bvid || cardDetail.bvid, // 视频ID
            url: `https://www.bilibili.com/video/${item.desc.bvid || cardDetail.bvid}`,
            created: item.desc.timestamp, // 发布时间戳
            // 动态接口里的时长通常是秒数，也可能没有，做个容错
            length: cardDetail.duration, 
            play: cardDetail.stat?.view, // 播放量
            comment: cardDetail.stat?.reply, // 评论数
            date: new Date(item.desc.timestamp * 1000).toLocaleDateString('zh-CN')
          });
        } catch (e) {
          console.error("Parse error for one card", e);
        }
      }
    }

    const result = {
      success: true,
      uid: TARGET_UID,
      source
