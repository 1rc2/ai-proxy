// Vercel Function：代理 DeepSeek API，隐藏 API key
// 部署后在 Vercel 后台 Settings → Environment Variables 设置 DEEPSEEK_API_KEY
//
// 环境变量：
//   DEEPSEEK_API_KEY  必填，DeepSeek 的 sk-xxx key
//   ALLOWED_ORIGIN    可选，允许的前端域名，默认 * （生产建议改为你自己的域名）
//   DAILY_LIMIT       可选，每个 IP 每天最多调用次数，默认 50，设 0 为不限制

export const runtime = "nodejs";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
});

/* 简易每日限流：按 IP + 日期计数，UTC 次日自动重置 */
const counter = new Map(); // key: "ip:YYYY-MM-DD" -> count

function todayKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

function getClientIp(req) {
  // Vercel 会把真实 IP 放在 x-forwarded-for
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export default async function handler(req) {
  const allow = process.env.ALLOWED_ORIGIN || "*";

  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allow) });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "仅支持 POST" }),
      { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders(allow) } }
    );
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "服务器未配置 DEEPSEEK_API_KEY 环境变量" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(allow) } }
    );
  }

  // 每日访问限制
  const dailyLimit = parseInt(process.env.DAILY_LIMIT, 10);
  if (isNaN(dailyLimit) || dailyLimit <= 0) {
    // 不限制
  } else {
    const ip = getClientIp(req);
    const key = ip + ":" + todayKey();
    const used = counter.get(key) || 0;
    if (used >= dailyLimit) {
      return new Response(
        JSON.stringify({ error: "今日AI使用次数已达上限（" + dailyLimit + "次），请明天再试。" }),
        { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders(allow) } }
      );
    }
    counter.set(key, used + 1);
  }

  let body;
  try { body = await req.json(); }
  catch (e) {
    return new Response(
      JSON.stringify({ error: "请求体不是合法 JSON" }),
      { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(allow) } }
    );
  }

  // 仅透传 messages，model/max_tokens 在这里强制，前端无法越权
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
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(allow) }
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "上游请求失败: " + (e.message || String(e)) }),
      { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(allow) } }
    );
  }
}
