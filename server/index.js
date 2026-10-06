// Backend for metered (pay-as-you-go) USDT billing.
// Nothing here can move a user's money. Charges happen on chain, signed by the owner wallet in the
// admin panel; this server only reads the chain, verifies confirmed transactions, and books credits.
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { ethers } = require("ethers");
const { DatabaseSync } = require("node:sqlite");

const env = (k, d) => process.env[k] ?? d;
const need = (k) => {
  if (!process.env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
  return process.env[k];
};

const PORT = Number(env("PORT", 3000));
const RPC_URL = need("RPC_URL");
const CHAIN_ID = Number(need("CHAIN_ID"));
const USDT = ethers.getAddress(need("USDT_ADDRESS"));
const ENV_CONTRACT = process.env.CONTRACT_ADDRESS ? ethers.getAddress(process.env.CONTRACT_ADDRESS) : null;
let CONTRACT = null;
const CONFIRMATIONS = Number(env("CONFIRMATIONS", 5));
const ADMIN_PASSWORD = need("ADMIN_PASSWORD");
const SESSION_SECRET = need("SESSION_SECRET");
const DB_PATH = env("DB_PATH", path.join(__dirname, "..", "data", "app.db"));
if (ADMIN_PASSWORD.length < 10) console.warn("WARNING: ADMIN_PASSWORD is short; use 10+ characters.");

// ------------------------------------------------------------------ chain
const BILL_ABI = [
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function treasury() view returns (address)",
  "function maxPerCharge() view returns (uint256)",
  "function totalCharged(address) view returns (uint256)",
  "function stopped(address) view returns (bool)",
  "function remaining(address) view returns (uint256)",
  "event Charged(address indexed user, uint256 amount, uint256 totalCharged)",
  "event Stopped(address indexed user, address indexed by)",
  "event Resumed(address indexed user)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const billIface = new ethers.Interface(BILL_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
let bill = null;
let DECIMALS = 18;

async function useContract(address) {
  const a = ethers.getAddress(address);
  if ((await provider.getCode(a)) === "0x") throw new Error("No contract at " + a);
  const c = new ethers.Contract(a, BILL_ABI, provider);
  let token;
  try { token = await c.token(); await c.maxPerCharge(); } catch { throw new Error("That address is not a MeteredBilling contract"); }
  if (ethers.getAddress(token) !== USDT) throw new Error("That contract uses a different token than USDT_ADDRESS");
  CONTRACT = a;
  bill = c;
}

// ------------------------------------------------------------------ db
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    address TEXT PRIMARY KEY, limit_set TEXT NOT NULL DEFAULT '0', total_charged TEXT NOT NULL DEFAULT '0',
    stopped INTEGER NOT NULL DEFAULT 0, credits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
    address TEXT NOT NULL, amount TEXT NOT NULL, block INTEGER NOT NULL, charged_at INTEGER NOT NULL,
    UNIQUE (tx_hash, log_index));
  CREATE TABLE IF NOT EXISTS credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  INSERT OR IGNORE INTO settings (key, value) VALUES ('limits', '["50","200","1000"]');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('min_limit', '10');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('max_limit', '5000');
`);
const now = () => Math.floor(Date.now() / 1000);
const setting = (k) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value;
const setSetting = (k, v) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

function addCredits(address, delta, reason, ref) {
  db.prepare("INSERT OR IGNORE INTO accounts (address, created_at, updated_at) VALUES (?, ?, ?)").run(address, now(), now());
  db.prepare("UPDATE accounts SET credits = credits + ? WHERE address = ?").run(delta, address);
  db.prepare("INSERT INTO credit_ledger (address, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)").run(address, delta, reason, ref, now());
}

// Mirror a user's on-chain state (limit = allowance, total charged, stopped) into the db.
async function syncAccount(address) {
  const [allowance, charged, stopped] = await Promise.all([
    usdt.allowance(address, CONTRACT), bill.totalCharged(address), bill.stopped(address),
  ]);
  const existing = db.prepare("SELECT created_at FROM accounts WHERE address = ?").get(address);
  db.prepare(`INSERT INTO accounts (address, limit_set, total_charged, stopped, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET limit_set=excluded.limit_set, total_charged=excluded.total_charged,
        stopped=excluded.stopped, updated_at=excluded.updated_at`)
    .run(address, allowance.toString(), charged.toString(), stopped ? 1 : 0, existing?.created_at ?? now(), now());
  return db.prepare("SELECT * FROM accounts WHERE address = ?").get(address);
}

// Look up a transaction and apply any Charged events our contract emitted in it. Idempotent.
async function processTx(txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { status: "pending" };
  if (receipt.status !== 1) return { status: "failed" };
  const head = await provider.getBlockNumber();
  const confirmations = head - receipt.blockNumber + 1;
  if (confirmations < CONFIRMATIONS) return { status: "confirming", confirmations, required: CONFIRMATIONS };

  const ours = receipt.logs.filter((l) => l.address.toLowerCase() === CONTRACT.toLowerCase());
  if (!ours.length) return { status: "ignored", reason: "No event from the billing contract in this transaction." };

  const transfers = receipt.logs
    .filter((l) => l.address.toLowerCase() === USDT.toLowerCase())
    .map((l) => { try { return erc20Iface.parseLog(l); } catch { return null; } })
    .filter((p) => p && p.name === "Transfer");

  const block = await provider.getBlock(receipt.blockNumber);
  const touched = new Set();
  let newCharges = 0;

  for (const log of ours) {
    let ev;
    try { ev = billIface.parseLog(log); } catch { continue; }
    if (!ev || !ev.args.user) continue;
    const user = ethers.getAddress(ev.args.user);
    touched.add(user);
    if (ev.name !== "Charged") continue;

    const amount = ev.args.amount;
    const paid = transfers.some((t) => ethers.getAddress(t.args.from) === user && t.args.value === amount);
    if (!paid) continue; // a Charged event with no matching USDT transfer: never record

    const ins = db.prepare(`INSERT OR IGNORE INTO charges (tx_hash, log_index, address, amount, block, charged_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(receipt.hash, log.index, user, amount.toString(), receipt.blockNumber, block.timestamp);
    if (ins.changes) newCharges += 1;
  }
  for (const u of touched) await syncAccount(u);
  return { status: "confirmed", newCharges, users: [...touched] };
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
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' " +
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

const hits = new Map();
const limit = (name, max, windowMs) => (req, res, next) => {
  const key = name + ":" + req.ip, t = Date.now(), h = hits.get(key);
  if (!h || t - h.start > windowMs) hits.set(key, { start: t, n: 1 });
  else if (++h.n > max) return res.status(429).json({ error: "Too many requests, try again shortly." });
  next();
};
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (t - h.start > 3600e3) hits.delete(k); }, 600e3).unref();

