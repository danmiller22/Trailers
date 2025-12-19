// main.ts (Deno)
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

const TG_BOT_TOKEN = mustEnv("TG_BOT_TOKEN");
const SKYBITZ_BASE_URL = mustEnv("SKYBITZ_BASE_URL"); // пример: https://xml.skybitz.com:NNNN  (если порт нужен)
const SKYBITZ_USER = mustEnv("SKYBITZ_USER");
const SKYBITZ_PASS = mustEnv("SKYBITZ_PASS");
const SKYBITZ_VERSION = Deno.env.get("SKYBITZ_VERSION") ?? "2.76";

// анти-спам к SkyBitz (в памяти процесса)
const cache = new Map<string, { ts: number; lat: number; lon: number; time?: string }>();
const CACHE_TTL_MS = 60_000; // 60 сек на один трейлер

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });

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
    await tgSendMessage(chatId, "Нужен номер трейлера (например: H03036).");
    return new Response("OK", { status: 200 });
  }

  try {
    const pos = await getLatestPosition(assetId);
    if (!pos) {
      await tgSendMessage(chatId, `Не нашёл позицию для ${assetId}.`);
      return new Response("OK", { status: 200 });
    }

    const { lat, lon } = pos;

    const mapsLink = googleMapsSatelliteLink(lat, lon);
    const imgUrl = esriWorldImageryStatic(lat, lon, 18, 900, 600);

    await tgSendPhoto(chatId, imgUrl, `${assetId}\n${mapsLink}`);
  } catch (e) {
    await tgSendMessage(chatId, `Ошибка: ${String((e as any)?.message ?? e)}`);
  }

  return new Response("OK", { status: 200 });
});

// -------- SkyBitz ----------

async function getLatestPosition(assetId: string) {
  const now = Date.now();
  const cached = cache.get(assetId);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached;

  // most recent position: omitting from/to
  // JSON: getJson=1
  const url = new URL("/QueryPositions", SKYBITZ_BASE_URL);
  url.searchParams.set("assetid", assetId);
  url.searchParams.set("customer", SKYBITZ_USER);
  url.searchParams.set("password", SKYBITZ_PASS);
  url.searchParams.set("version", SKYBITZ_VERSION);
  url.searchParams.set("getJson", "1");

  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
  });

  if (!res.ok) throw new Error(`SkyBitz HTTP ${res.status}`);

  const data = (await res.json()) as SkybitzJson;

  const err = data?.skybitz?.error ?? 0;
  if (err && err !== 0) {
    throw new Error(`SkyBitz error ${err}`);
  }

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

async function tgSendMessage(chatId: number, text: string) {
  const url = new URL(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage HTTP ${res.status}`);
}

async function tgSendPhoto(chatId: number, photoUrl: string, caption?: string) {
  const url = new URL(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`);
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

// -------- Utils ----------

function sanitizeAssetId(s: string) {
  // разрешаем буквы/цифры + '_' '-' после первого символа
  const t = s.trim();
  if (t.length < 2 || t.length > 32) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t)) return null;
  return t;
}

function mustEnv(key: string) {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}
