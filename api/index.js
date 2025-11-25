// 文件名: api/index.js
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

  // ==========================================
  // 配置区域
  // ==========================================
  const TARGET_UID = "3546779356235807"; 

  // 获取环境变量 (Vercel 写法是 process.env)
  const fullCookie = process.env.BI_COOKIE;

  if (!fullCookie) {
    return res.status(500).json({ error: "请在 Vercel 后台配置 Environment Variable: BI_COOKIE" });
  }

  // 使用 API 接口
  const apiUrl = `https://api.bilibili.com/x/space/wbi/arc/search?mid=${TARGET_UID}&ps=30&tid=0&pn=1&keyword=&order=pubdate&platform=web`;

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": `https://space.bilibili.com/${TARGET_UID}/`,
        "Origin": "https://space.bilibili.com",
        "Cookie": fullCookie, // 关键：带上凭证
        "Accept": "application/json, text/plain, */*",
        "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty"
      }
    });

    if (response.status === 412) {
      throw new Error("Vercel IP 也被拦截 (412) - 请检查 Cookie 是否有效");
    }

    if (!response.ok) {
      throw new Error(`Upstream Error: ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`B站错误: ${data.message} (code: ${data.code})`);
    }

    const vlist = data.data?.list?.vlist || [];

    const result = {
      success: true,
      uid: TARGET_UID,
      platform: "Vercel", // 标记这是 Vercel 返回的
      author: vlist[0]?.author || "Unknown",
      videos: vlist.map(v => ({
        title: v.title,
        desc: v.description,
        pic: v.pic,
        bvid: v.bvid,
        url: `https://www.bilibili.com/video/${v.bvid}`,
        created: v.created,
        length: v.length,
        play: v.play,
        comment: v.comment,
        date: new Date(v.created * 1000).toLocaleDateString('zh-CN')
      }))
    };

    // Vercel 返回 JSON
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
