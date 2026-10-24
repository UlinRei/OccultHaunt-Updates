// 暗夜集會牌組短碼 Worker。
// 只保存「短碼 -> OHD1 代碼」的暫時索引，不解析牌組內容，真正驗證在遊戲端。
// 不保存 IP、玩家名稱或裝置 ID。API 契約見主專案 occult-haunt 的 documents/短碼API契約.md。

const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_CODE_LENGTH = 4096;
const MAX_BODY_BYTES = 8192;
const DEFAULT_DAILY_LIMIT = 300;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const OHD1_PATTERN = /^OHD1\.[A-Za-z0-9_-]+\.[0-9A-Fa-f]{4}$/;
const SHORT_CODE_PATTERN = /^OH-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...JSON_HEADERS,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/share" && request.method === "POST") {
      return handleCreate(request, env);
    }

    const match = url.pathname.match(/^\/share\/([^/]+)$/);
    if (match && request.method === "GET") {
      return handleFetch(decodeURIComponent(match[1]), env);
    }

    return errorResponse(404, "not_found", "路由不存在");
  },
};

async function handleCreate(request, env) {
  const limiter = env.SHARE_LIMITER;
  if (limiter) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    // 頻率限制鍵只用 IP 雜湊，且由 Cloudflare 速率限制服務保管，不寫入 KV。
    const { success } = await limiter.limit({ key: await sha256Hex(ip) });
    if (!success) {
      return errorResponse(429, "rate_limited", "建立太頻繁，請稍後再試");
    }
  }

  const lengthHeader = Number(request.headers.get("content-length") ?? "0");
  if (lengthHeader > MAX_BODY_BYTES) {
    return errorResponse(413, "too_large", "內容過大");
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return errorResponse(413, "too_large", "內容過大");
    }
    body = JSON.parse(text);
  } catch {
    return errorResponse(400, "bad_request", "請求不是有效的 JSON");
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return errorResponse(413, "too_large", "代碼長度超出上限");
  }
  if (!OHD1_PATTERN.test(code)) {
    return errorResponse(400, "invalid_code", "不是有效的 OHD1 代碼");
  }

  const now = Date.now();
  const hashKey = `h:${await sha256Hex(code)}`;

  // 同內容去重：有效期內回傳同一短碼，不消耗額外寫入額度。
  const existingShort = await env.SHARE_KV.get(hashKey);
  if (existingShort) {
    const record = await env.SHARE_KV.get(`c:${existingShort}`, "json");
    if (record && record.expiresAt > now) {
      return jsonResponse(200, {
        shortCode: existingShort,
        expiresAt: record.expiresAt,
        reused: true,
      });
    }
  }

  const dailyLimit = Number(env.DAILY_CREATE_LIMIT ?? DEFAULT_DAILY_LIMIT);
  const dayKey = `d:${new Date(now).toISOString().slice(0, 10)}`;
  const used = Number((await env.SHARE_KV.get(dayKey)) ?? "0");
  if (used >= dailyLimit) {
    return errorResponse(503, "daily_limit", "今日短代碼建立量已達上限，請改用完整代碼");
  }

  const shortCode = await pickUnusedShortCode(env);
  if (!shortCode) {
    return errorResponse(503, "unavailable", "暫時無法建立短代碼");
  }

  const expiresAt = now + TTL_SECONDS * 1000;
  try {
    await env.SHARE_KV.put(
      `c:${shortCode}`,
      JSON.stringify({ code, createdAt: now, expiresAt }),
      { expirationTtl: TTL_SECONDS },
    );
    await env.SHARE_KV.put(hashKey, shortCode, { expirationTtl: TTL_SECONDS });
    // 計數鍵只需保留到當日結束後，兩天足夠。
    await env.SHARE_KV.put(dayKey, String(used + 1), { expirationTtl: 2 * 24 * 60 * 60 });
  } catch {
    // 免費額度用盡等寫入失敗一律回報不可用，遊戲端會退回完整代碼。
    return errorResponse(503, "unavailable", "暫時無法建立短代碼");
  }

  return jsonResponse(201, { shortCode, expiresAt, reused: false });
}

async function handleFetch(rawCode, env) {
  const shortCode = normalizeShortCode(rawCode);
  if (!shortCode) {
    return errorResponse(400, "invalid_short_code", "短代碼格式不正確");
  }

  let record;
  try {
    record = await env.SHARE_KV.get(`c:${shortCode}`, "json");
  } catch {
    return errorResponse(503, "unavailable", "暫時無法取回短代碼");
  }

  if (!record || record.expiresAt <= Date.now()) {
    return errorResponse(404, "expired", "分享代碼已過期");
  }

  return jsonResponse(200, {
    shortCode,
    code: record.code,
    expiresAt: record.expiresAt,
  });
}

async function pickUnusedShortCode(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateShortCode();
    if ((await env.SHARE_KV.get(`c:${candidate}`)) === null) {
      return candidate;
    }
  }
  return null;
}

// 10 個 Crockford Base32 字元，共 50 位元隨機。
export function generateShortCode() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let chars = "";
  for (const byte of bytes) {
    chars += CROCKFORD[byte & 31];
  }
  return `OH-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 10)}`;
}

// 容忍小寫、缺少連字號與 Crockford 易混字元（I、L 視為 1，O 視為 0）。
export function normalizeShortCode(input) {
  let text = String(input).toUpperCase().replace(/[\s-]/g, "");
  if (text.startsWith("OH")) {
    text = text.slice(2);
  }
  text = text.replace(/[IL]/g, "1").replace(/O/g, "0");
  if (text.length !== 10) {
    return null;
  }
  const formatted = `OH-${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8, 10)}`;
  return SHORT_CODE_PATTERN.test(formatted) ? formatted : null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function errorResponse(status, error, message) {
  return jsonResponse(status, { error, message });
}
