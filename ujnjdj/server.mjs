import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
function loadDotEnv() {
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith('#')) continue;
      const separator = entry.indexOf('=');
      if (separator < 1) continue;
      const key = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch { /* .env is optional when the host provides environment variables */ }
}
loadDotEnv();
const PORT = Number(process.env.PORT || 8787);
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const MINI_APP_URL = String(process.env.MINI_APP_URL || `http://127.0.0.1:${PORT}`).trim().replace(/\/$/, '');
const MANAGER_CHAT_ID = String(process.env.MANAGER_CHAT_ID || '').trim();
const MANAGER_CONTACT_URL = String(process.env.MANAGER_CONTACT_URL || 'https://t.me/alairustam').trim();
const WELCOME_BANNER = path.join(ROOT, 'assets', 'telegram-welcome-banner.png');
const WELCOME_STICKER_ID = String(process.env.WELCOME_STICKER_ID || '').trim();
const ADMIN_CHAT_IDS = new Set(String(process.env.ADMIN_CHAT_ID || '').split(',').map(value => value.trim()).filter(Boolean));
const DATA_DIR = path.resolve(ROOT, String(process.env.DATA_DIR || 'data').trim());
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const seenOrderIds = new Set();
const adminModes = new Map();
let stateCache;
let stateWriteChain = Promise.resolve();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length});
  res.end(data);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAdmin(chatId) {
  return ADMIN_CHAT_IDS.has(String(chatId));
}

function emptyState() {
  return {users: {}, orders: [], broadcasts: []};
}

async function readState() {
  if (stateCache) return stateCache;
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    stateCache = {
      users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {},
      orders: Array.isArray(parsed?.orders) ? parsed.orders : [],
      broadcasts: Array.isArray(parsed?.broadcasts) ? parsed.broadcasts : []
    };
  } catch {
    stateCache = emptyState();
  }
  return stateCache;
}

async function saveState() {
  const snapshot = JSON.stringify(stateCache || emptyState(), null, 2);
  stateWriteChain = stateWriteChain.then(async () => {
    try {
      await mkdir(DATA_DIR, {recursive: true});
      await writeFile(STATE_FILE, snapshot, 'utf8');
    } catch (error) {
      console.error('[state]', error.message);
    }
  });
  return stateWriteChain;
}

async function rememberUser(user, chatId, action = '') {
  if (!user && !chatId) return;
  const state = await readState();
  const id = String(chatId || user?.id || '');
  if (!id) return;
  const previous = state.users[id] || {};
  state.users[id] = {
    ...previous,
    chatId: id,
    username: String(user?.username || previous.username || ''),
    firstName: String(user?.first_name || previous.firstName || ''),
    lastName: String(user?.last_name || previous.lastName || ''),
    languageCode: String(user?.language_code || previous.languageCode || ''),
    firstSeenAt: previous.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    lastAction: action || previous.lastAction || '',
    messages: Number(previous.messages || 0) + 1,
    blocked: Boolean(previous.blocked)
  };
  await saveState();
}

async function rememberOrder(payload, telegramUser, orderId) {
  const state = await readState();
  if (state.orders.some(order => order.orderId === orderId)) return;
  state.orders.unshift({
    orderId,
    createdAt: new Date().toISOString(),
    chatId: String(telegramUser?.id || ''),
    username: String(telegramUser?.username || ''),
    name: [telegramUser?.first_name, telegramUser?.last_name].filter(Boolean).join(' '),
    message: String(payload?.message || '')
  });
  state.orders = state.orders.slice(0, 5000);
  await saveState();
}

function userLabel(user) {
  if (user.username) return `@${user.username}`;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || `id ${user.chatId}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bishkek'}).format(new Date(value));
}

function isHttpsUrl(value) {
  return /^https:\/\//i.test(value);
}

async function telegramCall(method, body) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.statusText}`);
  return result.result;
}

