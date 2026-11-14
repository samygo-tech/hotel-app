'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { handle } = require('./api');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const PASSWORD = process.env.ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MS = 12 * 60 * 60 * 1000;

if (!PASSWORD) {
  console.error('ADMIN_PASSWORD is not set. Set it as an environment variable and restart.');
  process.exit(1);
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sign = exp => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function authed(req) {
  const m = /(?:^|;\s*)hb=(\d+)\.([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && Number(m[1]) > Date.now() && same(m[2], sign(m[1]));
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '100kb' }));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Login with a simple per-IP attempt limit.
const tries = new Map();
app.post('/api/login', (req, res) => {
  const now = Date.now();
  let t = tries.get(req.ip);
  if (!t || now > t.reset) t = { n: 0, reset: now + 15 * 60 * 1000 };
  tries.set(req.ip, t);
  if (t.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!same(sha((req.body || {}).password || ''), sha(PASSWORD))) {
    t.n++;
    return res.status(401).json({ error: 'Wrong password.' });
  }
  tries.delete(req.ip);
  const exp = now + SESSION_MS;
  res.cookie('hb', exp + '.' + sign(exp), { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_MS });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('hb'); res.json({ ok: true }); });
app.get('/api/session', (req, res) => res.json({ ok: authed(req) }));

// Everything below requires a signed-in session; changes must be sent as JSON.
app.use('/api', (req, res, next) => {
  if (!authed(req)) return res.status(401).json({ error: 'Please sign in.' });
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  next();
});
app.all('/api/*', (req, res) => {
  const [status, json] = handle(req.method, req.originalUrl, req.body);
  res.status(status).json(json);
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: 'Bad request.' }));

app.listen(PORT, '0.0.0.0', () => console.log(`Hotel system running on port ${PORT}`));
