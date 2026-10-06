// Backend: public config, eligibility, on-chain payment verification, credits, admin API.
// Credits are only ever granted from events emitted by CONTRACT_ADDRESS in a confirmed,
// successful transaction. Nothing the browser sends is trusted except a tx hash to look up.
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { ethers } = require("ethers");
const { DatabaseSync } = require("node:sqlite");

const env = (k, d) => process.env[k] ?? d;
const need = (k) => {
  if (!process.env[k]) {
    console.error(`Missing ${k} in .env`);
    process.exit(1);
  }
  return process.env[k];
};

const PORT = Number(env("PORT", 3000));
const RPC_URL = need("RPC_URL");
const CHAIN_ID = Number(need("CHAIN_ID"));
const USDT = ethers.getAddress(need("USDT_ADDRESS"));
const CONTRACT = ethers.getAddress(need("CONTRACT_ADDRESS"));
const CONFIRMATIONS = Number(env("CONFIRMATIONS", 5));
const ADMIN_PASSWORD = need("ADMIN_PASSWORD");
const SESSION_SECRET = need("SESSION_SECRET");
const DB_PATH = env("DB_PATH", path.join(__dirname, "..", "data", "app.db"));
if (ADMIN_PASSWORD.length < 10) console.warn("WARNING: ADMIN_PASSWORD is short; use 10+ characters.");

