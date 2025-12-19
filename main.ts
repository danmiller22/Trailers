// main.ts (Deno Deploy)
// POST / — Telegram webhook
// Сообщение "H03036" => 1 фото (satellite) + ссылка на точку.

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

// КЭШ: чтобы не ловить SkyBitz error 97 (частые запросы)
const SOFT_TTL_MS = 10 * 60_000; // 10 минут — отдаём кэш без обращения к SkyBitz
const HARD_TTL_MS = 24 * 60 * 60_000; // 24 часа — “последняя известная точка” на крайний случай

const cache = new Map<string, { ts: number; lat: number; lon: number; time?: string }>();

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

  // 1) Команды (/start) — игнорируем полностью (ничего не отвечаем)
  if (text.startsWith("/")) return new Response("OK", { status: 200 });

  // 2) Принимаем только номер трейлера
  const assetId = sanitizeAssetId(text);
  if (!assetId) {
    // ТЫ ХОТЕЛ “без лишнего” — поэтому просто молчим, если формат не тот
    return new Response("OK", { status: 200 });
  }

  try {
    const pos = await getPositionWithCache(env, assetId);
    if (!pos) return new Response("OK", { status: 200 }); // молчим, если нет данных

    const { lat, lon } = pos;
    const mapsLink = googleMapsSatelliteLink(lat, lon);
    const imgUrl = esriWorldImageryStatic(lat, lon, 18, 900, 600);

    await tgSendPhoto(env, chatId, imgUrl, `${assetId}\n${mapsLink}`);
  } catch {
    // никаких “ошибок” пользователю — просто молчим
  }

  return new Response("OK", { status: 200 });
});

// ---------- ЛОГИКА С КЭШЕМ ----------

async function getPositionWithCache(env: Env, assetId: string) {
  // если недавно уже дергали — отдаём кэш
  const now = Date.now();
  const cached = cache.get(assetId);
  if (cached && now - cached.ts < SOFT_TTL_MS) return cached;

  // иначе пробуем SkyBitz
  try {
    const fresh = await fetchLatestFromSkybitz(env, assetId);
    if (fresh) {
      cache.set(assetId, fresh);
      return fresh;
    }
  } catch (e) {
    // SkyBitz error 97 — отдаём last known, если есть (даже старый)
    const c = cache.get(assetId);
    if (c && now - c.ts < HARD_TTL_MS) return c;
    // если кэша нет — просто молчим
    return null;
  }

  // если SkyBitz вернул пусто — пробуем старый кэш
  if (cached && now - cached.ts < HARD_TTL_MS) return cached;
  return null;
}

async function fetchLatestFromSkybitz(env: Env, assetId: string) {
  ensureEnv(env);

  const url = new URL("/QueryPositions", env.SKYBITZ_BASE_URL);
  url.searchParams.set("assetid", assetId);
  url.searchParams.set("customer", env.SKYBITZ_USER);
  url.searchParams.set("password", env.SKYBITZ_PASS);
  url.searchParams.set("version", env.SKYBITZ_VERSION);
  url.searchParams.set("getJson", "1");

  const res = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`SkyBitz HTTP ${res.status}`);

  const data = (await res.json()) as SkybitzJson;
  const err = data?.skybitz?.error ?? 0;

  // 97 = слишком часто/очередь — бросаем вверх, чтобы взять кэш
  if (err && err !== 0) throw new Error(`SkyBitz error ${err}`);

  const gls = data?.skybitz?.gls;
  const rec = Array.isArray(gls) ? gls[0] : gls;

  const lat = rec?.latitude;
  const lon = rec?.longitude;
  const time = rec?.time;

  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return { ts: Date.now(), lat, lon, time };
}

// ---------- ENV ----------

type Env = {
  TG_BOT_TOKEN: string;
  SKYBITZ_BASE_URL: string;
  SKYBITZ_USER: string;
  SKYBITZ_PASS: string;
  SKYBITZ_VERSION: string;
};

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
  if (!env.TG_BOT_TOKEN) throw new Error("Missing TG_BOT_TOKEN");
  if (!env.SKYBITZ_BASE_URL) throw new Error("Missing SKYBITZ_BASE_URL");
  if (!env.SKYBITZ_USER) throw new Error("Missing SKYBITZ_USER");
  if (!env.SKYBITZ_PASS) throw new Error("Missing SKYBITZ_PASS");
}

// ---------- Telegram ----------

async function tgSendPhoto(env: Env, chatId: number, photoUrl: string, caption?: string) {
  if (!env.TG_BOT_TOKEN) return;

  const url = new URL(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`);
  const payload: Record<string, unknown> = { chat_id: chatId, photo: photoUrl };
  if (caption) payload.caption = caption;

  await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------- Maps helpers ----------

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

// ---------- Utils ----------

function sanitizeAssetId(s: string) {
  const t = s.trim();
  if (t.length < 2 || t.length > 32) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t)) return null;
  return t;
}
