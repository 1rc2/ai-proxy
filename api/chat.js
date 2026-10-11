// Vercel Serverless Function (Node.js)：代理 DeepSeek API，隐藏 API key
// 部署后在 Vercel 后台 Settings → Environment Variables 设置：
//   DEEPSEEK_API_KEY  必填，DeepSeek 的 sk-xxx key
//   ALLOWED_ORIGIN    可选，允许的前端域名，默认 * （生产建议改为你自己的域名）
//   DAILY_LIMIT       可选，每个 IP 每天最多调用次数，默认 50，设 0 为不限制

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

/* 简易每日限流：按 IP + 日期计数，UTC 次日自动重置 */
const counter = new Map(); // key: "ip:YYYY-MM-DD" -> count

function todayKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
}

function sendJson(res, status, obj, origin) {
  res.status(status).setHeader("Content-Type", "application/json");
  const h = corsHeaders(origin);
  for (const k of Object.keys(h)) res.setHeader(k, h[k]);
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const allow = process.env.ALLOWED_ORIGIN || "*";
  const origin = req.headers.origin;

  // CORS 预检
  if (req.method === "OPTIONS") {
    const h = corsHeaders(allow);
    for (const k of Object.keys(h)) res.setHeader(k, h[k]);
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "仅支持 POST" }, origin);
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: "服务器未配置 DEEPSEEK_API_KEY 环境变量" }, origin);
    return;
  }

  // 每日访问限制
  const dailyLimit = parseInt(process.env.DAILY_LIMIT, 10);
  if (!isNaN(dailyLimit) && dailyLimit > 0) {
    const ip = getClientIp(req);
    const key = ip + ":" + todayKey();
    const used = counter.get(key) || 0;
    if (used >= dailyLimit) {
      sendJson(res, 429, { error: "今日AI使用次数已达上限（" + dailyLimit + "次），请明天再试。" }, origin);
      return;
    }
    counter.set(key, used + 1);
  }

  // 读取请求体
  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch (e) {
    sendJson(res, 400, { error: "请求体不是合法 JSON" }, origin);
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];

  try {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        max_tokens: 800,
        stream: false
      })
    });

    const text = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json");
    const h = corsHeaders(allow);
    for (const k of Object.keys(h)) res.setHeader(k, h[k]);
    res.end(text);
  } catch (e) {
    sendJson(res, 502, { error: "上游请求失败: " + (e.message || String(e)) }, origin);
  }
}
