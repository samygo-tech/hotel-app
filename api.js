'use strict';
const fs = require('fs');
const path = require('path');

// better-sqlite3 is the production driver; node:sqlite (Node 22+) is a fallback.
let Database;
try { Database = require('better-sqlite3'); }
catch (e) { Database = require('node:sqlite').DatabaseSync; }

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'hotel.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS hotels(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT NOT NULL,
  total_rooms INTEGER NOT NULL CHECK(total_rooms>0), cost_price REAL NOT NULL CHECK(cost_price>=0));
CREATE TABLE IF NOT EXISTS room_types(
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity>0), quantity INTEGER NOT NULL CHECK(quantity>0),
  base_price REAL NOT NULL CHECK(base_price>=0));
CREATE TABLE IF NOT EXISTS rates(
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id INTEGER REFERENCES room_types(id) ON DELETE CASCADE, name TEXT NOT NULL,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, price REAL NOT NULL CHECK(price>=0), CHECK(end_date>=start_date));
CREATE TABLE IF NOT EXISTS guests(
  id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE RESTRICT,
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  room_type_id INTEGER REFERENCES room_types(id) ON DELETE RESTRICT,
  check_in TEXT NOT NULL, check_out TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','checked_in','checked_out','cancelled')),
  selling_price REAL CHECK(selling_price IS NULL OR selling_price>=0), notes TEXT NOT NULL DEFAULT '',
  CHECK(check_out>check_in));