async function telegramPhoto(chatId, caption, replyMarkup) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const image = await readFile(WELCOME_BANNER);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([image], {type: 'image/png'}), 'alai-cloud-welcome.png');
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('reply_markup', JSON.stringify(replyMarkup));
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {method: 'POST', body: form});
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram sendPhoto: ${result.description || response.statusText}`);
  return result.result;
}

async function telegramDocument(chatId, content, filename, caption = '') {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([content], {type: 'text/csv; charset=utf-8'}), filename);
  if (caption) form.append('caption', caption);
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {method: 'POST', body: form});
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram sendDocument: ${result.description || response.statusText}`);
  return result.result;
}

function welcomeCaption(firstName = '') {
  const name = firstName ? `, ${escapeHtml(firstName)}` : '';
  return `<b>Alai Cloud${name}</b>\n\nКаталог одноразок с быстрым заказом в Telegram.\n\n<b>Акция 1+1=3</b> — берите две, третья в подарок 🎁\n\nВыберите товар, вкус и количество — сообщение менеджеру будет подготовлено в один клик.\n\n<i>18+ · Содержит никотин</i>`;
}

function catalogKeyboard() {
  return {
    inline_keyboard: [
      [{text: 'Открыть каталог', web_app: {url: MINI_APP_URL}}],
      [{text: 'Написать менеджеру', url: MANAGER_CONTACT_URL}]
    ]
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [{text: '📊 Статистика', callback_data: 'admin:stats'}, {text: '👥 Пользователи', callback_data: 'admin:users'}],
      [{text: '📣 Новая рассылка', callback_data: 'admin:broadcast'}, {text: '🧾 Заказы', callback_data: 'admin:orders'}],
      [{text: '📤 Выгрузить CSV', callback_data: 'admin:export'}, {text: '🔄 Обновить', callback_data: 'admin:refresh'}],
      [{text: '🛍 Открыть Mini App', web_app: {url: MINI_APP_URL}}]
    ]
  };
}

async function sendAdminPanel(chatId, extra = '') {
  if (!isAdmin(chatId)) {
    return telegramCall('sendMessage', {chat_id: chatId, text: 'Эта команда доступна только администратору.'});
  }
  const suffix = extra ? `\n\n${extra}` : '';
  return telegramCall('sendMessage', {
    chat_id: chatId,
    text: `<b>Админ-панель Alai Cloud</b>${suffix}\n\nВыберите действие:`,
    parse_mode: 'HTML',
    reply_markup: adminKeyboard()
  });
}

async function adminStatsText() {
  const state = await readState();
  const users = Object.values(state.users);
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const active24h = users.filter(user => now - Date.parse(user.lastSeenAt || 0) <= day).length;
  const active7d = users.filter(user => now - Date.parse(user.lastSeenAt || 0) <= day * 7).length;
  const blocked = users.filter(user => user.blocked).length;
  const broadcasts = state.broadcasts.length;
  return [
    '<b>📊 Статистика</b>',
    '',
    `<b>Пользователи:</b> ${users.length}`,
    `<b>Активны за 24 часа:</b> ${active24h}`,
    `<b>Активны за 7 дней:</b> ${active7d}`,
    `<b>Заблокировали бота:</b> ${blocked}`,
    `<b>Заказы через бота:</b> ${state.orders.length}`,
    `<b>Рассылок:</b> ${broadcasts}`
  ].join('\n');
}

async function adminUsersText(page = 0) {
  const state = await readState();
  const users = Object.values(state.users).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  const pageSize = 20;
  const start = page * pageSize;
  const rows = users.slice(start, start + pageSize);
  const lines = rows.length ? rows.map((user, index) => `${start + index + 1}. ${escapeHtml(userLabel(user))} · <code>${escapeHtml(user.chatId)}</code>\n   ${formatDate(user.lastSeenAt)}${user.blocked ? ' · заблокировал' : ''}`) : ['Пользователей пока нет.'];
  return `<b>👥 Пользователи · ${users.length}</b>\n\n${lines.join('\n')}`;
}

async function adminOrdersText() {
  const state = await readState();
  const rows = state.orders.slice(0, 10);
  if (!rows.length) return '<b>🧾 Заказы</b>\n\nЗаказов через бота пока нет.';
  return `<b>🧾 Последние заказы</b>\n\n${rows.map(order => `${escapeHtml(order.orderId)} · ${escapeHtml(order.name || (order.username ? `@${order.username}` : `id ${order.chatId || '—'}`))}\n${escapeHtml(formatDate(order.createdAt))}`).join('\n\n')}`;
}

