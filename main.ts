// main.ts (Deno Deploy)
// Webhook: POST /
// Сообщение "H03036" => 1 фото (satellite) + ссылка на точку.
// Если SkyBitz выдаёт error 97 — бот отдаёт последнюю сохранённую точку из Deno KV.

type TgUpdate = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
};

type SkybitzJson = {
  skybitz?: {
    error?: number;
    gls?: any; // объект или массив
  };
};

type Env = {
  TG_BOT_TOKEN: string;
  SKYBITZ_BASE_URL: string;
  SKYBITZ_USER: string;
  SKYBITZ_PASS: string;
  SKYBITZ_VERSION: string;
};

type Pos = { ts: number; lat: number; lon: number; time?: string };

const kv = await Deno.openKv();

// Не дёргать SkyBitz чаще этого (на один трейлер)
const SKYBITZ_MIN_INTERVAL_MS = 10 * 60_000; // 10 минут
// Если SkyBitz недоступен/97 — можно отдавать очень старую последнюю точку
const MAX_STALE_MS = 30 * 24 * 60 * 60_000; // 30 дней

Deno.serve(async (req) => {
  if (req.method === "GET") return new Response("OK", { status: 200 });
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  const env = getEnv();

  let upd: TgUpdate;
  try {
    upd = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const chatId = upd.message?.chat?.id;
  const text = (upd.message?.text ?? "").trim();
  if (!chatId || !text) return new Response("OK", { status: 200 });

  // команды игнорим
  if (text.startsWith("/")) return new Response("OK", { status: 200 });

  // принимаем только номер трейлера
  const assetId = sanitizeAssetId(text);
  if (!assetId) return new Response("OK", { status: 200 });

  try {
    // 1) Сначала смотрим KV: если свежо — отдаём сразу, SkyBitz не трогаем
    const cached = await kvGetPos(assetId);
    const now = Date.now();
    if (cached && now - cached.ts < SKYBITZ_MIN_INTERVAL_MS) {
      await sendPos(env, chatId, assetId, cached);
      return new Response("OK", { status: 200 });
    }

    // 2) Пробуем SkyBitz (если env не задан — сообщим)
    ensureEnv(env);

    const fresh = await fetchLatestFromSkybitz(env, assetId);
    if (fresh) {
      await kvSetPos(assetId, fresh);
      await sendPos(env, chatId, assetId, fresh);
      return new Response("OK", { status: 200 });
    }

    // 3) Если SkyBitz вернул пусто — попробуем старый KV
    if (cached && now - cached.ts < MAX_STALE_MS) {
      await sendPos(env, chatId, assetId, cached);
      return new Response("OK", { status: 200 });
    }

    await tgSendMessage(env, chatId, "Нет данных по этому трейлеру.");
    return new Response("OK", { status: 200 });
  } catch (e) {
    const msg = String((e as any)?.message ?? e);

    // SkyBitz error 97: отдаём KV если есть
    if (msg.includes("SkyBitz error 97")) {
      const cached = await kvGetPos(assetId);
      if (cached && Date.now() - cached.ts < MAX_STALE_MS) {
        await sendPos(env, chatId, assetId, cached);
        return new Response("OK", { status: 200 });
      }
      await tgSendMessage(env, chatId, "SkyBitz ограничил частоту. Попробуй позже.");
      return new Response("OK", { status: 200 });
    }

    // Любая другая ошибка: тоже пытаемся отдать KV
    const cached = await kvGetPos(assetId);
    if (cached && Date.now() - cached.ts < MAX_STALE_MS) {
      await sendPos(env, chatId, assetId, cached);
      return new Response("OK", { status: 200 });
    }

    await tgSendMessage(env, chatId, `Ошибка: ${msg}`);
    return new Response("OK", { status: 200 });
  }
});

// ---------- KV helpers ----------

function posKey(assetId: string) {
  return ["pos", assetId] as const;
}

async function kvGetPos(assetId: string): Promise<Pos | null> {
  const r = await kv.get<Pos>(posKey(assetId));
  return r.value ?? null;
}

async function kvSetPos(assetId: string, pos: Pos) {
  await kv.set(posKey(assetId), pos);
}

// ---------- SkyBitz ----------

async function fetchLatestFromSkybitz(env: Env, assetId: string): Promise<Pos | null> {
  // most recent position: from/to не передаем
  // JSON: getJson=1
  const url = new URL("/QueryPositions", env.SKYBITZ_BASE_URL);
  url.searchParams.set("assetid", assetId);
  url.searchParams.set("customer", env.SKYBITZ_USER);
  url.searchParams.set("password", env.SKYBITZ_PASS);
  url.searchParams.set("version", env.SKYBITZ_VERSION);
  url.searchParams.set("getJson", "1");

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`SkyBitz HTTP ${res.status}`);

  const data = (await res.json()) as SkybitzJson;
  const err = data?.skybitz?.error ?? 0;
  if (err && err !== 0) throw new Error(`SkyBitz error ${err}`);

  const gls = data?.skybitz?.gls;
  const rec = Array.isArray(gls) ? gls[0] : gls;

  const lat = rec?.latitude;
  const lon = rec?.longitude;
  const time = rec?.time;

  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return { ts: Date.now(), lat, lon, time };
}