CREATE INDEX IF NOT EXISTS ix_bookings_hotel ON bookings(hotel_id, check_in, check_out);
`);

const ST = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'];
const ACTIVE = ['pending', 'confirmed', 'checked_in']; // statuses that occupy a room

// Field types: s=required text, o=optional text, e=email, i=integer>=1, n=number>=0,
// d=date, st=status, fk:<table>=existing record id; a trailing ? makes a field optional.
const T = {
  hotels: { name: 's', city: 's', total_rooms: 'i', cost_price: 'n' },
  room_types: { hotel_id: 'fk:hotels', name: 's', capacity: 'i', quantity: 'i', base_price: 'n' },
  rates: { hotel_id: 'fk:hotels', room_type_id: 'fk:room_types?', name: 's', start_date: 'd', end_date: 'd', price: 'n' },
  guests: { full_name: 's', email: 'e', phone: 'o' },
  bookings: { hotel_id: 'fk:hotels', guest_id: 'fk:guests', room_type_id: 'fk:room_types?', check_in: 'd', check_out: 'd',
              status: 'st', selling_price: 'n?', notes: 'o' }
};

const fail = (status, error) => ({ status, error });
const lbl = k => k.replace(/_id$/, '').replace(/_/g, ' ').replace(/^check (in|out)$/, 'check-$1');

function clean(t, b) {
  const out = {};
  for (const [k, ty] of Object.entries(T[t])) {
    const opt = ty.endsWith('?'), base = ty.replace(/\?$/, '');
    const bad = fail(400, base.startsWith('fk') ? `Choose a ${lbl(k)}.` : `Enter a valid ${lbl(k)}.`);
    let v = b[k];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v == null) {
      if (opt) { out[k] = null; continue; }
      if (base === 'o') { out[k] = ''; continue; }
      if (k === 'status') { out[k] = 'pending'; continue; }
      throw bad;
    }
    if (base === 's' || base === 'o') { v = String(v); if (v.length > (base === 's' ? 200 : 500)) throw bad; }
    else if (base === 'e') { v = String(v).toLowerCase(); if (v.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw bad; }
    else if (base === 'i') { v = Number(v); if (!Number.isInteger(v) || v < 1 || v > 100000) throw bad; }
    else if (base === 'n') { v = Number(v); if (!Number.isFinite(v) || v < 0 || v > 1e9) throw bad; }
    else if (base === 'd') {
      v = String(v);
      if (!/^\d{4}-\d\d-\d\d$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z')) ||
          new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad;
    }
    else if (base === 'st') { if (!ST.includes(v)) throw bad; }
    else if (base.startsWith('fk:')) {
      v = Number(v);
      if (!Number.isInteger(v) || !db.prepare(`SELECT 1 FROM ${base.slice(3)} WHERE id=?`).get(v)) throw bad;
    }
    out[k] = v;
  }
  return out;
}

function extra(t, d, id) {
  if (d.room_type_id && !db.prepare('SELECT 1 FROM room_types WHERE id=? AND hotel_id=?').get(d.room_type_id, d.hotel_id))
    throw fail(400, 'That room type belongs to a different hotel.');
  if (t === 'rates' && d.end_date < d.start_date) throw fail(400, 'The end date must not be before the start date.');
  if (t !== 'bookings') return;
  if (d.check_out <= d.check_in) throw fail(400, 'Check-out must be after check-in.');
  if (!ACTIVE.includes(d.status)) return;
  const marks = ACTIVE.map(() => '?').join();
  const base = `SELECT COUNT(*) AS n FROM bookings WHERE hotel_id=? AND status IN (${marks}) AND check_in<? AND check_out>? AND id!=?`;
  const args = [d.hotel_id, ...ACTIVE, d.check_out, d.check_in, id || 0];
  const hotel = db.prepare('SELECT total_rooms FROM hotels WHERE id=?').get(d.hotel_id);
  if (db.prepare(base).get(...args).n >= hotel.total_rooms) throw fail(409, 'No rooms are free at this hotel for those dates.');
  if (d.room_type_id) {
    const rt = db.prepare('SELECT quantity FROM room_types WHERE id=?').get(d.room_type_id);
    if (db.prepare(base + ' AND room_type_id=?').get(...args, d.room_type_id).n >= rt.quantity)
      throw fail(409, 'All rooms of this type are booked for those dates.');
  }
}

const list = t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map(r => ({ ...r }));
const one = (t, id) => { const r = db.prepare(`SELECT * FROM ${t} WHERE id=?`).get(id); return r ? { ...r } : null; };

// Price for a stay start date: most specific seasonal rate, else the room type's base price.
function quote(q) {
  const h = Number(q.get('hotel_id')), rt = Number(q.get('room_type_id')) || null, d = q.get('date') || '';
  const r = db.prepare(`SELECT price, name FROM rates WHERE hotel_id=? AND start_date<=? AND end_date>=?
    AND (room_type_id IS NULL OR room_type_id=?) ORDER BY room_type_id IS NULL, start_date DESC LIMIT 1`).get(h, d, d, rt);
  if (r) return { price: r.price, source: 'Seasonal rate: ' + r.name };
  const t = rt && db.prepare('SELECT base_price FROM room_types WHERE id=? AND hotel_id=?').get(rt, h);
  return t ? { price: t.base_price, source: 'Room type base price' } : { price: null, source: null };
}

// Returns [httpStatus, jsonBody].
function handle(method, url, body) {
  try {
    const u = new URL(url, 'http://localhost');
    const p = u.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    body = body && typeof body === 'object' ? body : {};
    if (p[0] === 'quote' && method === 'GET') return [200, quote(u.searchParams)];
    if (p[0] === 'export' && method === 'GET') return [200, Object.fromEntries(Object.keys(T).map(t => [t, list(t)]))];
    const t = p[0];
    if (!Object.prototype.hasOwnProperty.call(T, t)) throw fail(404, 'Not found.');
    const id = p[1] != null ? Number(p[1]) : null;
    if (id !== null && !Number.isInteger(id)) throw fail(404, 'Not found.');

    if (method === 'GET' && id === null) return [200, list(t)];
    if (method === 'POST' && id === null) {
      const d = clean(t, body); extra(t, d, null);
      const cols = Object.keys(d);
      const r = db.prepare(`INSERT INTO ${t}(${cols.join()}) VALUES(${cols.map(() => '?').join()})`).run(...cols.map(c => d[c]));
      return [201, one(t, Number(r.lastInsertRowid))];
    }
    if (method === 'PUT' && id !== null) {
      const cur = one(t, id); if (!cur) throw fail(404, 'Not found.');
      const d = clean(t, { ...cur, ...body }); extra(t, d, id);
      const cols = Object.keys(d);
      db.prepare(`UPDATE ${t} SET ${cols.map(c => c + '=?').join()} WHERE id=?`).run(...cols.map(c => d[c]), id);
      return [200, one(t, id)];
    }
    if (method === 'DELETE' && id !== null) {
      if (!one(t, id)) throw fail(404, 'Not found.');
      db.prepare(`DELETE FROM ${t} WHERE id=?`).run(id);
      return [200, { ok: true }];
    }
    throw fail(405, 'Method not allowed.');
  } catch (e) {
    if (e && e.status) return [e.status, { error: e.error }];
    const msg = String(e && e.message);
    if (/FOREIGN KEY/i.test(msg)) return [409, { error: 'This record is still used by a booking, so it can’t be deleted. Delete or move those bookings first.' }];
    if (/UNIQUE/i.test(msg)) return [409, { error: 'A guest with that email already exists.' }];
    console.error(e);
    return [500, { error: 'Something went wrong on the server.' }];
  }
}

module.exports = { handle };
