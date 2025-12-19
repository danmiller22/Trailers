# SkyBitz Telegram Bot (Deno)

Пишешь в Telegram номер трейлера (assetid), например `H03036`.
Бот отвечает **1 фото (satellite)** с подписью-ссылкой на точку.

## Файлы
- `main.ts` — webhook сервер (POST /)
- `deno.json` — tasks
- `.env.example` — список переменных окружения

## Локальный запуск
1) Создай бота у @BotFather и возьми `TG_BOT_TOKEN`
2) Заполни env (см `.env.example`)
3) Запуск:
```bash
deno task dev
```

## Деплой
Хостинг должен давать публичный HTTPS URL.
После деплоя поставь webhook:
```bash
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<YOUR_HTTPS_URL>/
```

## Примечания
- В `SKYBITZ_BASE_URL` укажи порт, если он нужен: `https://xml.skybitz.com:NNNN`
- Есть кэш на 60 секунд, чтобы не долбить SkyBitz слишком часто.
