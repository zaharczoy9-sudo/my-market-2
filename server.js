require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { Bot, InlineKeyboard } = require('grammy');

// ---------- Настройки ----------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
const PORT = Number(process.env.PORT) || 3000;
const DEV_MODE = process.env.DEV_MODE === '1';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const CURRENCY = process.env.CURRENCY || 'BYN';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace('@', '');
const APP_SHORT_NAME = process.env.APP_SHORT_NAME || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_ACTIVE_ADS = 30;

const CATEGORIES = [
  'Электроника', 'Одежда и обувь', 'Дом и сад', 'Транспорт', 'Недвижимость',
  'Услуги', 'Детям', 'Хобби и спорт', 'Работа', 'Другое'
];

if (!BOT_TOKEN && !DEV_MODE) {
  console.error('Не задан BOT_TOKEN. Скопируйте .env.example в .env и заполните.');
  process.exit(1);
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- База данных ----------
const db = new Database(path.join(DATA_DIR, 'market.db'));
db.pragma('journal_mode = WAL');
db.function('lc', s => String(s == null ? '' : s).toLowerCase());
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER,
  category TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  photos TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_status_upd ON ads(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_user ON ads(user_id);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  ad_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, ad_id)
);
`);

// ---------- Бот ----------
let bot = null;
if (BOT_TOKEN) {
  bot = new Bot(BOT_TOKEN);
  bot.command('start', ctx =>
    ctx.reply(
      '👋 Добро пожаловать на маркетплейс!\nПокупайте и продавайте вещи прямо в Telegram.',
      WEBAPP_URL
        ? { reply_markup: new InlineKeyboard().webApp('🛍 Открыть маркет', WEBAPP_URL) }
        : undefined
    )
  );
  bot.catch(err => console.error('Ошибка бота:', err.message));
  bot.start({
    onStart: async () => {
      console.log('Бот запущен');
      if (WEBAPP_URL) {
        try {
          await bot.api.setChatMenuButton({
            menu_button: { type: 'web_app', text: 'Маркет', web_app: { url: WEBAPP_URL } }
          });
        } catch (e) { console.error('Не удалось поставить кнопку меню:', e.message); }
      }
    }
  });
}

// ---------- Проверка подписи Telegram (initData) ----------
function validateInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

const upsertUser = db.prepare(`
  INSERT INTO users (id, username, first_name) VALUES (@id, @username, @first_name)
  ON CONFLICT(id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name
`);

function auth(req, res, next) {
  const initData = req.get('X-Telegram-Init-Data') || '';
  let user = null;
  if (initData && BOT_TOKEN) user = validateInitData(initData);
  if (!user && DEV_MODE) user = { id: 1, username: 'dev_user', first_name: 'Dev' };
  if (!user) return res.status(401).json({ error: 'Откройте приложение из Telegram' });
  upsertUser.run({ id: user.id, username: user.username || null, first_name: user.first_name || '' });
  req.user = user;
  req.isAdmin = ADMIN_IDS.includes(user.id);
  next();
}

// ---------- Загрузка фото ----------
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + EXT[file.mimetype])
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new Error('Только JPG, PNG или WebP'))
});
const removeFiles = names =>
  names.forEach(n => fs.unlink(path.join(UPLOAD_DIR, path.basename(n)), () => {}));

// ---------- Express ----------
const app = express();
app.set('trust proxy', 1);
app.get('/health', (req, res) => res.send('ok'));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

const BASE = `
  SELECT a.*, u.username AS seller_username, u.first_name AS seller_name,
         EXISTS(SELECT 1 FROM favorites f WHERE f.ad_id = a.id AND f.user_id = @uid) AS fav
  FROM ads a JOIN users u ON u.id = a.user_id`;

const ser = (r, uid) => ({
  ...r,
  photos: JSON.parse(r.photos || '[]').map(f => '/uploads/' + f),
  fav: !!r.fav,
  mine: r.user_id === uid
});

app.get('/api/config', auth, (req, res) => {
  res.json({
    categories: CATEGORIES,
    currency: CURRENCY,
    bot_username: BOT_USERNAME,
    app_short_name: APP_SHORT_NAME,
    me: { id: req.user.id, username: req.user.username || null, is_admin: req.isAdmin }
  });
});

app.get('/api/ads', auth, (req, res) => {
  const uid = req.user.id;
  const where = ["a.status = 'active'"];
  const p = { uid };
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
  if (q) { where.push('(lc(a.title) LIKE @q OR lc(a.description) LIKE @q)'); p.q = `%${q}%`; }
  if (CATEGORIES.includes(req.query.category)) { where.push('a.category = @cat'); p.cat = req.query.category; }
  const city = String(req.query.city || '').trim().toLowerCase().slice(0, 40);
  if (city) { where.push('lc(a.city) LIKE @city'); p.city = `%${city}%`; }
  const order = {
    new: 'a.updated_at DESC, a.id DESC',
    cheap: 'a.price IS NULL, a.price ASC, a.id DESC',
    exp: 'a.price IS NULL, a.price DESC, a.id DESC'
  }[req.query.sort] || 'a.updated_at DESC, a.id DESC';
  const limit = 20;
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const rows = db.prepare(`${BASE} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(p);
  res.json({ items: rows.map(r => ser(r, uid)), hasMore: rows.length === limit });
});