async function adminCsv(chatId) {
  const state = await readState();
  const header = ['chat_id', 'username', 'first_name', 'last_name', 'language', 'first_seen_at', 'last_seen_at', 'last_action', 'blocked', 'messages'];
  const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = Object.values(state.users).map(user => [
    user.chatId, user.username, user.firstName, user.lastName, user.languageCode,
    user.firstSeenAt, user.lastSeenAt, user.lastAction, user.blocked ? 'yes' : 'no', user.messages
  ].map(csvCell).join(','));
  const content = `\ufeff${header.join(',')}\n${rows.join('\n')}`;
  await telegramDocument(chatId, content, `alai-cloud-users-${new Date().toISOString().slice(0, 10)}.csv`, 'Список пользователей Alai Cloud');
}

async function broadcastCopy(adminChatId, messageId) {
  const state = await readState();
  const users = Object.values(state.users).filter(user => !user.blocked && user.chatId !== String(adminChatId));
  let sent = 0;
  let failed = 0;
  for (const user of users) {
    try {
      await telegramCall('copyMessage', {chat_id: user.chatId, from_chat_id: adminChatId, message_id: messageId});
      sent += 1;
    } catch (error) {
      failed += 1;
      const description = error.message.toLowerCase();
      if (description.includes('blocked') || description.includes('deactivated') || description.includes('chat not found')) {
        user.blocked = true;
      }
    }
    await delay(80);
  }
  state.broadcasts.unshift({createdAt: new Date().toISOString(), sent, failed, total: users.length});
  state.broadcasts = state.broadcasts.slice(0, 200);
  await saveState();
  return {sent, failed, total: users.length};
}

async function sendWelcome(chatId, firstName = '') {
  if (WELCOME_STICKER_ID) {
    try { await telegramCall('sendSticker', {chat_id: chatId, sticker: WELCOME_STICKER_ID}); }
    catch (error) { console.warn('[welcome sticker]', error.message); }
  }
  // Приветствие всегда визуальное: баннер, подпись и кнопки отправляются одним сообщением.
  await telegramPhoto(chatId, welcomeCaption(firstName), catalogKeyboard());
}

function managerText(payload, telegramUser, orderId) {
  const client = telegramUser || {};
  const clientName = [client.first_name, client.last_name].filter(Boolean).join(' ') || 'клиент Mini App';
  const telegram = client.username ? `@${client.username}` : (client.id ? `id ${client.id}` : 'не указан');
  const orderText = String(payload?.message || 'Данные заказа не переданы');
  return [
    '<b>Новый заказ · Alai Cloud</b>',
    `<code>${escapeHtml(orderId)}</code>`,
    '',
    `<pre>${escapeHtml(orderText)}</pre>`,
    '',
    `<b>Telegram клиента:</b> ${escapeHtml(clientName)} · ${escapeHtml(telegram)}`
  ].join('\n');
}

