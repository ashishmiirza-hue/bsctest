/* global App */
// Home page: pick a plan -> Check balance -> Start autopay (approve limit + first payment) -> AI credits page.
(() => {
  const A = App, $ = A.$;
  let plan = null, balance = 0n, allowance = 0n, checked = false, running = false;

  function renderPlans() {
    const box = $("plans");
    box.textContent = "";
    A.cfg.plans.forEach((p, i) => {
      const l = document.createElement("label");
      l.className = "plan";
      const r = document.createElement("input");
      r.type = "radio"; r.name = "plan"; r.value = p.planId;
      r.onchange = () => { choose(p, l); };
      const name = document.createElement("span"); name.className = "name"; name.textContent = p.name;
      const price = document.createElement("span"); price.className = "price"; price.textContent = `${A.fmt(p.price)} USDT / ${A.every(p.period)}`;
      const what = document.createElement("span"); what.className = "what";
      what.textContent = `${A.num(p.credits)} AI credits every ${A.every(p.period)}` + (p.description ? `. ${p.description}` : "");
      l.append(r, name, price, what);
      box.append(l);
      if (i === 0) { r.checked = true; choose(p, l); }
    });
  }

  function choose(p, label) {
    if (running) return;
    plan = p;
    document.querySelectorAll(".plan").forEach((el) => el.classList.toggle("sel", el === label));
    $("apPlan").textContent = p.name;
    $("tNow").textContent = `${A.fmt(p.price)} USDT`;
    $("tThen").textContent = p.maxCharges > 1 ? `${A.fmt(p.price)} USDT every ${A.every(p.period)}, up to ${p.maxCharges - 1} more time${p.maxCharges > 2 ? "s" : ""}` : "Nothing more";
    $("tCredits").textContent = A.num(p.credits);
    $("tCap").textContent = `${A.fmt(p.cap)} USDT`;
    $("startBtn").textContent = "Start autopay for AI credits";
    if (checked) judge();
  }

  // Decide what the wallet panel offers for the chosen plan.
  async function judge() {
    const e = await A.api(`/api/eligibility/${A.me}?planId=${plan.planId}`); // balance is read on chain by the server
    balance = BigInt(e.balance);
    const el = $("amount");
    el.firstChild.textContent = A.fmt(balance);
    el.classList.remove("empty");
    const st = $("status");
    if (e.eligible) {
      st.textContent = `This wallet can start ${plan.name}.`;
      st.className = "status good";
    } else {
      st.textContent = `${plan.name} needs at least ${A.fmt(e.required)} USDT in the wallet. Add USDT (BEP-20) and check again.`;
      st.className = "status bad";
    }
    $("autopay").classList.toggle("hide", !e.eligible);
    $("checkBtn").textContent = "Check again";
    $("checkBtn").classList.toggle("hide", e.eligible);
    // every wallet confirmation costs a little BNB; say so before the user hits a wallet error
    const bnb = e.eligible ? await A.provider.getBalance(A.me).catch(() => 1n) : 1n;
    A.note("apNote", bnb === 0n ? "This wallet has no BNB. Add a little BNB (BEP-20) for the network fee, then start autopay." : "", "warn");
  }

  // auto=true: started by the page itself on load, so a refusal is not shown as an error
  async function check(auto) {
    const btn = $("checkBtn");
    try {
      btn.disabled = true; btn.textContent = "Checking…";
      A.note("pageNote");
      if (!A.me) await A.connect(true);
      if (!A.me) throw new Error("Connect your wallet to check the balance.");
      $("who").textContent = A.short(A.me);
      $("net").classList.add("on");
      const [s, a] = await Promise.all([A.sub.subs(A.me), A.usdt.allowance(A.me, A.cfg.contract)]);
      allowance = a;
      if (s.active) {
        // already on autopay: show the balance and send them to their credits
        const b = await A.usdt.balanceOf(A.me);
        $("amount").firstChild.textContent = A.fmt(b);
        $("amount").classList.remove("empty");
        $("status").textContent = "Autopay is already running for this wallet.";
        $("status").className = "status good";
        btn.classList.add("hide");
        $("openBtn").classList.remove("hide");
        $("autopay").classList.add("hide");
        return;
      }
      if (!plan) throw new Error("No plans are available yet.");
      await judge();
      $("amount").classList.add("reveal");
      checked = true;
    } catch (e) {
      $("status").textContent = auto === true ? "Check your balance to see if this wallet can start autopay." : A.errText(e);
      $("status").className = auto === true ? "status" : "status bad";
      btn.textContent = "Check balance";
    } finally {
      btn.disabled = false;
    }
  }

  const step = (n, state, text) => {
    $("st" + n).className = state;
    $("st" + n + "s").textContent = text || "";
    if (state === "done") $("st" + n).querySelector(".dot").textContent = "✓";
  };

  async function start() {
    const btn = $("startBtn");
    const cap = BigInt(plan.cap), price = BigInt(plan.price);
    running = true;
    btn.disabled = true;
    A.note("apNote");
    $("steps").classList.remove("hide");
    $("st1").querySelector(".dot").textContent = "1";
    $("st2").querySelector(".dot").textContent = "2";
    step(1, "", ""); step(2, "", "");
    try {
      // the balance may have changed since it was checked
      if ((await A.usdt.balanceOf(A.me)) < price) {
        await judge();
        throw new Error(`This wallet no longer has ${A.fmt(price)} USDT for the first payment.`);
      }
      const s = await A.sub.subs(A.me);
      if (s.active) { location.href = "/credits.html"; return; } // started in another tab
      // 1. approve exactly the plan's limit, never more
      allowance = await A.usdt.allowance(A.me, A.cfg.contract);
      if (allowance < cap) {
        step(1, "now", `Confirm ${A.fmt(cap)} USDT in your wallet`);
        btn.textContent = "Confirm in your wallet…";
        const tx = await A.usdt.approve(A.cfg.contract, cap);
        step(1, "now", "Waiting for the network");
        await tx.wait();
      }
      step(1, "done", `Limit set to ${A.fmt(cap)} USDT`);

      // 2. first payment
      step(2, "now", `Confirm ${A.fmt(price)} USDT in your wallet`);
      btn.textContent = "Confirm in your wallet…";
      const tx2 = await A.sub.subscribe(plan.planId, price);
      A.store.set("pendingTx", tx2.hash);
      step(2, "now", "Waiting for the network");
      btn.textContent = "Starting autopay…";
      await tx2.wait();
      await A.confirmOnChain(tx2.hash, (t) => step(2, "now", t));
      A.store.set("pendingTx", null);
      step(2, "done", "Paid. Credits added.");
      btn.textContent = "Autopay started";
      location.href = "/credits.html?started=1";
    } catch (e) {
      running = false;
      btn.disabled = false;
      btn.textContent = "Start autopay for AI credits";
      ["st1", "st2"].forEach((id) => { if ($(id).className === "now") { $(id).className = ""; $(id + "s").textContent = ""; } });
      A.note("apNote", A.errText(e), "bad");
    }
  }

  (async () => {
    await A.loadConfig();
    if (A.cfg.setup) {
      $("checkBtn").disabled = true;
      return A.note("pageNote", "This site is still being set up. Check back soon.", "warn");
    }
    $("net").textContent = A.cfg.chainId === 56 ? "BNB Smart Chain" : A.cfg.chainId === 97 ? "BSC testnet" : "Test chain";
    $("cAddr").textContent = A.cfg.contract;
    renderPlans();
    if (!A.cfg.plans.length) {
      $("checkBtn").disabled = true;
      A.note("pageNote", "No plans are available yet. Check back soon.", "warn");
    }
    if (!A.wallet()) {
      $("checkBtn").classList.add("hide");
      $("twBtn").classList.remove("hide");
      $("twBtn").href = A.deepLink();
      $("status").textContent = "Open this page in Trust Wallet's browser to check your balance.";
    }
    $("checkBtn").onclick = () => check();
    $("startBtn").onclick = start;
    if (!A.wallet() || !A.cfg.plans.length) return;

    // A payment that was sent but not confirmed before the page closed: finish it first.
    const pending = A.store.get("pendingTx");
    if (pending) {
      $("status").textContent = "Finishing your last payment…";
      try { await A.confirmOnChain(pending); A.store.set("pendingTx", null); location.href = "/credits.html?started=1"; return; }
      catch { A.store.set("pendingTx", null); $("status").textContent = "Check your balance to see if this wallet can start autopay."; }
    }
    // Wallet browsers that already share the address (Trust Wallet does) need no connect step:
    // show the balance straight away. Otherwise the button asks once.
    if ((await A.connect(false).catch(() => null)) || A.inWalletBrowser()) {
      $("status").textContent = "Reading your wallet…";
      await check(true);
    }
  })().catch((e) => A.note("pageNote", "Could not load the site: " + A.errText(e), "bad"));
})();
