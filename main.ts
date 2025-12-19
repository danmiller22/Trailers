// main.ts (Deno Deploy / любой HTTPS-хост)
// Webhook endpoint: POST /
// Пишешь "H03036" -> бот отвечает 1 фото (satellite) + ссылка на точку.

type TgUpdate = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
};

type SkybitzJson = {
  skybitz?: {
    error?: number;
    gls?: any; // может быть объект или массив
  };
};

// анти-спам к SkyBitz (в памяти процесса)
const cache = new Map<string, { ts: number; lat: number; lon: number; time?: string }>();
const CACHE_TTL_MS = 60_000; // 60 сек на один трейлер

Deno.serve(async (req) => {
  // чтобы хостинг/проверки не падали
  if (req.method === "GET") return new Response("OK", { status: 200 });
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  // читаем env НЕ на старте, а здесь
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

  const assetId = sanitizeAssetId(text);
  if (!assetId) {
    await tgSendMessage(env, chatId, "Нужен номер трейлера (например: H03036).");
    return new Response("OK", { status: 200 });
  }

  try {
    const pos = await getLatestPosition(env, assetId);
    if (!pos) {
      await tgSendMessage(env, chatId, `Не нашёл позицию для ${assetId}.`);
      return new Response("OK", { status: 200 });
    }

    const { lat, lon } = pos;

    const mapsLink = googleMapsSatelliteLink(lat, lon);
    const imgUrl = esriWorldImageryStatic(lat, lon, 18, 900, 600);

    // 1 ответ: фото + подпись-ссылка
    await tgSendPhoto(env, chatId, imgUrl, `${assetId}\n${mapsLink}`);
  } catch (e) {
    await tgSendMessage(env, chatId, `Ошибка: ${String((e as any)?.message ?? e)}`);
  }

  return new Response("OK", { status: 200 });
});

// ---------- ENV ----------

function getEnv() {
  // если переменных нет — НЕ роняем деплой; просто будем отвечать ошибкой в чате
  const TG_BOT_TOKEN = Deno.env.get("TG_BOT_TOKEN") ?? "";
  const SKYBITZ_BASE_URL = Deno.env.get("SKYBITZ_BASE_URL") ?? "";
  const SKYBITZ_USER = Deno.env.get("SKYBITZ_USER") ?? "";
  const SKYBITZ_PASS = Deno.env.get("SKYBITZ_PASS") ?? "";
  const SKYBITZ_VERSION = Deno.env.get("SKYBITZ_VERSION") ?? "2.76";

  return { TG_BOT_TOKEN, SKYBITZ_BASE_URL, SKYBITZ_USER, SKYBITZ_PASS, SKYBITZ_VERSION };
}

function ensureEnv(env: ReturnType<typeof getEnv>) {
  const missing: string[] = [];
  if (!env.TG_BOT_TOKEN) missing.push("TG_BOT_TOKEN");
  if (!env.SKYBITZ_BASE_URL) missing.push("SKYBITZ_BASE_URL");
  if (!env.SKYBITZ_USER) missing.push("SKYBITZ_USER");
  if (!env.SKYBITZ_PASS) missing.push("SKYBITZ_PASS");
  // SKYBITZ_VERSION опционально

  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }
}

// -------- SkyBitz ----------

async function getLatestPosition(env: ReturnType<typeof getEnv>, assetId: string) {
  ensureEnv(env);

  const now = Date.now();
  const cached = cache.get(assetId);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached;

  // most recent position: from/to не передаем
  // JSON: getJson=1
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
  if (err && err !== 0) throw new Error(`SkyBitz error ${err}`);

  const gls = data?.skybitz?.gls;
  const rec = Array.isArray(gls) ? gls[0] : gls;

  const lat = rec?.latitude;
  const lon = rec?.longitude;
  const time = rec?.time;

  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const out = { ts: now, lat, lon, time };
  cache.set(assetId, out);
  return out;
}

// -------- Telegram ----------

async function tgSendMessage(env: ReturnType<typeof getEnv>, chatId: number, text: string) {
  if (!env.TG_BOT_TOKEN) throw new Error("Missing env: TG_BOT_TOKEN");

  const url = new URL(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage HTTP ${res.status}`);
}

async function tgSendPhoto(
  env: ReturnType<typeof getEnv>,
  chatId: number,
  photoUrl: string,
  caption?: string,
) {
  if (!env.TG_BOT_TOKEN) throw new Error("Missing env: TG_BOT_TOKEN");

  const url = new URL(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`);
  const payload: Record<string, unknown> = { chat_id: chatId, photo: photoUrl };
  if (caption) payload.caption = caption;

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Telegram sendPhoto HTTP ${res.status}`);
}

// -------- Maps helpers ----------

function googleMapsSatelliteLink(lat: number, lon: number) {
  // t=k — satellite
  return `https://www.google.com/maps?q=${lat},${lon}&z=18&t=k`;
}

function esriWorldImageryStatic(lat: number, lon: number, zoom: number, w: number, h: number) {
  // Esri World Imagery export (Web Mercator)
  const [x, y] = lonLatToWebMercator(lon, lat);

  const R = 6378137;
  const worldMeters = 2 * Math.PI * R;
  const res = worldMeters / (256 * 2 ** zoom); // meters per pixel

  const halfW = (w * res) / 2;
  const halfH = (h * res) / 2;

  const bbox = [x - halfW, y - halfH, x + halfW, y + halfH].join(",");

  const u = new URL(
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export",
  );
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

// -------- Utils ----------

function sanitizeAssetId(s: string) {
  const t = s.trim();
  if (t.length < 2 || t.length > 32) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t)) return null;
  return t;
}
