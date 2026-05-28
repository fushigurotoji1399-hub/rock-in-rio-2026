import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dir, '.env') });

// ─── DATABASE ─────────────────────────────────────────────────────────────────
// Em produção (Railway), usa /data montado como volume persistente.
// Localmente usa ./data/
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/rir-data' : join(__dir, 'data'));
const DB_FILE  = join(DATA_DIR, 'db.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let db = existsSync(DB_FILE)
  ? JSON.parse(readFileSync(DB_FILE, 'utf-8'))
  : { customers: {}, orders: {}, sessions: {}, leads: {} };
if (!db.sessions) db.sessions = {};
if (!db.leads)    db.leads    = {};

function persist() { writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const input = scryptSync(pw, salt, 32);
    return timingSafeEqual(Buffer.from(hash, 'hex'), input);
  } catch { return false; }
}

function createSession(email) {
  const token = randomBytes(32).toString('hex');
  db.sessions[token] = { email: email.toLowerCase(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30*24*60*60*1000).toISOString() };
  persist();
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (new Date(s.expiresAt) < new Date()) { delete db.sessions[token]; persist(); return null; }
  return s;
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Não autenticado.' });
  req.session = session;
  req.customer = db.customers[session.email];
  next();
}

// ─── ORDER HELPERS ────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'RIR26-';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (db.orders[code]);
  return code;
}

function upsertCustomer(data) {
  const key = data.email.toLowerCase();
  if (!db.customers[key]) {
    db.customers[key] = { ...data, email: key, password: null, createdAt: new Date().toISOString() };
  } else {
    db.customers[key] = { ...db.customers[key], name: data.name, phone: data.phone, document: data.document };
  }
  return db.customers[key];
}

function createOrder({ customer, result, payload, code }) {
  const labelMap = { vip: 'Inteira', general: 'Meia-Entrada' };
  db.orders[code] = {
    code, customerEmail: customer.email.toLowerCase(), gatewayId: String(result.id),
    ticketType: payload.ticket.type, ticketLabel: labelMap[payload.ticket.type] || payload.ticket.type,
    quantity: payload.ticket.quantity, showDate: payload.ticket.show_date,
    amount: payload.amount, status: 'pending', paymentMethod: payload.payment.method,
    pixCode: result.pix?.copy_paste || null, createdAt: new Date().toISOString(), paidAt: null,
  };
  persist();
  return db.orders[code];
}

function markPaid(gatewayId) {
  const order = Object.values(db.orders).find(o => o.gatewayId === String(gatewayId));
  if (order) { order.status = 'paid'; order.paidAt = new Date().toISOString(); persist(); }
  return order;
}

// ─── LINEUP ───────────────────────────────────────────────────────────────────
const LINEUP = {
  'Rio de Janeiro — 04 Set': { weekday:'Sexta-feira, 4 de Setembro', headliner:'Post Malone', stages:{ 'Palco Mundo':['Post Malone','The Weeknd','Zé Neto & Cristiano'], 'Palco Sunset':['Olivia Rodrigo','Anitta','Ludmilla'], 'Palco Supernova':['Marina Sena','Xamã','Matuê'] } },
  'Rio de Janeiro — 05 Set': { weekday:'Sábado, 5 de Setembro', headliner:'Coldplay', stages:{ 'Palco Mundo':['Coldplay','Billie Eilish','Jão'], 'Palco Sunset':['Dua Lipa','Luísa Sonza','Gloria Groove'], 'Palco Supernova':['L7nnon','Veigh','Aziz Edala'] } },
  'Rio de Janeiro — 06 Set': { weekday:'Domingo, 6 de Setembro', headliner:'Bruno Mars', stages:{ 'Palco Mundo':['Bruno Mars','Lady Gaga','IZA'], 'Palco Sunset':['Camila Cabello','Péricles','Dilsinho'], 'Palco Supernova':['Baco Exu do Blues','Djonga','Ryan SP'] } },
  'Rio de Janeiro — 07 Set': { weekday:'Segunda-feira, 7 de Setembro — Feriado Nacional', headliner:'Beyoncé', stages:{ 'Palco Mundo':['Beyoncé','Ivete Sangalo','Pitty'], 'Palco Sunset':['SZA','Criolo','Liniker'], 'Palco Supernova':['BK','Rincon Sapiência','Recayd Mob'] } },
  'Rio de Janeiro — 11 Set': { weekday:'Sexta-feira, 11 de Setembro', headliner:'Metallica', stages:{ 'Palco Mundo':['Metallica','Blink-182',"Racionais MC's"], 'Palco Sunset':['Slipknot','Sepultura','Charlie Brown Jr. Tribute'], 'Palco Supernova':['CPM 22','NX Zero','Fresno'] } },
  'Rio de Janeiro — 12 Set': { weekday:'Sábado, 12 de Setembro', headliner:'Taylor Swift', stages:{ 'Palco Mundo':['Taylor Swift','Maroon 5','Seu Jorge'], 'Palco Sunset':['Lizzo','Djavan','Tim Maia Tribute'], 'Palco Supernova':['Lagum','Cesar Menotti & Fabiano','Hugo & Guilherme'] } },
  'Rio de Janeiro — 13 Set': { weekday:'Domingo, 13 de Setembro', headliner:'Ed Sheeran', stages:{ 'Palco Mundo':['Ed Sheeran','Zeca Pagodinho','Gilberto Gil'], 'Palco Sunset':['Charlie Puth','Caetano Veloso','Seu Jorge'], 'Palco Supernova':['Thiaguinho','Menos É Mais','Dilsinho'] } },
};

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(join(__dir, 'public')));

