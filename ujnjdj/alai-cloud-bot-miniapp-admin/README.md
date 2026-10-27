# Alai Cloud — Telegram Mini App + бот

Загрузите содержимое этой папки в корень GitHub-репозитория и создайте на Render сервис **Web Service**.

## Render

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/healthz`
- Runtime: Node

Добавьте переменные:

```text
TELEGRAM_BOT_TOKEN=токен_от_BotFather
MINI_APP_URL=https://ваш-сервис.onrender.com
ADMIN_CHAT_ID=ваш_числовой_chat_id
MANAGER_CONTACT_URL=https://t.me/alairustam
DATA_DIR=data
```

После первого запуска:

1. Откройте бота и отправьте `/id`.
2. Вставьте полученный номер в `ADMIN_CHAT_ID` на Render.
3. Перезапустите сервис и отправьте `/admin`.

Админка находится прямо в Telegram: статистика, пользователи, заказы, CSV и рассылка сообщений. Пользователь открывает Mini App кнопкой «Открыть каталог», выбирает товар и получает готовый текст заказа в чате `@alairustam`.

Стикер для приветствия подключается через `/stickerid`: отправьте боту стикер, скопируйте полученный `file_id` в `WELCOME_STICKER_ID`.

Для сохранения базы пользователей между перезапусками Render подключите Persistent Disk и укажите `DATA_DIR=/var/data`.
