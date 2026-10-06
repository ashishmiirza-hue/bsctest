// End-to-end check on a local chain: metered-billing contract rules + backend verification.
// Run with `npm test`. Pass --keep to leave the chain + server up for browser testing.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { ethers } = require("ethers");

const root = path.join(__dirname, "..");
const art = (n) => require(`../artifacts/${n}.json`);
const RPC = "http://127.0.0.1:8545";
const API = "http://127.0.0.1:3999";
const KEEP = process.argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? "  PASS  " : "  FAIL  ") + name); };
const reverts = async (p, name) => { try { await (await p).wait(); ok(false, name); } catch { ok(true, name); } };
const U = (n) => ethers.parseUnits(String(n), 18);

async function waitFor(fn, label) { for (let i = 0; i < 100; i++) { try { return await fn(); } catch { await sleep(300); } } throw new Error("timeout: " + label); }
const call = async (p, method = "GET", body, token) => {
  const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token || "") }, body: body ? JSON.stringify(body) : undefined });
  return { code: r.status, ...(await r.json()) };
};
const verify = async (txHash) => { for (let i = 0; i < 40; i++) { const r = await call("/api/verify", "POST", { txHash }); if (r.status !== "confirming") return r; await sleep(150); } };

(async () => {
  procs.push(spawn("npx", ["hardhat", "node"], { cwd: root, stdio: "ignore" }));
  const provider = new ethers.JsonRpcProvider(RPC, 31337, { staticNetwork: true, cacheTimeout: -1 });
  await waitFor(() => provider.getBlockNumber(), "chain");
  const [owner, treasury, alice, bob, carol] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const M = art("MockUSDT"), B = art("MeteredBilling");
  const usdt = await new ethers.ContractFactory(M.abi, M.bytecode, owner).deploy();
  await usdt.waitForDeployment();
  const bill = await new ethers.ContractFactory(B.abi, B.bytecode, owner).deploy(await usdt.getAddress(), treasury.address);
  await bill.waitForDeployment();
  const billAddr = await bill.getAddress();

  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "credits-")), "test.db");
  procs.push(spawn("node", ["--no-warnings", "server/index.js"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, PORT: "3999", RPC_URL: RPC, CHAIN_ID: "31337", USDT_ADDRESS: await usdt.getAddress(), CONTRACT_ADDRESS: billAddr,
      CONFIRMATIONS: "1", ADMIN_PASSWORD: "test-password-123", SESSION_SECRET: "test-secret", DB_PATH: dbPath, CSP_CONNECT: RPC },
  }));
  await waitFor(async () => { const r = await fetch(API + "/api/config"); if (!r.ok) throw 0; }, "server");

  console.log("\nAdmin + config");
  ok((await call("/api/admin/overview")).code === 401, "admin API needs login");
  const { token } = await call("/api/admin/login", "POST", { password: "test-password-123" });
  ok((await call("/api/admin/login", "POST", { password: "x" })).code === 401, "wrong password rejected");
  ok((await call("/api/admin/settings", "PUT", { limits: ["50", "200", "1000"], minLimit: "10", maxLimit: "5000" }, token)).ok, "admin sets spending-limit tiers");
  const cfg = await call("/api/config");
  ok(JSON.stringify(cfg.limits) === JSON.stringify(["50", "200", "1000"]) && cfg.minLimit === "10", "public config shows limits and minimum");

  console.log("\nAuthorize (approve a limit, nothing charged)");
  await (await usdt.mint(alice.address, U(500))).wait();
  await (await usdt.connect(alice).approve(billAddr, U(200))).wait(); // Alice sets a 200 limit
  const act = await call("/api/activate", "POST", { address: alice.address });
  ok(act.account.limit_set === U(200).toString() && act.account.total_charged === "0", "activate records limit 200, nothing charged");
  ok((await usdt.balanceOf(treasury.address)) === 0n, "treasury still empty after authorizing");
  let acct = await call("/api/account/" + alice.address);
  ok(acct.limit === U(200).toString() && acct.remaining === U(200).toString() && acct.used === "0", "account shows full limit remaining");

  console.log("\nCharging usage (admin)");
  await reverts(bill.connect(bob).charge(alice.address, U(10)), "non-owner cannot charge");
  await reverts(bill.charge(alice.address, 0), "zero charge rejected");
  const c1 = await bill.charge(alice.address, U(30));
  await c1.wait();
  ok((await usdt.balanceOf(treasury.address)) === U(30), "treasury received exactly the charged 30 USDT");
  let v = await verify(c1.hash);
  ok(v.status === "confirmed" && v.newCharges === 1, "backend verified the charge");
  acct = await call("/api/account/" + alice.address);
  ok(acct.used === U(30).toString() && acct.remaining === U(170).toString(), "used 30, 170 left before the limit");
  ok((await verify(c1.hash)).newCharges === 0, "replaying the same charge records nothing");

  console.log("\nThe limit is a hard ceiling");
  await reverts(bill.charge(alice.address, U(171)), "cannot charge more than the remaining limit");
  const c2 = await bill.charge(alice.address, U(170));
  await c2.wait();
  await verify(c2.hash);
  acct = await call("/api/account/" + alice.address);
  ok(acct.remaining === "0" && acct.used === U(200).toString(), "charged up to the limit, nothing left");
  await reverts(bill.charge(alice.address, U(1)), "no charge possible once the limit is used up");
  ok((await usdt.balanceOf(treasury.address)) === U(200) && (await usdt.balanceOf(alice.address)) === U(300), "total taken equals the limit Alice set");

  console.log("\nRaising the limit is only the user's choice");
  ok(!bill.interface.fragments.some((f) => f.name === "setLimit" || f.name === "raiseCap"), "contract has no owner function to raise a user's limit");
  await (await usdt.connect(alice).approve(billAddr, U(100))).wait(); // Alice approves fresh headroom herself
  ok((await call("/api/account/" + alice.address)).remaining === U(100).toString(), "after the user approves more, 100 is chargeable again");

  console.log("\nPer-charge safety cap");
  await (await bill.setMaxPerCharge(U(25))).wait();
  await reverts(bill.charge(alice.address, U(40)), "charge over maxPerCharge rejected");
  const c3 = await bill.charge(alice.address, U(25));
  await c3.wait(); await verify(c3.hash);
  ok((await call("/api/account/" + alice.address)).used === U(225).toString(), "a charge within maxPerCharge works");
  await (await bill.setMaxPerCharge(0)).wait();

  console.log("\nUser can stop billing");
  await (await usdt.mint(bob.address, U(100))).wait();
  await (await usdt.connect(bob).approve(billAddr, U(50))).wait();
  await call("/api/activate", "POST", { address: bob.address });
  await (await bill.connect(bob).stop()).wait();
  await reverts(bill.charge(bob.address, U(10)), "no charge after the user stops, even with allowance left");
  let b = await call("/api/account/" + bob.address);
  ok(b.stopped === true && b.remaining === "0", "backend shows billing stopped, remaining 0");
  await (await bill.connect(bob).resume()).wait();
  const c4 = await bill.charge(bob.address, U(10));
  await c4.wait(); await verify(c4.hash);
  ok((await call("/api/account/" + bob.address)).used === U(10).toString(), "after resume, charging works again");

  console.log("\nAdmin stop + fake transactions");
  await (await bill.stopFor(bob.address)).wait();
  await reverts(bill.charge(bob.address, U(1)), "admin stopFor blocks charging");
  const direct = await usdt.connect(carol).transfer(treasury.address, 0);
  await direct.wait();
  ok((await verify(direct.hash)).status === "ignored", "a tx that never touched the contract is ignored");
  ok((await call("/api/verify", "POST", { txHash: "0x1234" })).code === 400, "malformed tx hash rejected");

  console.log("\nCredits ledger (separate from USDT)");
  ok((await call("/api/admin/credits/adjust", "POST", { address: alice.address, delta: 1000, reason: "top-up" }, token)).ok, "admin adds credits");
  ok((await call("/api/admin/credits/adjust", "POST", { address: alice.address, delta: -5000, reason: "x" }, token)).code === 400, "credits cannot go below zero");
  ok((await call("/api/account/" + alice.address)).credits === 1000, "credits balance updates");

  console.log("\nContract hardening");
  await reverts(new ethers.ContractFactory(B.abi, B.bytecode, owner).deploy(alice.address, treasury.address).then((c) => c.deploymentTransaction()), "deploy with a non-contract token fails");
  await reverts(bill.connect(alice).proposeTreasury(alice.address), "non-owner cannot propose treasury");
  await (await bill.proposeTreasury(carol.address)).wait();
  await reverts(bill.applyTreasury(), "treasury change blocked before 2 days");
  await provider.send("evm_increaseTime", [2 * 86400 + 1]); await provider.send("evm_mine", []);
  await (await bill.applyTreasury()).wait();
  ok((await bill.treasury()) === carol.address, "treasury changes after the 2-day delay");

  const ov = await call("/api/admin/overview", "GET", null, token);
  ok(ov.totalReceived === U(235).toString() && ov.accounts.length === 2 && ov.charges.length === 4, "overview totals are correct");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (KEEP) { console.log(JSON.stringify({ api: API, rpc: RPC, usdt: await usdt.getAddress(), contract: billAddr })); return; }
  procs.forEach((p) => p.kill());
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); procs.forEach((p) => p.kill()); process.exit(1); });