const limits = () => { try { return JSON.parse(setting("limits")); } catch { return []; } };

// Only login + setup endpoints work until a contract is configured.
app.use("/api", (req, res, next) => {
  if (bill || ["/config", "/admin/login", "/admin/overview", "/admin/artifact", "/admin/contract"].includes(req.path)) return next();
  res.status(503).json({ error: "Setup is not finished yet." });
});

app.get("/api/config", wrap(async (req, res) => {
  if (!bill) return res.json({ setup: true, chainId: CHAIN_ID, limits: [] });
  const [treasury, maxPer] = await Promise.all([bill.treasury(), bill.maxPerCharge()]);
  res.json({
    chainId: CHAIN_ID, usdt: USDT, contract: CONTRACT, treasury, decimals: DECIMALS, confirmations: CONFIRMATIONS,
    explorer: env("EXPLORER_URL", CHAIN_ID === 56 ? "https://bscscan.com" : ""),
    limits: limits(), minLimit: setting("min_limit"), maxLimit: setting("max_limit"),
    maxPerCharge: maxPer.toString(),
  });
}));

// Called by the page after a user approves, so the account appears in the admin panel.
app.post("/api/activate", limit("act", 60, 60e3), wrap(async (req, res) => {
  const a = addr(req.body?.address);
  if (!a) return res.status(400).json({ error: "Bad address" });
  res.json({ account: await syncAccount(a) }); // reads the real allowance on chain, never trusts the body
}));

app.get("/api/account/:address", limit("acct", 120, 60e3), wrap(async (req, res) => {
  const a = addr(req.params.address);
  if (!a) return res.status(400).json({ error: "Bad address" });
  const [acct, remaining, balance] = await Promise.all([syncAccount(a), bill.remaining(a), usdt.balanceOf(a)]);
  const charges = db.prepare("SELECT tx_hash, amount, charged_at FROM charges WHERE address = ? ORDER BY id DESC LIMIT 50").all(a);
  res.json({
    address: a, credits: acct.credits, limit: acct.limit_set, used: acct.total_charged,
    remaining: remaining.toString(), stopped: !!acct.stopped, balance: balance.toString(), charges,
  });
}));

app.post("/api/verify", limit("verify", 60, 60e3), wrap(async (req, res) => {
  const h = req.body?.txHash;
  if (typeof h !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h)) return res.status(400).json({ error: "Bad tx hash" });
  res.json(await processTx(h));
}));

// ------------------------------------------------------------------ admin
const sign = (p) => crypto.createHmac("sha256", SESSION_SECRET).update(p).digest("hex");
const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
app.post("/api/admin/login", limit("login", 8, 15 * 60e3), (req, res) => {
  if (!safeEq(String(req.body?.password ?? "").trim(), ADMIN_PASSWORD.trim())) return res.status(401).json({ error: "Wrong password" });
  const exp = String(Date.now() + 8 * 3600e3);
  res.json({ token: `${exp}.${sign(exp)}` });
});
const admin = (req, res, next) => {
  const [exp, sig] = String(req.headers.authorization || "").replace(/^Bearer /, "").split(".");
  if (!exp || !sig || !safeEq(sig, sign(exp)) || Number(exp) < Date.now()) return res.status(401).json({ error: "Login required" });
  next();
};