// ------------------------------------------------------------------ chain
const SUB_ABI = [
  "function owner() view returns (address)",
  "function treasury() view returns (address)",
  "function minPeriod() view returns (uint32)",
  "function planCount() view returns (uint256)",
  "function plans(uint256) view returns (uint128 price, uint32 period, uint16 maxCharges, bool active)",
  "function subs(address) view returns (uint32 planId, uint128 price, uint32 period, uint16 maxCharges, uint16 charges, uint64 nextChargeAt, bool active)",
  "event PlanCreated(uint256 indexed planId, uint256 price, uint256 period, uint256 maxCharges)",
  "event PlanStatus(uint256 indexed planId, bool active)",
  "event Subscribed(address indexed user, uint256 indexed planId, uint256 price, uint256 period, uint256 maxCharges, uint256 nextChargeAt)",
  "event Charged(address indexed user, uint256 indexed planId, uint256 amount, uint256 chargeNo, uint256 nextChargeAt)",
  "event Cancelled(address indexed user, address indexed by)",
  "event Completed(address indexed user)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const sub = new ethers.Contract(CONTRACT, SUB_ABI, provider);
const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
const erc20Iface = new ethers.Interface(ERC20_ABI);
let DECIMALS = 18;

// ------------------------------------------------------------------ db
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plans (
    plan_id INTEGER PRIMARY KEY, name TEXT NOT NULL, credits INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS users (
    address TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
    address TEXT NOT NULL, plan_id INTEGER NOT NULL, amount TEXT NOT NULL, kind TEXT NOT NULL,
    credits INTEGER NOT NULL, block INTEGER NOT NULL, paid_at INTEGER NOT NULL,
    UNIQUE (tx_hash, log_index));
  CREATE TABLE IF NOT EXISTS subscriptions (
    address TEXT PRIMARY KEY, plan_id INTEGER NOT NULL, price TEXT NOT NULL, period INTEGER NOT NULL,
    max_charges INTEGER NOT NULL, charges INTEGER NOT NULL, next_charge_at INTEGER NOT NULL,
    status TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  INSERT OR IGNORE INTO settings (key, value) VALUES ('min_balance', '0');
`);
const now = () => Math.floor(Date.now() / 1000);
const setting = (k) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value;

function addCredits(address, delta, reason, ref) {
  db.prepare("INSERT OR IGNORE INTO users (address, credits, created_at) VALUES (?, 0, ?)").run(address, now());
  db.prepare("UPDATE users SET credits = credits + ? WHERE address = ?").run(delta, address);
  db.prepare("INSERT INTO credit_ledger (address, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(address, delta, reason, ref, now());
}

// ------------------------------------------------------------------ chain helpers
let planCache = { at: 0, list: [] };
async function chainPlans(force) {
  if (!force && Date.now() - planCache.at < 15000) return planCache.list;
  const n = Number(await sub.planCount());
  const rows = await Promise.all([...Array(n).keys()].map((i) => sub.plans(i)));
  const list = rows.map((p, i) => ({
    planId: i,
    price: p.price.toString(),
    period: Number(p.period),
    maxCharges: Number(p.maxCharges),
    cap: (p.price * p.maxCharges).toString(),
    active: p.active,
  }));
  planCache = { at: Date.now(), list };
  return list;
}

async function mergedPlans(force) {
  const meta = new Map(db.prepare("SELECT * FROM plans").all().map((r) => [r.plan_id, r]));
  return (await chainPlans(force)).map((p) => {
    const m = meta.get(p.planId);
    return { ...p, name: m?.name ?? "", credits: m?.credits ?? 0, description: m?.description ?? "" };
  });
}

// Mirror the on-chain subscription of one address into the database.
async function syncSub(address) {
  const s = await sub.subs(address);
  if (Number(s.period) === 0) return null;
  const status = s.active ? "active" : Number(s.charges) >= Number(s.maxCharges) ? "completed" : "cancelled";
  db.prepare(`INSERT INTO subscriptions
      (address, plan_id, price, period, max_charges, charges, next_charge_at, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET plan_id=excluded.plan_id, price=excluded.price, period=excluded.period,
        max_charges=excluded.max_charges, charges=excluded.charges, next_charge_at=excluded.next_charge_at,
        status=excluded.status, updated_at=excluded.updated_at`)
    .run(address, Number(s.planId), s.price.toString(), Number(s.period), Number(s.maxCharges),
      Number(s.charges), Number(s.nextChargeAt), status, now());
  return db.prepare("SELECT * FROM subscriptions WHERE address = ?").get(address);
}

// Look a transaction up on chain and apply whatever our contract emitted in it. Idempotent.
async function processTx(txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { status: "pending" };
  if (receipt.status !== 1) return { status: "failed" };
  const head = await provider.getBlockNumber();
  const confirmations = head - receipt.blockNumber + 1;
  if (confirmations < CONFIRMATIONS) return { status: "confirming", confirmations, required: CONFIRMATIONS };

  const ours = receipt.logs.filter((l) => l.address.toLowerCase() === CONTRACT.toLowerCase());
  if (!ours.length) return { status: "ignored", reason: "No event from the subscription contract in this transaction." };

  // Token movements in the same transaction, used as a second check on every payment event.
  const transfers = receipt.logs
    .filter((l) => l.address.toLowerCase() === USDT.toLowerCase())
    .map((l) => { try { return erc20Iface.parseLog(l); } catch { return null; } })
    .filter((p) => p && p.name === "Transfer");

  const block = await provider.getBlock(receipt.blockNumber);
  const plans = new Map(db.prepare("SELECT * FROM plans").all().map((r) => [r.plan_id, r]));
  const touched = new Set();
  let credited = 0;
  let payments = 0;

  for (const log of ours) {
    let ev;
    try { ev = sub.interface.parseLog(log); } catch { continue; }
    if (!ev) continue;
    if (ev.name === "PlanCreated" || ev.name === "PlanStatus") { planCache.at = 0; continue; }
    if (!ev.args.user) continue;
    const user = ethers.getAddress(ev.args.user);
    touched.add(user);
    if (ev.name !== "Subscribed" && ev.name !== "Charged") continue;

    const amount = ev.name === "Subscribed" ? ev.args.price : ev.args.amount;
    const paid = transfers.some((t) => ethers.getAddress(t.args.from) === user && t.args.value === amount);
    if (!paid) continue; // event without the matching token transfer: never credit

    const planId = Number(ev.args.planId);
    const credits = plans.get(planId)?.credits ?? 0;
    db.exec("BEGIN");
    try {
      const ins = db.prepare(`INSERT OR IGNORE INTO payments
          (tx_hash, log_index, address, plan_id, amount, kind, credits, block, paid_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receipt.hash, log.index, user, planId, amount.toString(),
          ev.name === "Subscribed" ? "first" : "renewal", credits, receipt.blockNumber, block.timestamp);
      if (ins.changes) {
        payments += 1;
        credited += credits;
        addCredits(user, credits, ev.name === "Subscribed" ? "subscription" : "renewal", receipt.hash);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  for (const u of touched) await syncSub(u);
  return { status: "confirmed", newPayments: payments, credited, users: [...touched] };
}

// ------------------------------------------------------------------ http
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' " +
      env("CSP_CONNECT", "") + "; frame-ancestors 'none'");
  next();
});
app.use("/vendor", express.static(path.join(__dirname, "..", "node_modules", "ethers", "dist"), { maxAge: "7d" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(req.method, req.path, e.shortMessage || e.message);
  res.status(500).json({ error: "Server error" });
});
const addr = (v) => (typeof v === "string" && ethers.isAddress(v) ? ethers.getAddress(v) : null);

// very small fixed-window rate limiter
const hits = new Map();
const limit = (name, max, windowMs) => (req, res, next) => {
  const key = name + ":" + req.ip;
  const t = Date.now();
  const h = hits.get(key);
  if (!h || t - h.start > windowMs) hits.set(key, { start: t, n: 1 });
  else if (++h.n > max) return res.status(429).json({ error: "Too many requests, try again shortly." });
  next();
};
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (t - h.start > 3600e3) hits.delete(k); }, 600e3).unref();

