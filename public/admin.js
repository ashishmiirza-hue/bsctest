/* global ethers */
(() => {
  const $ = (id) => document.getElementById(id);
  const ABI = [
    "function createPlan(uint128 price, uint32 period, uint16 maxCharges) returns (uint256)",
    "function setPlanActive(uint256 planId, bool active)",
    "function charge(address user)",
    "function cancelFor(address user)",
    "event PlanCreated(uint256 indexed planId, uint256 price, uint256 period, uint256 maxCharges)",
  ];
  let token = sessionStorage.getItem("adminToken") || "";
  let data, contract, wallet;

  const msg = (id, text, kind) => {
    const el = $(id);
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "") + (text ? "" : " hide");
  };
  const errText = (e) => (e?.code === "ACTION_REJECTED" || e?.code === 4001 ? "Rejected in wallet." : e?.shortMessage || e?.reason || e?.message || "Failed");
  const api = async (path, method = "GET", body) => {
    const r = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== "/api/admin/login") { logout(); throw new Error("Session expired, log in again."); }
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  };
  const fmt = (v) => {
    const [a, b = ""] = ethers.formatUnits(v, data.decimals).split(".");
    const f = b.slice(0, 4).replace(/0+$/, "");
    return Number(a).toLocaleString("en-US") + (f ? "." + f : "");
  };
  const every = (s) => (s % 86400 === 0 ? s / 86400 + " d" : s % 3600 === 0 ? s / 3600 + " h" : s + " s");
  const date = (t) => new Date(t * 1000).toLocaleString();
  const short = (a) => a.slice(0, 8) + "…" + a.slice(-6);

  // table helpers: every value goes in through textContent
  const td = (v, cls) => { const el = document.createElement("td"); if (cls) el.className = cls; if (v instanceof Node) el.append(v); else el.textContent = v; return el; };
  const row = (...cells) => { const tr = document.createElement("tr"); tr.append(...cells); return tr; };
  const pill = (text, kind) => { const s = document.createElement("span"); s.className = "pill " + (kind || ""); s.textContent = text; return s; };
  const btn = (label, fn, cls) => { const b = document.createElement("button"); b.className = "sm " + (cls || "ghost"); b.textContent = label; b.onclick = () => fn(b); return b; };
  const addrCell = (a) => { const s = document.createElement("span"); s.className = "mono"; s.title = a; s.textContent = short(a); return td(s); };
  const txCell = (h) => {
    if (!data.explorer) return addrCell(h);
    const a = document.createElement("a");
    a.href = data.explorer + "/tx/" + h; a.target = "_blank"; a.rel = "noopener"; a.className = "mono"; a.textContent = short(h);
    return td(a);
  };
  const fill = (id, rows, cols) => {
    const b = $(id);
    b.textContent = "";
    if (!rows.length) { const c = td("Nothing yet", "muted"); c.colSpan = cols; b.append(row(c)); } else b.append(...rows);
  };

  function logout() {
    token = "";
    sessionStorage.removeItem("adminToken");
    $("panel").classList.add("hide");
    $("setup").classList.add("hide");
    $("login").classList.remove("hide");
    $("walletBtn").classList.add("hide");
    $("logoutBtn").classList.add("hide");
  }

  async function login() {
    try {
      msg("loginMsg");
      const r = await api("/api/admin/login", "POST", { password: $("pw").value });
      token = r.token;
      sessionStorage.setItem("adminToken", token);
      $("pw").value = "";
      await load();
    } catch (e) {
      msg("loginMsg", errText(e), "bad");
    }
  }

  async function load() {
    data = await api("/api/admin/overview");
    $("login").classList.add("hide");
    $("logoutBtn").classList.remove("hide");
    $("setup").classList.toggle("hide", !data.setupNeeded);
    $("panel").classList.toggle("hide", !!data.setupNeeded);
    $("walletBtn").classList.toggle("hide", !!data.setupNeeded);
    if (data.setupNeeded) {
      $("suChain").textContent = data.chainId === 56 ? "BNB Smart Chain (mainnet)" : data.chainId === 97 ? "BSC testnet" : "chain " + data.chainId;
      $("suUsdt").textContent = data.usdt;
      return;
    }
    msg("envNote", data.contractInEnv ? "" : "Contract " + data.contract + " is saved in the database only. Add CONTRACT_ADDRESS=" + data.contract + " to your hosting environment variables so it survives a restart.", "warn");
    render();
  }

  function render() {
    const planName = (id) => data.plans.find((p) => p.planId === id)?.name || "#" + id;
    const active = data.subscriptions.filter((s) => s.status === "active");
    const due = active.filter((s) => s.next_charge_at <= data.now);

    const stats = $("stats");
    stats.textContent = "";
    [["USDT received", fmt(data.totalReceived)], ["Active subscriptions", active.length], ["Renewals due", due.length],
      ["Payments", data.payments.length], ["Customers", data.users.length]].forEach(([k, v]) => {
      const d = document.createElement("div"); d.className = "stat";
      const a = document.createElement("div"); a.className = "muted small"; a.textContent = k;
      const b = document.createElement("div"); b.className = "v"; b.textContent = v;
      d.append(a, b); stats.append(d);
    });

    fill("planRows", data.plans.map((p) => row(
      td(p.planId), td(p.name || "(no name: hidden from users)", p.name ? "" : "muted"),
      td(fmt(p.price), "num"), td(every(p.period)), td(p.maxCharges, "num"), td(fmt(p.cap), "num"), td(p.credits.toLocaleString("en-US"), "num"),
      td(pill(p.active ? "open" : "closed", p.active ? "ok" : "bad")),
      td((() => { const w = document.createElement("div"); w.className = "row"; w.append(
        btn("Edit name/credits", () => editPlan(p)),
        btn(p.active ? "Close" : "Reopen", (b) => chainTx(b, () => contract.setPlanActive(p.planId, !p.active)), p.active ? "danger" : "ghost")); return w; })())
    )), 9);

    fill("subRows", data.subscriptions.map((s) => {
      const isDue = s.status === "active" && s.next_charge_at <= data.now;
      const actions = document.createElement("div"); actions.className = "row";
      if (s.status === "active") {
        const c = btn("Charge", (b) => chainTx(b, () => contract.charge(s.address)), "");
        c.disabled = !isDue;
        actions.append(c, btn("Cancel", (b) => chainTx(b, () => contract.cancelFor(s.address)), "danger"));
      }
      actions.append(btn("Sync", async () => { await api("/api/admin/sync/" + s.address, "POST"); await load(); }));
      return row(addrCell(s.address), td(planName(s.plan_id)), td(fmt(s.price), "num"), td(s.charges + " / " + s.max_charges, "num"),
        td(s.status === "active" ? date(s.next_charge_at) : "–"),
        td(pill(isDue ? "due" : s.status, isDue ? "warn" : s.status === "active" ? "ok" : "")), td(actions));
    }), 7);

    fill("userRows", data.users.map((u) => row(addrCell(u.address), td(u.credits.toLocaleString("en-US"), "num"), td(date(u.created_at)))), 3);
    fill("ledgerRows", data.ledger.map((l) => row(td(date(l.created_at)), addrCell(l.address), td((l.delta > 0 ? "+" : "") + l.delta.toLocaleString("en-US"), "num"), td(l.reason))), 4);
    fill("payRows", data.payments.map((p) => row(td(date(p.paid_at)), addrCell(p.address), td(planName(p.plan_id)), td(p.kind),
      td(fmt(p.amount), "num"), td(p.credits.toLocaleString("en-US"), "num"), td(p.block, "num"), txCell(p.tx_hash))), 8);

    $("minBal").value = data.minBalance;
    $("iContract").textContent = data.contract;
    $("iOwner").textContent = data.owner;
    $("iTreasury").textContent = data.treasury;
    $("iUsdt").textContent = data.usdt;
    $("iMinPeriod").textContent = every(data.minPeriod);
  }

  // ---- first-time setup: deploy the contract from the admin's wallet
  let setupSigner;
  async function setupConnect() {
    try {
      msg("suMsg");
      const eth = window.ethereum || window.trustwallet;
      if (!eth) throw new Error("No wallet found. Open this page in Trust Wallet's DApp browser or a browser with a wallet extension.");
      const [acc] = await eth.request({ method: "eth_requestAccounts" });
      const hex = "0x" + data.chainId.toString(16);
      if ((await eth.request({ method: "eth_chainId" })) !== hex) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      const provider = new ethers.BrowserProvider(eth);
      if (Number((await provider.getNetwork()).chainId) !== data.chainId) throw new Error("Switch the wallet to the right network first.");
      setupSigner = await provider.getSigner(acc);
      const me = await setupSigner.getAddress();
      $("suOwner").textContent = me;
      if (!$("suTreasury").value.trim()) $("suTreasury").value = me;
      $("suDeploy").disabled = false;
    } catch (e) {
      msg("suMsg", errText(e), "bad");
    }
  }

  async function setupDeploy() {
    const b = $("suDeploy");
    try {
      const treasury = $("suTreasury").value.trim();
      const minPeriod = Math.round(Number($("suDays").value) * 86400);
      if (!ethers.isAddress(treasury)) throw new Error("Treasury must be a wallet address (0x…).");
      if (!(minPeriod >= 60)) throw new Error("Shortest plan period must be a positive number of days.");
      b.disabled = true;
      msg("suMsg", "Confirm the deployment in your wallet…");
      const art = await api("/api/admin/artifact");
      const c = await new ethers.ContractFactory(art.abi, art.bytecode, setupSigner).deploy(data.usdt, treasury, minPeriod);
      msg("suMsg", "Deploying… waiting for confirmation. Do not close this page.");
      await c.waitForDeployment();
      const address = await c.getAddress();
      for (let i = 0; ; i++) { // the server's RPC may see the new contract a moment later
        try { await api("/api/admin/contract", "POST", { address }); break; } catch (e) {
          if (i >= 10) throw new Error("Contract deployed at " + address + " but the server could not save it: " + errText(e) + " Set CONTRACT_ADDRESS=" + address + " in your hosting environment.");
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      await load();
      msg("actMsg", "Contract deployed: " + address, "ok");
    } catch (e) {
      msg("suMsg", errText(e), "bad");
      b.disabled = !setupSigner;
    }
  }

  async function connectWallet() {
    try {
      const eth = window.ethereum || window.trustwallet;
      if (!eth) throw new Error("No wallet found. Open this page in a browser with the owner wallet (Trust Wallet DApp browser or an extension).");
      const [acc] = await eth.request({ method: "eth_requestAccounts" });
      const hex = "0x" + data.chainId.toString(16);
      if ((await eth.request({ method: "eth_chainId" })) !== hex) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      const provider = new ethers.BrowserProvider(eth);
      const signer = await provider.getSigner(acc);
      wallet = await signer.getAddress();
      contract = new ethers.Contract(data.contract, ABI, signer);
      $("walletBtn").textContent = short(wallet);
      if (wallet.toLowerCase() !== data.owner.toLowerCase()) msg("walletMsg", "This wallet is not the contract owner, so on-chain actions will be rejected. Owner: " + data.owner, "warn");
      else msg("walletMsg");
      eth.on?.("accountsChanged", () => location.reload());
    } catch (e) {
      msg("walletMsg", errText(e), "bad");
    }
  }

  // Send an owner transaction, wait for it, then have the backend verify it from chain.
  async function chainTx(button, send) {
    const label = button.textContent;
    try {
      if (!contract) await connectWallet();
      if (!contract) return;
      button.disabled = true; button.textContent = "…";
      msg("actMsg", "Confirm in wallet…");
      const tx = await send();
      msg("actMsg", "Waiting for confirmation…");
      const receipt = await tx.wait();
      await verify(tx.hash);
      await load();
      msg("actMsg", "Done: " + tx.hash, "ok");
      return receipt;
    } catch (e) {
      msg("actMsg", errText(e), "bad");
    } finally {
      button.disabled = false; button.textContent = label;
    }
  }

  async function verify(txHash) {
    for (let i = 0; i < 60; i++) {
      const r = await api("/api/verify", "POST", { txHash });
      if (r.status === "confirmed" || r.status === "ignored") return r;
      if (r.status === "failed") throw new Error("Transaction failed on chain.");
      msg("actMsg", r.status === "confirming" ? `Confirming: ${r.confirmations} of ${r.required} blocks…` : "Waiting to be mined…");
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error("Not confirmed yet; use 'Verify a transaction manually' later.");
  }

  async function createPlan(button) {
    const name = $("npName").value.trim();
    const credits = Number($("npCredits").value);
    const days = Number($("npDays").value);
    const max = Number($("npMax").value);
    let price;
    try { price = ethers.parseUnits($("npPrice").value.trim(), data.decimals); } catch { price = 0n; }
    const period = Math.round(days * 86400);
    if (!name || price <= 0n || !(period >= data.minPeriod) || !Number.isInteger(max) || max < 1 || max > 65535 || !Number.isInteger(credits) || credits < 1)
      return msg("actMsg", `Fill in every field. The period must be at least ${every(data.minPeriod)}; max charges and credits are whole numbers.`, "bad");
    const receipt = await chainTx(button, () => contract.createPlan(price, period, max));
    if (!receipt) return;
    const ev = receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "PlanCreated");
    await api("/api/admin/plans/" + ev.args.planId, "PUT", { name, credits });
    ["npName", "npPrice", "npDays", "npMax", "npCredits"].forEach((i) => ($(i).value = ""));
    await load();
    msg("actMsg", `Plan #${ev.args.planId} created.`, "ok");
  }

  async function editPlan(p) {
    $("npName").value = p.name; $("npCredits").value = p.credits || "";
    $("npName").focus();
    msg("actMsg", `Editing plan #${p.planId}: change Name / Credits in the form below and press "Save plan #${p.planId}". Price and period cannot change.`, "warn");
    const b = $("npBtn");
    b.textContent = "Save plan #" + p.planId;
    b.onclick = async () => {
      try {
        await api("/api/admin/plans/" + p.planId, "PUT", { name: $("npName").value, credits: Number($("npCredits").value) });
        $("npName").value = ""; $("npCredits").value = "";
        await load();
        msg("actMsg", "Plan saved.", "ok");
      } catch (e) { msg("actMsg", errText(e), "bad"); }
      b.textContent = "Create plan on chain";
      b.onclick = () => createPlan(b);
    };
  }

  $("loginBtn").onclick = login;
  $("pwShow").onchange = () => ($("pw").type = $("pwShow").checked ? "text" : "password");
  $("pw").onkeydown = (e) => e.key === "Enter" && login();
  $("logoutBtn").onclick = logout;
  $("walletBtn").onclick = connectWallet;
  $("suConnect").onclick = setupConnect;
  $("suDeploy").onclick = setupDeploy;
  $("npBtn").onclick = () => createPlan($("npBtn"));
  $("minBtn").onclick = async () => {
    try { await api("/api/admin/settings", "PUT", { minBalance: $("minBal").value }); await load(); msg("actMsg", "Minimum balance saved.", "ok"); } catch (e) { msg("actMsg", errText(e), "bad"); }
  };
  $("adjBtn").onclick = async () => {
    try {
      await api("/api/admin/credits/adjust", "POST", { address: $("adjAddr").value.trim(), delta: Number($("adjDelta").value), reason: $("adjReason").value });
      $("adjDelta").value = ""; $("adjReason").value = "";
      await load(); msg("actMsg", "Credits adjusted.", "ok");
    } catch (e) { msg("actMsg", errText(e), "bad"); }
  };
  $("vBtn").onclick = async () => {
    try { const r = await api("/api/verify", "POST", { txHash: $("vTx").value.trim() }); await load(); msg("actMsg", "Result: " + JSON.stringify(r), r.status === "confirmed" ? "ok" : "warn"); } catch (e) { msg("actMsg", errText(e), "bad"); }
  };
  $("tabs").onclick = (e) => {
    const t = e.target.dataset?.t;
    if (!t) return;
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b === e.target));
    document.querySelectorAll("[data-p]").forEach((s) => s.classList.toggle("hide", s.dataset.p !== t));
  };

  if (token) load().catch(() => logout());
})();