async function forwardOrder(payload, telegramUser, suppliedOrderId = '') {
  if (!MANAGER_CHAT_ID) throw new Error('MANAGER_CHAT_ID is not configured');
  const orderId = String(suppliedOrderId || payload?.orderId || `AC-${randomUUID().slice(0, 8).toUpperCase()}`);
  if (seenOrderIds.has(orderId)) return {orderId, duplicate: true};
  await telegramCall('sendMessage', {
    chat_id: MANAGER_CHAT_ID,
    text: managerText(payload, telegramUser, orderId),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  seenOrderIds.add(orderId);
  if (seenOrderIds.size > 5000) seenOrderIds.delete(seenOrderIds.values().next().value);
  await rememberOrder(payload, telegramUser, orderId);
  return {orderId, duplicate: false};
}

function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return {ok: false, reason: 'Telegram session is missing'};
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return {ok: false, reason: 'Invalid Telegram hash'};
  const pairs = [...params.entries()].filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const left = Buffer.from(calculatedHash, 'hex');
  const right = Buffer.from(receivedHash, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return {ok: false, reason: 'Invalid Telegram hash'};
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return {ok: false, reason: 'Telegram session expired'};
  let user = {};
  try { user = JSON.parse(params.get('user') || '{}'); } catch { return {ok: false, reason: 'Invalid Telegram user'}; }
  return {ok: true, user};
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleOrderApi(req, res) {
  if (req.method !== 'POST') return json(res, 405, {ok: false, error: 'Method not allowed'});
  const verified = verifyInitData(String(req.headers['x-telegram-init-data'] || ''));
  if (!verified.ok) return json(res, 401, {ok: false, error: verified.reason});
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch (error) { return json(res, 400, {ok: false, error: error.message}); }
  if (!payload || payload.type !== 'order') return json(res, 400, {ok: false, error: 'Invalid order payload'});
  try {
    await rememberUser(verified.user, verified.user.id, 'mini_app_order');
    const result = await forwardOrder(payload, verified.user, payload.orderId);
    return json(res, 200, {ok: true, ...result});
  } catch (error) {
    console.error('[order]', error.message);
    return json(res, 503, {ok: false, error: 'Order delivery is not configured'});
  }
}

async function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const filePath = path.resolve(ROOT, `.${decoded}`);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return json(res, 403, {ok: false, error: 'Forbidden'});
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return json(res, 404, {ok: false, error: 'Not found'});
    const data = await readFile(filePath);
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': pathname.includes('/assets/') ? 'public, max-age=3600' : 'no-cache'});
    res.end(data);
  } catch {
    json(res, 404, {ok: false, error: 'Not found'});
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') return json(res, 200, {ok: true, botConfigured: Boolean(BOT_TOKEN), managerConfigured: Boolean(MANAGER_CHAT_ID), adminConfigured: ADMIN_CHAT_IDS.size > 0, miniAppUrl: MINI_APP_URL});
  if (url.pathname === '/api/orders') return handleOrderApi(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, {ok: false, error: 'Method not allowed'});
  return serveStatic(req, res, url.pathname);
}

async function handleCallback(update) {
  const callback = update.callback_query;
  if (!callback) return;
  const chatId = callback.message?.chat?.id || callback.from?.id;
  await telegramCall('answerCallbackQuery', {callback_query_id: callback.id});
  if (!isAdmin(chatId)) return;
  const data = String(callback.data || '');
  if (data === 'admin:stats' || data === 'admin:refresh') {
    return sendAdminPanel(chatId, await adminStatsText());
  }
  if (data === 'admin:users') return sendAdminPanel(chatId, await adminUsersText());
  if (data === 'admin:orders') return sendAdminPanel(chatId, await adminOrdersText());
  if (data === 'admin:export') {
    await adminCsv(chatId);
    return telegramCall('sendMessage', {chat_id: chatId, text: 'CSV выгрузка готова ✅'});
  }
  if (data === 'admin:broadcast') {
    adminModes.set(String(chatId), 'broadcast');
    return telegramCall('sendMessage', {chat_id: chatId, text: 'Отправьте следующим сообщением текст, фото, видео или стикер. Я разошлю его всем пользователям, которые запускали бота.\n\nДля отмены: /cancel'});
  }
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update);
  const message = update.message;
  if (!message?.chat?.id) return;
  const chatId = message.chat.id;
  const text = String(message.text || '');
  if (message.chat.type === 'private') await rememberUser(message.from, chatId, text.startsWith('/') ? text.split(/\s+/)[0] : 'message');

  if (isAdmin(chatId) && adminModes.get(String(chatId)) === 'broadcast' && !text.startsWith('/cancel')) {
    adminModes.delete(String(chatId));
    await telegramCall('sendMessage', {chat_id: chatId, text: 'Рассылка началась. Я сообщу результат после отправки.'});
    try {
      const result = await broadcastCopy(chatId, message.message_id);
      return telegramCall('sendMessage', {chat_id: chatId, text: `Рассылка завершена ✅\nОтправлено: ${result.sent}\nОшибок: ${result.failed}\nВсего получателей: ${result.total}`, reply_markup: adminKeyboard()});
    } catch (error) {
      console.error('[broadcast]', error.message);
      return telegramCall('sendMessage', {chat_id: chatId, text: 'Рассылка остановилась из-за ошибки. Проверьте логи сервера.'});
    }
  }

  if (text === '/cancel') {
    adminModes.delete(String(chatId));
    return telegramCall('sendMessage', {chat_id: chatId, text: 'Действие отменено.'});
  }
  if (text === '/admin' || text === '/panel' || text === '/stats') return sendAdminPanel(chatId, text === '/stats' ? await adminStatsText() : '');
  if (text === '/users' && isAdmin(chatId)) return sendAdminPanel(chatId, await adminUsersText());
  if (text.startsWith('/start')) return sendWelcome(chatId, message.from?.first_name || '');
  if (text === '/catalog') return sendWelcome(chatId, message.from?.first_name || '');
  if (text === '/stickerid') {
    return telegramCall('sendMessage', {chat_id: chatId, text: 'Пришлите сюда стикер — я верну его file_id для настройки приветствия.'});
  }
  if (message.sticker?.file_id) {
    return telegramCall('sendMessage', {chat_id: chatId, text: `STICKER_ID:\n${message.sticker.file_id}\n\nДобавьте это значение в WELCOME_STICKER_ID на сервере.`});
  }
  if (text === '/id') {
    return telegramCall('sendMessage', {chat_id: chatId, text: `Ваш Telegram chat_id:\n${chatId}\n\nДля админки добавьте этот номер в переменную ADMIN_CHAT_ID.\nДля отправки заказов через самого бота — в MANAGER_CHAT_ID.`});
  }
  if (!message.web_app_data?.data) return;
  let payload;
  try { payload = JSON.parse(message.web_app_data.data); } catch { return telegramCall('sendMessage', {chat_id: chatId, text: 'Не удалось прочитать заказ. Откройте каталог заново и повторите попытку.'}); }
  try {
    await forwardOrder(payload, message.from, payload.orderId);
    await telegramCall('sendMessage', {chat_id: chatId, text: 'Заказ принят ✅\nМенеджер скоро свяжется с вами.', reply_markup: catalogKeyboard()});
  } catch (error) {
    console.error('[web_app_data]', error.message);
    await telegramCall('sendMessage', {chat_id: chatId, text: 'Заказ не отправился менеджеру. Попробуйте ещё раз через минуту.'});
  }
}

async function startBot() {
  if (!BOT_TOKEN) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN is not configured; static site is still available');
    return;
  }
  await telegramCall('deleteWebhook', {drop_pending_updates: false});
  await telegramCall('setMyCommands', {commands: [
    {command: 'start', description: 'Открыть Alai Cloud'},
    {command: 'catalog', description: 'Открыть каталог'},
    {command: 'admin', description: 'Админ-панель'},
    {command: 'stats', description: 'Статистика для администратора'},
    {command: 'users', description: 'Пользователи для администратора'},
    {command: 'id', description: 'Показать chat_id'},
    {command: 'stickerid', description: 'Подключить стикер'},
    {command: 'cancel', description: 'Отменить действие'}
  ]});
  if (isHttpsUrl(MINI_APP_URL)) {
    await telegramCall('setChatMenuButton', {menu_button: {type: 'web_app', text: 'Каталог', web_app: {url: MINI_APP_URL}}});
  } else {
    console.warn('[telegram] MINI_APP_URL must be HTTPS before Telegram menu button can be enabled');
  }
  let offset = 0;
  console.log('[telegram] bot polling started');
  while (true) {
    try {
      const updates = await telegramCall('getUpdates', {offset, timeout: 25, allowed_updates: ['message', 'callback_query']});
      for (const update of updates) {
        offset = update.update_id + 1;
        try { await handleUpdate(update); } catch (error) { console.error('[telegram update]', error.message); }
      }
    } catch (error) {
      console.error('[telegram polling]', error.message);
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('[http]', error);
    if (!res.headersSent) json(res, 500, {ok: false, error: 'Internal server error'}); else res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Alai Cloud listening on http://0.0.0.0:${PORT}`);
  void startBot().catch(error => console.error('[telegram startup]', error.message));
});