app.get("/api/config", wrap(async (req, res) => {
  const [treasury, plans] = await Promise.all([sub.treasury(), mergedPlans()]);
  res.json({
    chainId: CHAIN_ID,
    usdt: USDT,
    contract: CONTRACT,
    treasury,
    decimals: DECIMALS,
    confirmations: CONFIRMATIONS,
    minBalance: setting("min_balance"),
    explorer: env("EXPLORER_URL", CHAIN_ID === 56 ? "https://bscscan.com" : ""),
    plans: plans.filter((p) => p.active && p.credits > 0),
  });
}));

app.get("/api/eligibility/:address", limit("elig", 60, 60e3), wrap(async (req, res) => {
  const a = addr(req.params.address);
  if (!a) return res.status(400).json({ error: "Bad address" });
  const balance = await usdt.balanceOf(a); // read by the server, not reported by the browser
  const min = ethers.parseUnits(setting("min_balance") || "0", DECIMALS);
  const plan = (await mergedPlans()).find((p) => String(p.planId) === String(req.query.planId));
  const required = plan && BigInt(plan.price) > min ? BigInt(plan.price) : min;
  res.json({
    address: a,
    balance: balance.toString(),
    minBalance: min.toString(),
    required: required.toString(),
    eligible: balance >= required,
  });
}));

app.get("/api/account/:address", limit("acct", 120, 60e3), wrap(async (req, res) => {
  const a = addr(req.params.address);
  if (!a) return res.status(400).json({ error: "Bad address" });
  const user = db.prepare("SELECT credits FROM users WHERE address = ?").get(a);
  const subscription = await syncSub(a);
  const payments = db.prepare("SELECT tx_hash, plan_id, amount, kind, credits, paid_at FROM payments WHERE address = ? ORDER BY id DESC LIMIT 50").all(a);
  res.json({ address: a, credits: user?.credits ?? 0, subscription, payments });
}));

app.post("/api/verify", limit("verify", 60, 60e3), wrap(async (req, res) => {
  const h = req.body?.txHash;
  if (typeof h !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h)) return res.status(400).json({ error: "Bad tx hash" });
  res.json(await processTx(h));
}));

// ------------------------------------------------------------------ admin
const sign = (payload) => crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
app.post("/api/admin/login", limit("login", 8, 15 * 60e3), (req, res) => {
  if (!safeEq(req.body?.password ?? "", ADMIN_PASSWORD)) return res.status(401).json({ error: "Wrong password" });
  const exp = String(Date.now() + 8 * 3600e3);
  res.json({ token: `${exp}.${sign(exp)}` });
});
const admin = (req, res, next) => {
  const [exp, sig] = String(req.headers.authorization || "").replace(/^Bearer /, "").split(".");
  if (!exp || !sig || !safeEq(sig, sign(exp)) || Number(exp) < Date.now()) return res.status(401).json({ error: "Login required" });
  next();
};