// ---------- Telegram output ----------

async function sendPos(env: Env, chatId: number, assetId: string, pos: Pos) {
  const mapsLink = googleMapsSatelliteLink(pos.lat, pos.lon);
  const imgUrl = esriWorldImageryStatic(pos.lat, pos.lon, 18, 900, 600);
  await tgSendPhoto(env, chatId, imgUrl, `${assetId}\n${mapsLink}`);
}

async function tgSendMessage(env: Env, chatId: number, text: string) {
  if (!env.TG_BOT_TOKEN) return;
  const url = new URL(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!r.ok) console.error("Telegram sendMessage failed", r.status, await safeText(r));
}

async function tgSendPhoto(env: Env, chatId: number, photoUrl: string, caption?: string) {
  if (!env.TG_BOT_TOKEN) return;
  const url = new URL(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`);
  const payload: Record<string, unknown> = { chat_id: chatId, photo: photoUrl };
  if (caption) payload.caption = caption;

  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("Telegram sendPhoto failed", r.status, await safeText(r));
}

async function safeText(r: Response) {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

// ---------- Maps ----------

function googleMapsSatelliteLink(lat: number, lon: number) {
  return `https://www.google.com/maps?q=${lat},${lon}&z=18&t=k`;
}

function esriWorldImageryStatic(lat: number, lon: number, zoom: number, w: number, h: number) {
  const [x, y] = lonLatToWebMercator(lon, lat);

  const R = 6378137;
  const worldMeters = 2 * Math.PI * R;
  const res = worldMeters / (256 * 2 ** zoom);

  const halfW = (w * res) / 2;
  const halfH = (h * res) / 2;

  const bbox = [x - halfW, y - halfH, x + halfW, y + halfH].join(",");

  const u = new URL("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export");
  u.searchParams.set("bbox", bbox);
  u.searchParams.set("bboxSR", "3857");
  u.searchParams.set("imageSR", "3857");
  u.searchParams.set("size", `${w},${h}`);
  u.searchParams.set("format", "png");
  u.searchParams.set("f", "image");
  return u.toString();
}

function lonLatToWebMercator(lon: number, lat: number): [number, number] {
  const R = 6378137;
  const x = (lon * Math.PI / 180) * R;
  const clampedLat = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const y = Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI / 180) / 2)) * R;
  return [x, y];
}

// ---------- Env + utils ----------

function getEnv(): Env {
  return {
    TG_BOT_TOKEN: Deno.env.get("TG_BOT_TOKEN") ?? "",
    SKYBITZ_BASE_URL: Deno.env.get("SKYBITZ_BASE_URL") ?? "",
    SKYBITZ_USER: Deno.env.get("SKYBITZ_USER") ?? "",
    SKYBITZ_PASS: Deno.env.get("SKYBITZ_PASS") ?? "",
    SKYBITZ_VERSION: Deno.env.get("SKYBITZ_VERSION") ?? "2.76",
  };
}

function ensureEnv(env: Env) {
  const miss: string[] = [];
  if (!env.TG_BOT_TOKEN) miss.push("TG_BOT_TOKEN");
  if (!env.SKYBITZ_BASE_URL) miss.push("SKYBITZ_BASE_URL");
  if (!env.SKYBITZ_USER) miss.push("SKYBITZ_USER");
  if (!env.SKYBITZ_PASS) miss.push("SKYBITZ_PASS");
  if (miss.length) throw new Error(`Missing env: ${miss.join(", ")}`);
}

function sanitizeAssetId(s: string) {
  const t = s.trim();
  if (t.length < 2 || t.length > 32) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t)) return null;
  return t;
}