const ALLOWED = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── GATEWAY CONFIG ───────────────────────────────────────────────────────────
const GATEWAY = process.env.ACTIVE_GATEWAY || 'avixpay';
const AVIXPAY = { url: process.env.AVIXPAY_API_URL || 'https://api.avixpay.com/v1', publicKey: process.env.AVIXPAY_PUBLIC_KEY, key: process.env.AVIXPAY_API_KEY };
const PODPAY  = { url: process.env.PODPAY_API_URL  || 'https://api.podpay.com.br/v1', key: process.env.PODPAY_API_KEY, secret: process.env.PODPAY_SECRET };

async function avixPayCreate(p) {
  const docNumber = p.customer.document.replace(/\D/g, '');
  const body = {
    amount: p.amount, currency: 'BRL',
    paymentMethod: p.payment.method === 'card' ? 'credit_card' : 'pix', installments: 1,
    items: [{ title: p.description, quantity: p.ticket.quantity, tangible: false, unitPrice: p.amount, externalRef: '' }],
    customer: { name: p.customer.name, email: p.customer.email, phone: p.customer.phone.replace(/\D/g,''), document: { type: docNumber.length===11?'cpf':'passport', number: docNumber } },
    ...(p.payment.method==='card' && { card: { number: p.payment.card.number.replace(/\s/g,''), holderName: p.payment.card.holder_name, expirationMonth: p.payment.card.expiry_month, expirationYear: p.payment.card.expiry_year, cvv: p.payment.card.cvv } }),
    externalRef: `rir26-${Date.now()}`, ...(process.env.WEBHOOK_URL && { postbackUrl: process.env.WEBHOOK_URL }),
  };
  const credentials = Buffer.from(`${AVIXPAY.key}:`).toString('base64');
  const res = await fetch(`${AVIXPAY.url}/transactions`, { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Basic ${credentials}` }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || `AvixPay ${res.status}`);
  return normalizeResponse(data, 'avixpay');
}

async function podPayCreate(p) {
  const body = { amount: p.amount, currency: p.currency, description: p.description, customer: { name: p.customer.name, email: p.customer.email, phone: p.customer.phone, document: p.customer.document }, payment_method: p.payment.method==='card'?'credit_card':'pix', ...(p.payment.method==='card'&&{ card:{ number:p.payment.card.number, exp_month:p.payment.card.expiry_month, exp_year:p.payment.card.expiry_year, cvv:p.payment.card.cvv, holder_name:p.payment.card.holder_name } }) };
  const res = await fetch(`${PODPAY.url}/transactions`, { method:'POST', headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${PODPAY.key}` }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || `PodPay ${res.status}`);
  return normalizeResponse(data, 'podpay');
}

function normalizeResponse(data, gw) {
  const pix = gw==='avixpay' ? (data?.pix?.qrcode ? { copy_paste: data.pix.qrcode, expiration: data.pix.expirationDate } : null) : (data?.pix?.copy_paste ? { copy_paste: data.pix.copy_paste } : null);
  return { id: data.id||data.transactionId, status: data.status, ...(pix&&{ pix }) };
}