app.get("/api/admin/overview", admin, wrap(async (req, res) => {
  const [owner, treasury, minPeriod, plans] = await Promise.all([sub.owner(), sub.treasury(), sub.minPeriod(), mergedPlans(true)]);
  const total = db.prepare("SELECT amount FROM payments").all().reduce((s, r) => s + BigInt(r.amount), 0n);
  res.json({
    chainId: CHAIN_ID, contract: CONTRACT, usdt: USDT, decimals: DECIMALS, owner, treasury,
    minPeriod: Number(minPeriod), minBalance: setting("min_balance"), now: now(),
    explorer: env("EXPLORER_URL", CHAIN_ID === 56 ? "https://bscscan.com" : ""),
    plans,
    totalReceived: total.toString(),
    users: db.prepare("SELECT address, credits, created_at FROM users ORDER BY created_at DESC LIMIT 500").all(),
    subscriptions: db.prepare("SELECT * FROM subscriptions ORDER BY (status = 'active') DESC, next_charge_at ASC LIMIT 500").all(),
    payments: db.prepare("SELECT * FROM payments ORDER BY id DESC LIMIT 500").all(),
    ledger: db.prepare("SELECT * FROM credit_ledger ORDER BY id DESC LIMIT 200").all(),
  });
}));

app.put("/api/admin/settings", admin, wrap(async (req, res) => {
  const v = String(req.body?.minBalance ?? "").trim();
  try { if (ethers.parseUnits(v, DECIMALS) < 0n) throw 0; } catch { return res.status(400).json({ error: "Minimum balance must be a number like 25 or 25.5" }); }
  db.prepare("UPDATE settings SET value = ? WHERE key = 'min_balance'").run(v);
  res.json({ ok: true });
}));

// Name + credits for a plan that already exists on chain.
app.put("/api/admin/plans/:id", admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  const description = String(req.body?.description ?? "").trim().slice(0, 200);
  const credits = Number(req.body?.credits);
  const exists = (await chainPlans(true)).some((p) => p.planId === id);
  if (!exists) return res.status(404).json({ error: "Plan is not on chain yet" });
  if (!name || !Number.isInteger(credits) || credits < 0 || credits > 1e12) return res.status(400).json({ error: "Name and a whole number of credits are required" });
  db.prepare(`INSERT INTO plans (plan_id, name, credits, description) VALUES (?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET name=excluded.name, credits=excluded.credits, description=excluded.description`)
    .run(id, name, credits, description);
  res.json({ ok: true });
}));

app.post("/api/admin/credits/adjust", admin, wrap(async (req, res) => {
  const a = addr(req.body?.address);
  const delta = Number(req.body?.delta);
  const reason = String(req.body?.reason ?? "").trim().slice(0, 120);
  if (!a || !Number.isInteger(delta) || delta === 0 || !reason) return res.status(400).json({ error: "Address, a non-zero whole number and a reason are required" });
  const cur = db.prepare("SELECT credits FROM users WHERE address = ?").get(a)?.credits ?? 0;
  if (cur + delta < 0) return res.status(400).json({ error: "Balance cannot go below zero" });
  addCredits(a, delta, "admin: " + reason, "");
  res.json({ ok: true });
}));

app.post("/api/admin/sync/:address", admin, wrap(async (req, res) => {
  const a = addr(req.params.address);
  if (!a) return res.status(400).json({ error: "Bad address" });
  res.json({ subscription: await syncSub(a) });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

(async () => {
  const net = await new ethers.JsonRpcProvider(RPC_URL).getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`RPC is chain ${net.chainId}, .env says ${CHAIN_ID}`);
  if ((await provider.getCode(CONTRACT)) === "0x") throw new Error("No contract at CONTRACT_ADDRESS");
  DECIMALS = Number(await usdt.decimals());
  app.listen(PORT, () => console.log(`listening on :${PORT} chain ${CHAIN_ID} contract ${CONTRACT}`));
})().catch((e) => {
  console.error("Startup failed:", e.message);
  process.exit(1);
});