app.get("/api/admin/artifact", admin, (req, res) => res.json(require("../artifacts/MeteredBilling.json")));

app.post("/api/admin/contract", admin, wrap(async (req, res) => {
  if (ENV_CONTRACT) return res.status(409).json({ error: "CONTRACT_ADDRESS is set in the environment; change it there." });
  if (bill && db.prepare("SELECT 1 FROM charges LIMIT 1").get()) return res.status(409).json({ error: "This site already has charges on its current contract." });
  const a = addr(req.body?.address);
  if (!a) return res.status(400).json({ error: "Bad address" });
  try { await useContract(a); } catch (e) { return res.status(400).json({ error: e.message }); }
  setSetting("contract", a);
  res.json({ ok: true, contract: a });
}));

app.get("/api/admin/overview", admin, wrap(async (req, res) => {
  if (!bill) return res.json({ setupNeeded: true, chainId: CHAIN_ID, usdt: USDT, decimals: DECIMALS });
  const [owner, treasury, maxPer] = await Promise.all([bill.owner(), bill.treasury(), bill.maxPerCharge()]);
  const total = db.prepare("SELECT amount FROM charges").all().reduce((s, r) => s + BigInt(r.amount), 0n);
  res.json({
    chainId: CHAIN_ID, contract: CONTRACT, contractInEnv: !!ENV_CONTRACT, usdt: USDT, decimals: DECIMALS,
    owner, treasury, maxPerCharge: maxPer.toString(), now: now(),
    explorer: env("EXPLORER_URL", CHAIN_ID === 56 ? "https://bscscan.com" : ""),
    limits: limits(), minLimit: setting("min_limit"), maxLimit: setting("max_limit"),
    totalReceived: total.toString(),
    accounts: db.prepare("SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 500").all(),
    charges: db.prepare("SELECT * FROM charges ORDER BY id DESC LIMIT 500").all(),
    ledger: db.prepare("SELECT * FROM credit_ledger ORDER BY id DESC LIMIT 200").all(),
  });
}));

app.put("/api/admin/settings", admin, wrap(async (req, res) => {
  const body = req.body || {};
  const parse = (v) => { try { if (ethers.parseUnits(String(v), DECIMALS) < 0n) throw 0; return String(v); } catch { return null; } };
  if (body.limits !== undefined) {
    if (!Array.isArray(body.limits) || body.limits.some((v) => parse(v) === null)) return res.status(400).json({ error: "Spending limits must be a list of USDT amounts." });
    setSetting("limits", JSON.stringify(body.limits.map(String).slice(0, 8)));
  }
  if (body.minLimit !== undefined) { const v = parse(body.minLimit); if (v === null) return res.status(400).json({ error: "Bad minimum limit" }); setSetting("min_limit", v); }
  if (body.maxLimit !== undefined) { const v = parse(body.maxLimit); if (v === null) return res.status(400).json({ error: "Bad maximum limit" }); setSetting("max_limit", v); }
  res.json({ ok: true });
}));

app.post("/api/admin/credits/adjust", admin, wrap(async (req, res) => {
  const a = addr(req.body?.address);
  const delta = Number(req.body?.delta);
  const reason = String(req.body?.reason ?? "").trim().slice(0, 120);
  if (!a || !Number.isInteger(delta) || delta === 0 || !reason) return res.status(400).json({ error: "Address, a non-zero whole number and a reason are required" });
  const cur = db.prepare("SELECT credits FROM accounts WHERE address = ?").get(a)?.credits ?? 0;
  if (cur + delta < 0) return res.status(400).json({ error: "Credits cannot go below zero" });
  addCredits(a, delta, "admin: " + reason, "");
  res.json({ ok: true });
}));

app.post("/api/admin/sync/:address", admin, wrap(async (req, res) => {
  const a = addr(req.params.address);
  if (!a) return res.status(400).json({ error: "Bad address" });
  res.json({ account: await syncAccount(a) });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

(async () => {
  const net = await new ethers.JsonRpcProvider(RPC_URL).getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`RPC is chain ${net.chainId}, .env says ${CHAIN_ID}`);
  DECIMALS = Number(await usdt.decimals());
  const saved = ENV_CONTRACT || setting("contract");
  if (saved) await useContract(saved);
  app.listen(PORT, () => console.log(`listening on :${PORT} chain ${CHAIN_ID} ` + (CONTRACT ? `contract ${CONTRACT}` : "SETUP MODE: deploy the contract from /admin.html")));
})().catch((e) => {
  console.error("Startup failed:", e.message);
  process.exit(1);
});