async function notifyTelegram(text) {
  const token=process.env.TELEGRAM_BOT_TOKEN, chat=process.env.TELEGRAM_CHAT_ID;
  if (!token||!chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id:chat, text, parse_mode:'HTML' }) }).catch(()=>{});
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', (req, res) => {
  try {
    const { name, lastName, email, phone, document, password, birthdate, gender, country } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e senha são obrigatórios.' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
    const key = email.toLowerCase();
    if (db.customers[key]?.password) return res.status(409).json({ error: 'Este email já está cadastrado.' });
    const fullName = lastName ? `${name} ${lastName}` : name;
    if (!db.customers[key]) {
      db.customers[key] = { name: fullName, email: key, phone: phone||'', document: document||'', birthdate: birthdate||'', gender: gender||'', country: country||'BR', password: hashPassword(password), createdAt: new Date().toISOString() };
    } else {
      db.customers[key].name = fullName;
      db.customers[key].password = hashPassword(password);
      if (phone)     db.customers[key].phone     = phone;
      if (document)  db.customers[key].document  = document;
      if (birthdate) db.customers[key].birthdate = birthdate;
      if (gender)    db.customers[key].gender    = gender;
    }
    persist();
    const token = createSession(key);
    const c = db.customers[key];
    return res.status(201).json({ token, customer: { name: c.name, email: c.email, phone: c.phone } });
  } catch(err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios.' });
  const key = email.toLowerCase();
  const customer = db.customers[key];
  if (!customer || !customer.password) return res.status(401).json({ error: 'Email ou senha incorretos.' });
  if (!verifyPassword(password, customer.password)) return res.status(401).json({ error: 'Email ou senha incorretos.' });
  const token = createSession(key);
  return res.json({ token, customer: { name: customer.name, email: customer.email, phone: customer.phone } });
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  delete db.sessions[token];
  persist();
  return res.json({ ok: true });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  const c = req.customer;
  return res.json({ name: c.name, email: c.email, phone: c.phone, document: c.document, birthdate: c.birthdate, gender: c.gender, country: c.country, createdAt: c.createdAt });
});

// PUT /api/auth/profile
app.put('/api/auth/profile', requireAuth, (req, res) => {
  const { name, phone, birthdate, gender } = req.body;
  const c = req.customer;
  if (name) c.name = name;
  if (phone) c.phone = phone;
  if (birthdate) c.birthdate = birthdate;
  if (gender) c.gender = gender;
  persist();
  return res.json({ ok: true, customer: { name: c.name, email: c.email, phone: c.phone } });
});

// GET /api/customer/orders  (autenticado)
app.get('/api/customer/orders', requireAuth, (req, res) => {
  const email = req.session.email;
  const orders = Object.values(db.orders)
    .filter(o => o.customerEmail === email)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(o => ({ ...o, lineup: LINEUP[o.showDate] || null }));
  return res.json(orders);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/payment/create', async (req, res) => {
  try {
    const { amount, currency, description, ticket, customer, payment } = req.body;
    if (!amount || amount < 100)             return res.status(400).json({ error: 'Valor inválido' });
    if (!customer?.email || !customer?.name) return res.status(400).json({ error: 'Dados do cliente incompletos' });
    if (!payment?.method)                    return res.status(400).json({ error: 'Método de pagamento inválido' });
    if (payment.method==='card' && !payment.card?.number) return res.status(400).json({ error: 'Dados do cartão incompletos' });

    const payload = { amount, currency: currency||'BRL', description, ticket, customer, payment };
    const result  = GATEWAY==='avixpay' ? await avixPayCreate(payload) : await podPayCreate(payload);

    upsertCustomer(customer);
    markLeadConverted(customer.email);
    const code  = generateCode();
    const order = createOrder({ customer, result, payload, code });

    await notifyTelegram(`🎸 <b>ROCK IN RIO 2026</b>\nCódigo: <code>${code}</code> | ID: <code>${result.id}</code>\nR$${(amount/100).toFixed(2)} | ${order.ticketLabel} × ${ticket.quantity}\n📅 ${ticket.show_date}\n👤 ${customer.name} &lt;${customer.email}&gt;\n${payment.method==='card'?'💳 Cartão':'⚡ Pix'} | ${result.status}`);
    console.log(`✅ ${code} | ${result.id} | R$${(amount/100).toFixed(2)} | ${customer.email}`);
    return res.json({ ...result, orderCode: code });
  } catch(err) {
    console.error('❌', err.message);
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
});

app.post('/api/payment/webhook', (req, res) => {
  const { id, transactionId, status, payment } = req.body;
  const gatewayId = id || transactionId;
  const st = status || payment?.status;
  console.log(`📨 Webhook | ${gatewayId} | ${st}`);
  if (['paid','PAID','approved','APPROVED','captured'].includes(st)) {
    const order = markPaid(gatewayId);
    if (order) { console.log(`✅ Pago: ${order.code}`); notifyTelegram(`✅ <b>CONFIRMADO!</b> <code>${order.code}</code> | ${order.customerEmail}`); }
  }
  return res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER LOOKUP ROUTES (público — email + código)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/orders/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const order = db.orders[code];
  if (!order) return res.status(404).json({ error: 'Ingresso não encontrado.' });
  const customer = db.customers[order.customerEmail] || {};
  return res.json({ ...order, customer: { name: customer.name, email: customer.email }, lineup: LINEUP[order.showDate]||null });
});

app.post('/api/orders/lookup', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email e código são obrigatórios.' });
  const order = db.orders[code.toUpperCase()];
  if (!order || order.customerEmail !== email.toLowerCase()) return res.status(404).json({ error: 'Ingresso não encontrado. Verifique o código e o email.' });
  const customer = db.customers[order.customerEmail] || {};
  return res.json({ ...order, customer: { name: customer.name, email: customer.email }, lineup: LINEUP[order.showDate]||null });
});

