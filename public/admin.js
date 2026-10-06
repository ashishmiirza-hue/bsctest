/* global ethers */
(() => {
  const $ = (id) => document.getElementById(id);
  const ABI = [
    "function owner() view returns (address)",
    "function charge(address user, uint256 amount)",
    "function stopFor(address user)",
    "function setMaxPerCharge(uint256 amount)",
    "function remaining(address) view returns (uint256)",
  ];
  let token = sessionStorage.getItem("adminToken") || "";
  let data, contract, wallet;

  const msg = (id, text, kind) => { const el = $(id); el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : "") + (text ? "" : " hide"); };
  const errText = (e) => (e?.code === "ACTION_REJECTED" || e?.code === 4001 ? "Rejected in wallet." : e?.shortMessage || e?.reason || e?.message || "Failed");
  const api = async (path, method = "GET", body) => {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== "/api/admin/login") { logout(); throw new Error("Session expired, log in again."); }
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  };
  const fmt = (v) => { const [a, b = ""] = ethers.formatUnits(v, data.decimals).split("."); const f = b.slice(0, 2).replace(/0+$/, ""); return Number(a).toLocaleString("en-US") + (f ? "." + f : ""); };
  const date = (t) => new Date(t * 1000).toLocaleString();
  const short = (a) => a.slice(0, 8) + "…" + a.slice(-6);
  const td = (v, cls) => { const el = document.createElement("td"); if (cls) el.className = cls; if (v instanceof Node) el.append(v); else el.textContent = v; return el; };
  const rowOf = (...cells) => { const tr = document.createElement("tr"); tr.append(...cells); return tr; };
  const pill = (t, k) => { const s = document.createElement("span"); s.className = "pill " + (k || ""); s.textContent = t; return s; };
  const addrCell = (a) => { const s = document.createElement("span"); s.className = "mono"; s.title = a; s.textContent = short(a); return td(s); };
  const txCell = (h) => { if (!data.explorer) return addrCell(h); const a = document.createElement("a"); a.href = data.explorer + "/tx/" + h; a.target = "_blank"; a.rel = "noopener"; a.className = "mono"; a.textContent = short(h); return td(a); };
  const fill = (id, rows, cols) => { const b = $(id); b.textContent = ""; if (!rows.length) { const c = td("Nothing yet", "muted"); c.colSpan = cols; b.append(rowOf(c)); } else b.append(...rows); };

  function logout() {
    token = ""; sessionStorage.removeItem("adminToken");
    $("panel").classList.add("hide"); $("setup").classList.add("hide"); $("login").classList.remove("hide");
    $("walletBtn").classList.add("hide"); $("logoutBtn").classList.add("hide");
  }

  async function login() {
    try { msg("loginMsg"); const r = await api("/api/admin/login", "POST", { password: $("pw").value }); token = r.token; sessionStorage.setItem("adminToken", token); $("pw").value = ""; await load(); }
    catch (e) { msg("loginMsg", errText(e), "bad"); }
  }

  async function load() {
    data = await api("/api/admin/overview");
    $("login").classList.add("hide"); $("logoutBtn").classList.remove("hide");
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
    const stats = $("stats"); stats.textContent = "";
    const active = data.accounts.filter((a) => !a.stopped && BigInt(a.limit_set) > 0n);
    [["USDT charged", fmt(data.totalReceived)], ["Customers", data.accounts.length], ["Active limits", active.length], ["Charges", data.charges.length]]
      .forEach(([k, v]) => { const d = document.createElement("div"); d.className = "stat"; const a = document.createElement("div"); a.className = "muted small"; a.textContent = k; const b = document.createElement("div"); b.className = "v"; b.textContent = v; d.append(a, b); stats.append(d); });

    fill("userRows", data.accounts.map((u) => {
      // limit_set is the live allowance (already shrinks as usage is charged) = what can still be charged.
      const approved = u.stopped ? 0n : BigInt(u.limit_set), used = BigInt(u.total_charged);
      const box = document.createElement("div"); box.className = "row"; box.style.flexWrap = "nowrap";
      const amt = document.createElement("input"); amt.placeholder = "USDT"; amt.inputMode = "decimal"; amt.style.maxWidth = "110px";
      const go = document.createElement("button"); go.className = "sm"; go.textContent = "Charge";
      go.onclick = () => chargeUser(u.address, amt, go);
      if (u.stopped) { amt.disabled = true; go.disabled = true; }
      box.append(amt, go);
      const stop = document.createElement("button"); stop.className = "sm danger"; stop.textContent = "Stop";
      stop.onclick = (e) => chainTx(e.target, () => contract.stopFor(u.address));
      if (u.stopped) stop.disabled = true;
      const actions = document.createElement("div"); actions.className = "row"; actions.style.flexWrap = "nowrap"; actions.append(box, stop);
      return rowOf(addrCell(u.address), td(fmt(approved), "num"), td(fmt(used), "num"), td(Number(u.credits).toLocaleString("en-US"), "num"),
        td(pill(u.stopped ? "stopped" : approved > 0n ? "active" : "no limit", u.stopped ? "bad" : approved > 0n ? "ok" : "")), td(actions));
    }), 7);

    fill("chargeRows", data.charges.map((c) => rowOf(td(date(c.charged_at)), addrCell(c.address), td(fmt(c.amount), "num"), td(c.block, "num"), txCell(c.tx_hash))), 5);
    fill("ledgerRows", data.ledger.map((l) => rowOf(td(date(l.created_at)), addrCell(l.address), td((l.delta > 0 ? "+" : "") + l.delta.toLocaleString("en-US"), "num"), td(l.reason))), 4);

    $("setLimits").value = (data.limits || []).join(", ");
    $("setMin").value = data.minLimit; $("setMax").value = data.maxLimit;
    $("maxPer").value = data.maxPerCharge === "0" ? "" : fmt(data.maxPerCharge);
    $("iContract").textContent = data.contract; $("iOwner").textContent = data.owner; $("iTreasury").textContent = data.treasury; $("iUsdt").textContent = data.usdt;
    $("iMaxPer").textContent = data.maxPerCharge === "0" ? "no extra cap" : fmt(data.maxPerCharge) + " USDT";
  }

  async function connectWallet() {
    try {
      const eth = window.ethereum || window.trustwallet;
      if (!eth) throw new Error("No wallet found. Open this page in a browser with the owner wallet.");
      const [acc] = await eth.request({ method: "eth_requestAccounts" });
      const hex = "0x" + data.chainId.toString(16);
      if ((await eth.request({ method: "eth_chainId" })) !== hex) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      const signer = await new ethers.BrowserProvider(eth).getSigner(acc);
      wallet = await signer.getAddress();
      contract = new ethers.Contract(data.contract, ABI, signer);
      $("walletBtn").textContent = short(wallet);
      if (wallet.toLowerCase() !== data.owner.toLowerCase()) msg("walletMsg", "This wallet is not the contract owner, so on-chain actions will be rejected. Owner: " + data.owner, "warn");
      else msg("walletMsg");
      eth.on?.("accountsChanged", () => location.reload());
    } catch (e) { msg("walletMsg", errText(e), "bad"); }
  }

  async function chainTx(button, send) {
    const label = button.textContent;
    try {
      if (!contract) await connectWallet();
      if (!contract) return;
      button.disabled = true; button.textContent = "…";
      msg("actMsg", "Confirm in wallet…");
      const tx = await send();
      msg("actMsg", "Waiting for confirmation…");
      await tx.wait();
      await verify(tx.hash);
      await load();
      msg("actMsg", "Done: " + tx.hash, "ok");
      return true;
    } catch (e) { msg("actMsg", errText(e), "bad"); }
    finally { button.disabled = false; button.textContent = label; }
  }

  async function verify(txHash) {
    for (let i = 0; i < 60; i++) {
      const r = await api("/api/verify", "POST", { txHash });
      if (r.status === "confirmed" || r.status === "ignored") return r;
      if (r.status === "failed") throw new Error("Transaction failed on chain.");
      msg("actMsg", r.status === "confirming" ? `Confirming: ${r.confirmations} of ${r.required} blocks…` : "Waiting to be mined…");
      await new Promise((res) => setTimeout(res, 3000));
    }
  }

  async function chargeUser(address, input, button) {
    let amount;
    try { amount = ethers.parseUnits(String(input.value).trim(), data.decimals); } catch { amount = 0n; }
    if (amount <= 0n) return msg("actMsg", "Enter an amount in USDT to charge.", "bad");
    if (!contract) { await connectWallet(); if (!contract) return; }
    try {
      const left = await contract.remaining(address);
      if (amount > left) return msg("actMsg", `That is more than this customer's remaining limit (${fmt(left)} USDT).`, "bad");
    } catch {}
    const ok = await chainTx(button, () => contract.charge(address, amount));
    if (ok) input.value = "";
  }

  $("loginBtn").onclick = login;
  $("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  $("pwShow").onchange = () => ($("pw").type = $("pwShow").checked ? "text" : "password");
  $("logoutBtn").onclick = logout;
  $("walletBtn").onclick = connectWallet;
  $("suConnect").onclick = setupConnect;
  $("suDeploy").onclick = setupDeploy;
  $("setBtn").onclick = async () => {
    try {
      const limits = $("setLimits").value.split(",").map((s) => s.trim()).filter(Boolean);
      await api("/api/admin/settings", "PUT", { limits, minLimit: $("setMin").value.trim(), maxLimit: $("setMax").value.trim() });
      await load(); msg("actMsg", "Spending limits saved.", "ok");
    } catch (e) { msg("actMsg", errText(e), "bad"); }
  };
  $("maxPerBtn").onclick = async (e) => {
    let amount;
    try { amount = $("maxPer").value.trim() ? ethers.parseUnits($("maxPer").value.trim(), data.decimals) : 0n; } catch { return msg("actMsg", "Enter a USDT amount, or leave blank for no cap.", "bad"); }
    await chainTx(e.target, () => contract.setMaxPerCharge(amount));
  };
  $("adjBtn").onclick = async () => {
    try {
      await api("/api/admin/credits/adjust", "POST", { address: $("adjAddr").value.trim(), delta: Number($("adjDelta").value), reason: $("adjReason").value });
      $("adjDelta").value = ""; $("adjReason").value = ""; await load(); msg("actMsg", "Credits adjusted.", "ok");
    } catch (e) { msg("actMsg", errText(e), "bad"); }
  };
  $("vBtn").onclick = async () => {
    try { const r = await api("/api/verify", "POST", { txHash: $("vTx").value.trim() }); await load(); msg("actMsg", "Result: " + JSON.stringify(r), r.status === "confirmed" ? "ok" : "warn"); }
    catch (e) { msg("actMsg", errText(e), "bad"); }
  };
  $("tabs").onclick = (e) => {
    const t = e.target.dataset?.t; if (!t) return;
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b === e.target));
    document.querySelectorAll("[data-p]").forEach((s) => s.classList.toggle("hide", s.dataset.p !== t));
  };

  // ---- first-time setup: deploy from the admin's wallet
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
    } catch (e) { msg("suMsg", errText(e), "bad"); }
  }

  async function setupDeploy() {
    const b = $("suDeploy");
    try {
      const treasury = $("suTreasury").value.trim();
      if (!ethers.isAddress(treasury)) throw new Error("Treasury must be a wallet address (0x…).");
      b.disabled = true;
      msg("suMsg", "Confirm the deployment in your wallet…");
      const art = await api("/api/admin/artifact");
      const c = await new ethers.ContractFactory(art.abi, art.bytecode, setupSigner).deploy(data.usdt, treasury);
      msg("suMsg", "Deploying… waiting for confirmation. Do not close this page.");
      await c.waitForDeployment();
      const address = await c.getAddress();
      for (let i = 0; ; i++) {
        try { await api("/api/admin/contract", "POST", { address }); break; }
        catch (e) { if (i >= 10) throw new Error("Deployed at " + address + " but the server could not save it: " + errText(e) + " Set CONTRACT_ADDRESS=" + address + " in your hosting environment."); await new Promise((r) => setTimeout(r, 3000)); }
      }
      await load();
      msg("actMsg", "Contract deployed: " + address, "ok");
    } catch (e) { msg("suMsg", errText(e), "bad"); b.disabled = !setupSigner; }
  }

  if (token) load().catch(() => logout());
})();