app.get('/api/ads/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`${BASE} WHERE a.id = @id`).get({ id, uid: req.user.id });
  if (!row) return res.status(404).json({ error: 'Объявление не найдено' });
  if (row.user_id !== req.user.id) {
    db.prepare('UPDATE ads SET views = views + 1 WHERE id = ?').run(id);
    row.views += 1;
  }
  res.json(ser(row, req.user.id));
});

app.post('/api/ads', auth, upload.array('photos', 5), (req, res) => {
  const files = (req.files || []).map(f => f.filename);
  const fail = (code, msg) => { removeFiles(files); return res.status(code).json({ error: msg }); };

  if (!req.user.username)
    return fail(400, 'Чтобы продавать, задайте username в настройках Telegram — по нему с вами свяжутся покупатели.');

  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const category = String(req.body.category || '');
  const city = String(req.body.city || '').trim();
  const priceRaw = String(req.body.price || '').trim();
  const price = priceRaw === '' ? null : Number(priceRaw);

  if (title.length < 3 || title.length > 80) return fail(400, 'Название: от 3 до 80 символов');
  if (description.length > 2000) return fail(400, 'Описание: не больше 2000 символов');
  if (!CATEGORIES.includes(category)) return fail(400, 'Выберите категорию');
  if (city.length > 40) return fail(400, 'Город слишком длинный');
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > 1e9)) return fail(400, 'Некорректная цена');

  const active = db.prepare("SELECT COUNT(*) c FROM ads WHERE user_id = ? AND status = 'active'").get(req.user.id).c;
  if (active >= MAX_ACTIVE_ADS) return fail(400, `Не больше ${MAX_ACTIVE_ADS} активных объявлений`);

  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    INSERT INTO ads (user_id, title, description, price, category, city, photos, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, title, description, price, category, city, JSON.stringify(files), now, now);
  res.json({ id: info.lastInsertRowid });
});

// Смена статуса (active / sold) или "поднять"
app.put('/api/ads/:id', auth, (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.params.id));
  if (!ad) return res.status(404).json({ error: 'Объявление не найдено' });
  if (ad.user_id !== req.user.id) return res.status(403).json({ error: 'Это не ваше объявление' });
  const now = Math.floor(Date.now() / 1000);

  if (req.body.action === 'bump') {
    if (ad.status !== 'active') return res.status(400).json({ error: 'Объявление не активно' });
    if (now - ad.updated_at < 86400) return res.status(400).json({ error: 'Поднимать можно раз в сутки' });
    db.prepare('UPDATE ads SET updated_at = ? WHERE id = ?').run(now, ad.id);
    return res.json({ ok: true });
  }
  if (['active', 'sold'].includes(req.body.status)) {
    db.prepare('UPDATE ads SET status = ? WHERE id = ?').run(req.body.status, ad.id);
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'Неверный запрос' });
});

app.delete('/api/ads/:id', auth, (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.params.id));
  if (!ad) return res.status(404).json({ error: 'Объявление не найдено' });
  if (ad.user_id !== req.user.id && !req.isAdmin) return res.status(403).json({ error: 'Нет доступа' });
  removeFiles(JSON.parse(ad.photos || '[]'));
  db.prepare('DELETE FROM favorites WHERE ad_id = ?').run(ad.id);
  db.prepare('DELETE FROM ads WHERE id = ?').run(ad.id);
  res.json({ ok: true });
});

app.get('/api/my/ads', auth, (req, res) => {
  const rows = db.prepare(`${BASE} WHERE a.user_id = @uid ORDER BY a.updated_at DESC`).all({ uid: req.user.id });
  res.json({ items: rows.map(r => ser(r, req.user.id)) });
});

app.get('/api/favorites', auth, (req, res) => {
  const rows = db.prepare(`${BASE} WHERE a.id IN (SELECT ad_id FROM favorites WHERE user_id = @uid) ORDER BY a.updated_at DESC`)
    .all({ uid: req.user.id });
  res.json({ items: rows.map(r => ser(r, req.user.id)) });
});

app.post('/api/favorites/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM ads WHERE id = ?').get(id)) return res.status(404).json({ error: 'Не найдено' });
  const del = db.prepare('DELETE FROM favorites WHERE user_id = ? AND ad_id = ?').run(req.user.id, id);
  if (del.changes) return res.json({ fav: false });
  db.prepare('INSERT INTO favorites (user_id, ad_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ fav: true });
});

app.post('/api/ads/:id/report', auth, async (req, res) => {
  const id = Number(req.params.id);
  const ad = db.prepare('SELECT id, title FROM ads WHERE id = ?').get(id);
  if (!ad) return res.status(404).json({ error: 'Не найдено' });
  if (bot && ADMIN_IDS.length) {
    const text = `🚩 Жалоба на объявление #${ad.id}\n«${ad.title}»\nОт: ${req.user.id} (@${req.user.username || '—'})`;
    for (const admin of ADMIN_IDS) bot.api.sendMessage(admin, text).catch(() => {});
  }
  res.json({ ok: true });
});

// Обработка ошибок (в том числе multer)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Фото больше 5 МБ' : 'Слишком много файлов (максимум 5)';
    return res.status(400).json({ error: msg });
  }
  if (err) return res.status(400).json({ error: err.message || 'Ошибка' });
  next();
});

app.listen(PORT, () => console.log(`Сервер: http://localhost:${PORT}${DEV_MODE ? '  (DEV_MODE)' : ''}`));

process.once('SIGINT', () => { bot && bot.stop(); process.exit(0); });
process.once('SIGTERM', () => { bot && bot.stop(); process.exit(0); });