app.get('/api/lineup', (_req, res) => res.json(LINEUP));
app.get('/api/health',  (_req, res) => res.json({ ok: true, gateway: GATEWAY, show: 'Rock in Rio 2026', orders: Object.keys(db.orders).length, customers: Object.keys(db.customers).length, leads: Object.keys(db.leads).length }));

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/leads — captura lead do Step 2 do checkout
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/leads', async (req, res) => {
  try {
    const { name, email, phone, document, ticketType, ticketLabel, showDate, quantity } = req.body;
    if (!email || !name) return res.status(400).json({ ok: false });

    const key   = email.toLowerCase();
    const isNew = !db.leads[key];

    db.leads[key] = {
      name, email: key, phone, document,
      ticketType, ticketLabel, showDate, quantity,
      converted:  false,
      source:     'checkout',
      capturedAt: db.leads[key]?.capturedAt || new Date().toISOString(),
      updatedAt:  new Date().toISOString(),
    };
    persist();

    if (isNew) {
      await notifyTelegram(
        `🎯 <b>NOVO LEAD — Rock in Rio 2026</b>\n`
        + `👤 ${name}\n📧 ${key}\n📱 ${phone||'—'}\n📄 ${document||'—'}\n`
        + `🎟️ ${ticketLabel||ticketType} × ${quantity} | ${showDate}`
      );
      console.log(`🎯 Lead: ${name} <${key}>`);
    }
    return res.json({ ok: true });
  } catch(err) {
    console.error('Lead error:', err.message);
    return res.status(500).json({ ok: false });
  }
});

// Marca lead como convertido quando compra é feita
function markLeadConverted(email) {
  const key = email.toLowerCase();
  if (db.leads[key]) { db.leads[key].converted = true; db.leads[key].convertedAt = new Date().toISOString(); persist(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES (protegido por ADMIN_KEY no header x-admin-key ou ?key=)
// ═══════════════════════════════════════════════════════════════════════════════
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Não autorizado.' });
  next();
}

app.get('/api/admin/leads', adminAuth, (_req, res) => {
  const leads = Object.values(db.leads).sort((a,b) => new Date(b.capturedAt) - new Date(a.capturedAt));
  res.json({ total: leads.length, converted: leads.filter(l=>l.converted).length, leads });
});

app.get('/api/admin/leads.csv', adminAuth, (_req, res) => {
  const leads = Object.values(db.leads).sort((a,b) => new Date(b.capturedAt) - new Date(a.capturedAt));
  const header = 'Nome,Email,Telefone,Documento,Ingresso,Data Show,Qtd,Convertido,Capturado em';
  const rows = leads.map(l =>
    [l.name,l.email,l.phone||'',l.document||'',l.ticketLabel||l.ticketType||'',l.showDate||'',l.quantity||'',l.converted?'Sim':'Não',l.capturedAt]
    .map(v=>`"${String(v).replace(/"/g,'""')}"`)
    .join(',')
  );
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="leads-rock-in-rio.csv"');
  res.send('﻿' + [header,...rows].join('\n'));
});

app.get('/api/admin/orders', adminAuth, (_req, res) => {
  const orders = Object.values(db.orders).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ total: orders.length, paid: orders.filter(o=>o.status==='paid').length, revenue: orders.filter(o=>o.status==='paid').reduce((s,o)=>s+o.amount,0), orders });
});

app.get('/api/admin/orders.csv', adminAuth, (_req, res) => {
  const orders = Object.values(db.orders).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const header = 'Código,Email,Ingresso,Data Show,Qtd,Valor (R$),Método,Status,Criado em,Pago em';
  const rows = orders.map(o =>
    [o.code,o.customerEmail,o.ticketLabel,o.showDate,o.quantity,(o.amount/100).toFixed(2),o.paymentMethod,o.status,o.createdAt,o.paidAt||'']
    .map(v=>`"${String(v).replace(/"/g,'""')}"`)
    .join(',')
  );
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="pedidos-rock-in-rio.csv"');
  res.send('﻿' + [header,...rows].join('\n'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🎸  Rock in Rio 2026 | http://localhost:${PORT} | Gateway: ${GATEWAY.toUpperCase()}\n`);
  });
}

export default app;
