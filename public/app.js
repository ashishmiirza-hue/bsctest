/* global ethers */
(() => {
  const $ = (id) => document.getElementById(id);
  const SUB_ABI = [
    "function subs(address) view returns (uint32 planId, uint128 price, uint32 period, uint16 maxCharges, uint16 charges, uint64 nextChargeAt, bool active)",
    "function remainingCap(address) view returns (uint256)",
    "function subscribe(uint256 planId, uint256 expectedPrice)",
    "function cancel()",
  ];
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
  ];

  let cfg, eth, provider, signer, me, usdt, sub, plan, balance = 0n, allowance = 0n, eligible = false, activeSub = false;

  const fmt = (v) => {
    const s = ethers.formatUnits(v, cfg.decimals);
    const [a, b = ""] = s.split(".");
    const frac = b.slice(0, 4).replace(/0+$/, "");
    return Number(a).toLocaleString("en-US") + (frac ? "." + frac : "");
  };
  const every = (sec) => {
    if (sec % 86400 === 0) { const d = sec / 86400; return d === 1 ? "day" : d + " days"; }
    if (sec % 3600 === 0) return sec / 3600 + " hours";
    return sec + " seconds";
  };
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const date = (t) => new Date(t * 1000).toLocaleString();
  const msg = (id, text, kind) => {
    const el = $(id);
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "") + (text ? "" : " hide");
  };
  const errText = (e) => {
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "You rejected the request in your wallet.";
    return e?.shortMessage || e?.reason || e?.message || "Something went wrong.";
  };
  const api = async (path, opts) => {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  };
  const busy = (btn, on, label) => {
    btn.disabled = on;
    if (label) btn.textContent = label;
  };

  async function init() {
    cfg = await api("/api/config");
    $("cAddr").textContent = cfg.contract;
    eth = window.ethereum || window.trustwallet;
    if (!eth) {
      $("noWallet").classList.remove("hide");
      $("twLink").href = "https://link.trustwallet.com/open_url?coin_id=20000714&url=" + encodeURIComponent(location.href);
      $("connectBtn").disabled = true;
    }
    renderPlans();
    $("connectBtn").onclick = connect;
    $("ack").onchange = refreshButtons;
    $("approveBtn").onclick = approve;
    $("subBtn").onclick = subscribe;
    $("cancelBtn").onclick = cancel;
    $("revokeBtn").onclick = revoke;
  }

  function renderPlans() {
    const box = $("plans");
    box.textContent = "";
    if (!cfg.plans.length) {
      box.innerHTML = '<p class="muted">No plans are available right now.</p>';
      return;
    }
    for (const p of cfg.plans) {
      const l = document.createElement("label");
      l.className = "plan";
      const r = document.createElement("input");
      r.type = "radio"; r.name = "plan"; r.value = p.planId;
      r.onchange = () => selectPlan(p, l);
      const price = document.createElement("span");
      price.className = "price";
      price.textContent = fmt(p.price) + " USDT / " + every(p.period);
      const name = document.createElement("b");
      name.textContent = p.name;
      const sub2 = document.createElement("div");
      sub2.className = "muted small";
      sub2.textContent = p.credits.toLocaleString("en-US") + " credits per payment" + (p.description ? " · " + p.description : "");
      l.append(r, name, price, sub2);
      box.append(l);
    }
  }

  async function connect() {
    try {
      msg("msg1");
      busy($("connectBtn"), true, "Connecting…");
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      const hex = "0x" + cfg.chainId.toString(16);
      if ((await eth.request({ method: "eth_chainId" })) !== hex) {
        try {
          await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
        } catch (e) {
          if (cfg.chainId !== 56 || (e.code !== 4902 && e.code !== -32603)) throw e;
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x38", chainName: "BNB Smart Chain",
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: ["https://bsc-dataseed.binance.org"], blockExplorerUrls: ["https://bscscan.com"],
            }],
          });
        }
      }
      provider = new ethers.BrowserProvider(eth);
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== cfg.chainId) throw new Error("Please switch your wallet to BNB Smart Chain and try again.");
      signer = await provider.getSigner(accounts[0]);
      me = await signer.getAddress();
      usdt = new ethers.Contract(cfg.usdt, ERC20_ABI, signer);
      sub = new ethers.Contract(cfg.contract, SUB_ABI, signer);

      $("netPill").textContent = cfg.chainId === 56 ? "BNB Smart Chain" : "chain " + cfg.chainId;
      $("netPill").className = "pill ok";
      $("addr").textContent = short(me);
      $("connectBtn").classList.add("hide");
      $("walletInfo").classList.remove("hide");
      $("st1").classList.add("done");
      eth.on?.("accountsChanged", () => location.reload());
      eth.on?.("chainChanged", () => location.reload());
      await refresh();
    } catch (e) {
      busy($("connectBtn"), false, "Connect");
      msg("msg1", errText(e), "bad");
    }
  }

  // Re-read everything from chain and backend.
  async function refresh() {
    const [b, a, s, remain, acct] = await Promise.all([
      usdt.balanceOf(me), usdt.allowance(me, cfg.contract), sub.subs(me), sub.remainingCap(me), api("/api/account/" + me),
    ]);
    balance = b; allowance = a; activeSub = s.active;
    $("bal").textContent = fmt(balance) + " USDT";
    $("credits").textContent = acct.credits.toLocaleString("en-US");

    const hasSub = Number(s.period) > 0;
    $("acct").classList.toggle("hide", !hasSub && allowance === 0n);
    if (hasSub || allowance > 0n) {
      const done = !s.active && Number(s.charges) >= Number(s.maxCharges);
      $("subPill").textContent = !hasSub ? "none" : s.active ? "active" : done ? "completed" : "cancelled";
      $("subPill").className = "pill " + (s.active ? "ok" : "warn");
      const p = cfg.plans.find((x) => x.planId === Number(s.planId));
      $("subPlan").textContent = hasSub ? (p?.name || "Plan #" + s.planId) + " · " + fmt(s.price) + " USDT / " + every(Number(s.period)) : "–";
      $("subCharges").textContent = hasSub ? s.charges + " of " + s.maxCharges : "–";
      $("subNext").textContent = s.active ? date(Number(s.nextChargeAt)) : "–";
      $("subRemain").textContent = fmt(remain) + " USDT";
      $("subAllow").textContent = fmt(allowance) + " USDT";
      $("cancelBtn").disabled = !s.active;
      $("revokeBtn").disabled = allowance === 0n;
    }

    const body = $("histBody");
    body.textContent = "";
    $("hist").classList.toggle("hide", !acct.payments.length);
    for (const p of acct.payments) {
      const tr = document.createElement("tr");
      const cells = [date(p.paid_at), p.kind === "first" ? "First payment" : "Renewal", fmt(p.amount), p.credits.toLocaleString("en-US")];
      cells.forEach((c, i) => { const td = document.createElement("td"); td.textContent = c; if (i > 1) td.className = "num"; tr.append(td); });
      const td = document.createElement("td");
      if (cfg.explorer) {
        const link = document.createElement("a");
        link.href = cfg.explorer + "/tx/" + p.tx_hash; link.target = "_blank"; link.rel = "noopener"; link.textContent = short(p.tx_hash);
        td.append(link);
      } else td.textContent = short(p.tx_hash);
      tr.append(td);
      body.append(tr);
    }

    $("s2").classList.toggle("off", activeSub);
    if (activeSub) {
      msg("elig", "You already have an active subscription. Cancel it first if you want a different plan.", "warn");
      $("s3").classList.add("off"); $("s4").classList.add("off");
    } else if (plan) await checkEligibility();
    else msg("elig");
    refreshButtons();
  }

  async function selectPlan(p, label) {
    plan = p;
    document.querySelectorAll(".plan").forEach((el) => el.classList.remove("sel"));
    label.classList.add("sel");
    $("ack").checked = false;
    const cap = fmt(p.cap), price = fmt(p.price);
    $("ackCap").textContent = cap;
    $("disc").innerHTML = "";
    const head = document.createElement("b");
    head.textContent = "What you are authorizing";
    const ul = document.createElement("ul");
    [
      `You allow the subscription contract to take at most ${cap} USDT from this wallet in total. It is not an unlimited approval.`,
      p.maxCharges > 1
        ? `${price} USDT is charged now. After that, up to ${p.maxCharges - 1} more charge(s) of ${price} USDT, never more often than once every ${every(p.period)}.`
        : `${price} USDT is charged now. There are no further charges.`,
      `Each successful charge adds ${p.credits.toLocaleString("en-US")} credits to your account.`,
      `The price cannot be raised for your subscription. After ${p.maxCharges} charge(s) it ends by itself and a new authorization is needed.`,
      `You can cancel on this page at any time. Cancelling blocks every future charge. You can also set the allowance back to zero.`,
      `A small BNB network fee is paid to the network for each transaction you send.`,
    ].forEach((t) => { const li = document.createElement("li"); li.textContent = t; ul.append(li); });
    const c = document.createElement("div");
    c.className = "muted small mono";
    c.style.marginTop = "8px";
    c.textContent = "Spender: " + cfg.contract;
    $("disc").append(head, ul, c);
    $("payLine").textContent = `First payment: ${price} USDT for ${p.credits.toLocaleString("en-US")} credits.`;
    $("st2").classList.add("done");
    if (me) await checkEligibility();
    refreshButtons();
  }

  async function checkEligibility() {
    try {
      const e = await api(`/api/eligibility/${me}?planId=${plan.planId}`);
      eligible = e.eligible;
      balance = BigInt(e.balance);
      $("bal").textContent = fmt(balance) + " USDT";
      if (eligible) msg("elig", `Eligible. Your balance is ${fmt(e.balance)} USDT; this plan needs at least ${fmt(e.required)} USDT.`, "ok");
      else msg("elig", `Not eligible yet. This plan needs a balance of at least ${fmt(e.required)} USDT; your wallet has ${fmt(e.balance)} USDT.`, "bad");
    } catch (e) {
      eligible = false;
      msg("elig", errText(e), "bad");
    }
  }

  function refreshButtons() {
    const ready = !!me && !!plan && eligible && !activeSub;
    const approved = ready && allowance >= BigInt(plan.cap);
    $("s3").classList.toggle("off", !ready);
    $("s4").classList.toggle("off", !approved);
    $("st3").classList.toggle("done", approved);
    $("approveBtn").disabled = !ready || approved || !$("ack").checked;
    $("approveBtn").textContent = approved ? "Authorized" : plan ? `Authorize up to ${fmt(plan.cap)} USDT` : "Authorize";
    $("subBtn").disabled = !approved;
    if (plan) $("subBtn").textContent = `Subscribe and pay ${fmt(plan.price)} USDT`;
  }

  async function approve() {
    const btn = $("approveBtn");
    try {
      busy(btn, true, "Confirm in wallet…");
      msg("msg3");
      const tx = await usdt.approve(cfg.contract, BigInt(plan.cap)); // exactly the cap, never unlimited
      btn.textContent = "Waiting for confirmation…";
      await tx.wait();
      allowance = await usdt.allowance(me, cfg.contract);
      msg("msg3", `Authorized ${fmt(allowance)} USDT.`, "ok");
    } catch (e) {
      msg("msg3", errText(e), "bad");
    }
    await refresh().catch(() => {});
  }

  async function waitCredited(txHash, msgId) {
    for (let i = 0; i < 90; i++) {
      const r = await api("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash }) });
      if (r.status === "confirmed") return r;
      if (r.status === "failed" || r.status === "ignored") throw new Error(r.reason || "The transaction failed on chain.");
      msg(msgId, r.status === "confirming" ? `Confirming on chain: ${r.confirmations} of ${r.required} blocks…` : "Waiting for the transaction to be mined…");
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error("Still unconfirmed. Your payment is safe; reload this page in a minute and it will be picked up. Tx: " + txHash);
  }

  async function subscribe() {
    const btn = $("subBtn");
    try {
      busy(btn, true, "Confirm in wallet…");
      msg("msg4");
      const tx = await sub.subscribe(plan.planId, BigInt(plan.price));
      btn.textContent = "Waiting for confirmation…";
      localStorage.setItem("pendingTx", tx.hash);
      await tx.wait();
      const r = await waitCredited(tx.hash, "msg4");
      localStorage.removeItem("pendingTx");
      $("st4").classList.add("done");
      await refresh();
      msg("msg4", `Payment confirmed. ${r.credited.toLocaleString("en-US")} credits added.`, "ok");
    } catch (e) {
      msg("msg4", errText(e), "bad");
      await refresh().catch(() => {});
    }
  }

  async function cancel() {
    const btn = $("cancelBtn");
    try {
      busy(btn, true, "Confirm in wallet…");
      msg("msgA");
      const tx = await sub.cancel();
      await tx.wait();
      await waitCredited(tx.hash, "msgA").catch(() => {});
      await refresh();
      msg("msgA", "Subscription cancelled. No further charges are possible. You can also revoke the remaining allowance.", "ok");
    } catch (e) {
      msg("msgA", errText(e), "bad");
    }
    btn.textContent = "Cancel subscription";
  }

  async function revoke() {
    const btn = $("revokeBtn");
    try {
      busy(btn, true, "Confirm in wallet…");
      msg("msgA");
      const tx = await usdt.approve(cfg.contract, 0n);
      await tx.wait();
      await refresh();
      msg("msgA", activeSub ? "Allowance is now zero. Renewals will fail until you authorize again; cancel to end the subscription." : "Allowance is now zero.", "ok");
    } catch (e) {
      msg("msgA", errText(e), "bad");
    }
    btn.textContent = "Revoke allowance";
  }

  init()
    .then(() => {
      // pick up a payment whose confirmation was interrupted (page closed, app switched)
      const pending = localStorage.getItem("pendingTx");
      if (pending) waitCredited(pending, "msg1").then(() => { localStorage.removeItem("pendingTx"); msg("msg1"); if (me) refresh(); }).catch(() => localStorage.removeItem("pendingTx"));
    })
    .catch((e) => msg("msg1", "Could not load the site configuration: " + errText(e), "bad"));
})();
