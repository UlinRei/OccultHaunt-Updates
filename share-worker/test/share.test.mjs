// 以 Node 內建的 fetch 介面與假 KV 驗證 Worker 邏輯，不需要 Cloudflare 環境。
import assert from "node:assert/strict";
import worker, { generateShortCode, normalizeShortCode } from "../src/index.js";

class FakeKv {
  store = new Map();
  async get(key, type) {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.store.set(key, value);
  }
}

const env = { SHARE_KV: new FakeKv(), DAILY_CREATE_LIMIT: "2" };
const sample = "OHD1.abcDEF_-123.0A1F";

const post = (code) =>
  worker.fetch(
    new Request("https://x/share", { method: "POST", body: JSON.stringify({ code }) }),
    env,
  );

// 短碼格式與正規化
const generated = generateShortCode();
assert.match(generated, /^OH-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);
assert.equal(normalizeShortCode(generated.toLowerCase().replaceAll("-", "")), generated);
assert.equal(normalizeShortCode("OH-OOOO-IIII-LL"), "OH-0000-1111-11");
assert.equal(normalizeShortCode("OH-123"), null);

// 建立、去重、取回
const created = await post(sample);
assert.equal(created.status, 201);
const createdBody = await created.json();
const again = await post(sample);
assert.equal(again.status, 200);
assert.equal((await again.json()).shortCode, createdBody.shortCode);

const fetched = await worker.fetch(new Request(`https://x/share/${createdBody.shortCode}`), env);
assert.equal(fetched.status, 200);
assert.equal((await fetched.json()).code, sample);

// 驗證失敗
assert.equal((await post("not-a-code")).status, 400);
assert.equal((await post("OHD1." + "a".repeat(5000) + ".0A1F")).status, 413);

// 過期與不存在
const missing = await worker.fetch(new Request("https://x/share/OH-0000-0000-00"), env);
assert.equal(missing.status, 404);
assert.equal((await missing.json()).error, "expired");

// 每日上限（限制為 2，已建立 1 筆）
assert.equal((await post("OHD1.second_one.BEEF")).status, 201);
assert.equal((await post("OHD1.third_one.BEEF")).status, 503);

console.log("share worker tests passed");
