// End-to-end check on a local chain: contract rules + backend verification + credits.
// Run with `npm test` (starts its own chain and server; needs `npm run compile` first).
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { ethers } = require("ethers");

const root = path.join(__dirname, "..");
const art = (n) => require(`../artifacts/${n}.json`);
const RPC = "http://127.0.0.1:8545";
const API = "http://127.0.0.1:3999";
const KEEP = process.argv.includes("--keep"); // leave chain + server running for manual/browser testing
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? "  PASS  " : "  FAIL  ") + name); };
const reverts = async (p, name) => { try { await (await p).wait(); ok(false, name); } catch { ok(true, name); } };
const U = (n) => ethers.parseUnits(String(n), 18);

async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) { try { return await fn(); } catch { await sleep(300); } }
  throw new Error("timeout: " + label);
}
const call = async (p, method = "GET", body, token) => {
  const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token || "") }, body: body ? JSON.stringify(body) : undefined });
  return { code: r.status, ...(await r.json()) };
};

// like the web page: poll until the backend has seen enough confirmations
const verify = async (txHash) => {
  for (let i = 0; i < 40; i++) {
    const r = await call("/api/verify", "POST", { txHash });
    if (r.status !== "confirming") return r;
    await sleep(150);
  }
};

(async () => {
  procs.push(spawn("npx", ["hardhat", "node"], { cwd: root, stdio: "ignore" }));
  const provider = new ethers.JsonRpcProvider(RPC, 31337, { staticNetwork: true, cacheTimeout: -1 });
  await waitFor(() => provider.getBlockNumber(), "chain");
  const [owner, treasury, alice, bob, carol] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const M = art("MockUSDT"), S = art("CreditSubscriptions");
  const usdt = await new ethers.ContractFactory(M.abi, M.bytecode, owner).deploy();
  await usdt.waitForDeployment();
  const sub = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(await usdt.getAddress(), treasury.address, 60);
  await sub.waitForDeployment();
  const subAddr = await sub.getAddress();

  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "credits-")), "test.db");
  procs.push(spawn("node", ["--no-warnings", "server/index.js"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, PORT: "3999", RPC_URL: RPC, CHAIN_ID: "31337", USDT_ADDRESS: await usdt.getAddress(), CONTRACT_ADDRESS: subAddr,
      CONFIRMATIONS: "1", ADMIN_PASSWORD: "test-password-123", SESSION_SECRET: "test-secret", DB_PATH: dbPath, CSP_CONNECT: RPC },
  }));
  await waitFor(async () => { const r = await fetch(API + "/api/config"); if (!r.ok) throw 0; }, "server");

  console.log("\nAdmin");
  ok((await call("/api/admin/overview")).code === 401, "admin API refuses requests without login");
  ok((await call("/api/admin/login", "POST", { password: "nope" })).code === 401, "wrong password rejected");
  const { token } = await call("/api/admin/login", "POST", { password: "test-password-123" });
  await reverts(sub.connect(alice).createPlan(U(1), 60, 3), "non-owner cannot create a plan");
  await reverts(sub.createPlan(U(1), 10, 3), "plan period below the contract minimum is rejected");
  await (await sub.createPlan(U(10), 60, 3)).wait(); // plan 0: 10 USDT / 60 s, 3 charges, cap 30
  ok((await call("/api/config")).plans.length === 0, "plan without name/credits is hidden from users");
  ok((await call("/api/admin/plans/0", "PUT", { name: "Starter", credits: 1000 }, token)).ok, "admin sets plan name and credits");
  ok((await call("/api/admin/plans/7", "PUT", { name: "Ghost", credits: 1 }, token)).code === 404, "cannot add metadata for a plan that is not on chain");
  ok((await call("/api/admin/settings", "PUT", { minBalance: "20" }, token)).ok, "admin sets minimum balance 20");
  const cfg = await call("/api/config");
  ok(cfg.plans.length === 1 && cfg.plans[0].cap === U(30).toString() && cfg.minBalance === "20", "public config shows plan, cap 30 and minimum");

  console.log("\nEligibility (balance read from chain by the server)");
  await (await usdt.mint(alice.address, U(15))).wait();
  let e = await call(`/api/eligibility/${alice.address}?planId=0`);
  ok(e.eligible === false && e.balance === U(15).toString(), "15 USDT < minimum 20: not eligible");
  await (await usdt.mint(alice.address, U(85))).wait();
  e = await call(`/api/eligibility/${alice.address}?planId=0`);
  ok(e.eligible === true && e.balance === U(100).toString(), "100 USDT: eligible");

  console.log("\nSubscribe + first payment");
  await reverts(sub.connect(alice).subscribe(0, U(10)), "subscribe without authorization fails");
  await (await usdt.connect(alice).approve(subAddr, U(30))).wait();
  await reverts(sub.connect(alice).subscribe(0, U(9)), "subscribe with a different expected price fails");
  const tx1 = await sub.connect(alice).subscribe(0, U(10));
  await tx1.wait();
  ok((await usdt.balanceOf(treasury.address)) === U(10), "treasury received exactly 10 USDT");
  let v = await verify(tx1.hash);
  ok(v.status === "confirmed" && v.credited === 1000, "backend verified the tx and granted 1000 credits");
  v = await verify(tx1.hash);
  ok(v.credited === 0 && (await call("/api/account/" + alice.address)).credits === 1000, "replaying the same tx grants nothing");
  await reverts(sub.connect(alice).subscribe(0, U(10)), "cannot subscribe twice");

  console.log("\nFake payments");
  const direct = await usdt.connect(bob).transfer(treasury.address, 0);
  await direct.wait();
  v = await verify(direct.hash);
  ok(v.status === "ignored", "a tx that never touched the contract is ignored");
  ok((await call("/api/verify", "POST", { txHash: "0x1234" })).code === 400, "malformed tx hash rejected");
  ok((await call("/api/verify", "POST", { txHash: "0x" + "ab".repeat(32) })).status === "pending", "unknown tx hash stays pending, no credits");

  console.log("\nRenewals and the cap");
  await reverts(sub.charge(alice.address), "charging before the period has passed fails");
  await reverts(sub.connect(bob).charge(alice.address), "non-owner cannot charge");
  await provider.send("evm_increaseTime", [600]); // ten periods pass
  await provider.send("evm_mine", []);
  const tx2 = await sub.charge(alice.address);
  await tx2.wait();
  v = await verify(tx2.hash);
  ok(v.credited === 1000, "renewal verified: +1000 credits");
  await reverts(sub.charge(alice.address), "missed periods are not caught up: second charge right away fails");
  await provider.send("evm_increaseTime", [61]);
  await provider.send("evm_mine", []);
  const tx3 = await sub.charge(alice.address);
  await tx3.wait();
  await verify(tx3.hash);
  let acct = await call("/api/account/" + alice.address);
  ok(acct.credits === 3000 && acct.subscription.status === "completed" && acct.payments.length === 3, "third charge reaches the cap: 3000 credits, subscription completed");
  await provider.send("evm_increaseTime", [61]);
  await provider.send("evm_mine", []);
  await reverts(sub.charge(alice.address), "a fourth charge is impossible");
  ok((await usdt.balanceOf(alice.address)) === U(70) && (await usdt.balanceOf(treasury.address)) === U(30), "total taken equals the disclosed cap (30)");

  console.log("\nCancellation");
  await (await usdt.mint(bob.address, U(50))).wait();
  await (await usdt.connect(bob).approve(subAddr, U(30))).wait();
  const b1 = await sub.connect(bob).subscribe(0, U(10));
  await b1.wait();
  await verify(b1.hash);
  const b2 = await sub.connect(bob).cancel();
  await b2.wait();
  await verify(b2.hash);
  await provider.send("evm_increaseTime", [61]);
  await provider.send("evm_mine", []);
  await reverts(sub.charge(bob.address), "user cancelled: charge fails even with allowance left");
  acct = await call("/api/account/" + bob.address);
  ok(acct.subscription.status === "cancelled" && acct.credits === 1000, "backend shows cancelled; paid credits kept");

  await (await usdt.mint(carol.address, U(50))).wait();
  await (await usdt.connect(carol).approve(subAddr, U(30))).wait();
  const c1 = await sub.connect(carol).subscribe(0, U(10));
  await c1.wait();
  await verify(c1.hash);
  const c2 = await sub.cancelFor(carol.address);
  await c2.wait();
  await verify(c2.hash);
  ok((await call("/api/account/" + carol.address)).subscription.status === "cancelled", "admin cancellation recorded");

  console.log("\nAdmin data");
  ok((await call("/api/admin/credits/adjust", "POST", { address: bob.address, delta: -400, reason: "usage" }, token)).ok, "admin adjusts credits");
  ok((await call("/api/admin/credits/adjust", "POST", { address: bob.address, delta: -5000, reason: "x" }, token)).code === 400, "credits cannot go negative");
  const ov = await call("/api/admin/overview", "GET", null, token);
  ok(ov.payments.length === 5 && ov.totalReceived === U(50).toString() && ov.users.find((u) => u.address === bob.address).credits === 600,
    "overview: 5 payments, 50 USDT received, balances correct");
  await (await sub.setPlanActive(0, false)).wait();
  await reverts(sub.connect(carol).subscribe(0, U(10)), "closed plan accepts no new subscribers");
  await (await sub.setPlanActive(0, true)).wait();

  console.log("\nReview hardening");
  await reverts(new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(alice.address, treasury.address, 60).then((c) => c.deploymentTransaction()),
    "deploy with a token address that is not a contract fails");
  ok(!sub.interface.fragments.some((f) => f.name === "setTreasury"), "there is no instant treasury change");
  await reverts(sub.connect(alice).proposeTreasury(alice.address), "non-owner cannot propose a treasury");
  await (await sub.proposeTreasury(carol.address)).wait();
  await reverts(sub.applyTreasury(), "treasury change cannot be applied before 2 days");
  ok((await sub.treasury()) === treasury.address, "payments still go to the old treasury meanwhile");
  await provider.send("evm_increaseTime", [2 * 86400 + 1]);
  await provider.send("evm_mine", []);
  await (await sub.applyTreasury()).wait();
  ok((await sub.treasury()) === carol.address, "treasury changes after the waiting period");
  await reverts(sub.applyTreasury(), "apply without a new proposal fails");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (KEEP) {
    console.log(JSON.stringify({ api: API, rpc: RPC, usdt: await usdt.getAddress(), contract: subAddr }));
    return;
  }
  procs.forEach((p) => p.kill());
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  procs.forEach((p) => p.kill());
  process.exit(1);
});
