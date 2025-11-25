// 兼容版代码 (CommonJS 格式)
module.exports = async (req, res) => {
  // 1. 设置跨域头
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // 处理预检
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 2. 检查环境变量
  const TARGET_UID = "3546779356235807";
  const fullCookie = process.env.BI_COOKIE;

  if (!fullCookie) {
    return res.status(500).json({ error: "严重错误: Vercel 环境变量 BI_COOKIE 未配置或读取失败" });
  }

  const apiUrl = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${TARGET_UID}&offset_dynamic_id=0&need_top=1&platform=web`;

  try {
    // 3. 发起请求
    // 注意：fetch 在 Node 18+ 原生支持。如果报错 fetch is not defined，请看下面的第二步设置。
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Referer": `https://space.bilibili.com/${TARGET_UID}/dynamic`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": fullCookie
      }
    });

    if (!response.ok) {
      throw new Error(`Upstream Error: ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`B站接口报错: ${data.message} (code: ${data.code})`);
    }

    // 4. 解析数据
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
          console.error("解析单条动态失败", e);
        }
      }
    }
