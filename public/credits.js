/* global App */
// AI credits page: balance of credits, autopay status, payments, stop autopay.
(() => {
  const A = App, $ = A.$;

  async function show() {
    const [acct, s, remain, allowance] = await Promise.all([
      A.api("/api/account/" + A.me), A.sub.subs(A.me), A.sub.remainingCap(A.me), A.usdt.allowance(A.me, A.cfg.contract),
    ]);
    $("who").textContent = A.short(A.me);
    $("who").classList.add("on");
    $("connectBtn").classList.add("hide");
    $("credits").textContent = A.num(acct.credits);
    $("credits").classList.toggle("empty", acct.credits === 0);

    const has = Number(s.period) > 0;
    const finished = has && !s.active && Number(s.charges) >= Number(s.maxCharges);
    $("state").textContent = s.active ? "Autopay on" : finished ? "Plan finished" : has ? "Autopay stopped" : "No autopay";
    $("state").classList.toggle("on", s.active);
    $("status").textContent = s.active
      ? `Next top-up on or after ${A.date(Number(s.nextChargeAt))}.`
      : acct.credits > 0 ? "Autopay is off. Your credits stay available." : "No credits yet. Pick a plan to get started.";
    $("planBtn").classList.toggle("hide", s.active);
    $("planBtn").textContent = has ? "Start a new plan" : "Choose a plan";

    $("details").classList.toggle("hide", !has && allowance === 0n);
    const p = A.cfg.plans.find((x) => x.planId === Number(s.planId));
    $("dPlan").textContent = has ? `${p?.name || "Plan " + s.planId}, ${A.fmt(s.price)} USDT / ${A.every(Number(s.period))}` : "None";
    $("dCharges").textContent = has ? `${s.charges} of ${s.maxCharges}` : "0";
    $("dNext").textContent = s.active ? `${A.fmt(s.price)} USDT, ${A.date(Number(s.nextChargeAt))} or later` : "None";
    $("dRemain").textContent = `${A.fmt(remain)} USDT`;
    $("dAllow").textContent = `${A.fmt(allowance)} USDT`;
    $("stopBtn").disabled = !s.active;
    $("revokeBtn").disabled = allowance === 0n;

    const box = $("pays");
    box.textContent = "";
    $("history").classList.toggle("hide", !acct.payments.length);
    for (const pay of acct.payments) {
      const row = document.createElement("div"); row.className = "pay";
      const what = document.createElement("span"); what.textContent = pay.kind === "first" ? "First payment" : "Top-up";
      const plus = document.createElement("span"); plus.className = "plus"; plus.textContent = "+" + A.num(pay.credits);
      const when = document.createElement("span"); when.className = "when";
      if (A.cfg.explorer) {
        const link = document.createElement("a"); link.href = `${A.cfg.explorer}/tx/${pay.tx_hash}`; link.target = "_blank"; link.rel = "noopener";
        link.textContent = A.date(pay.paid_at); when.append(link);
      } else when.textContent = A.date(pay.paid_at);
      const usd = document.createElement("span"); usd.className = "usd"; usd.textContent = `${A.fmt(pay.amount)} USDT`;
      row.append(what, plus, when, usd);
      box.append(row);
    }
  }

  async function act(btn, label, working, send, done) {
    try {
      btn.disabled = true; btn.textContent = "Confirm in your wallet…";
      A.note("actNote");
      const tx = await send();
      btn.textContent = working;
      await tx.wait();
      await A.confirmOnChain(tx.hash).catch(() => {});
      await show();
      A.note("actNote", done, "good");
    } catch (e) {
      A.note("actNote", A.errText(e), "bad");
      btn.disabled = false;
    }
    btn.textContent = label;
  }

  async function connect(prompt) {
    try {
      if (!(await A.connect(prompt))) return;
      const pending = A.store.get("pendingTx"); // a payment whose confirmation was interrupted
      if (pending) { await A.confirmOnChain(pending).catch(() => {}); A.store.set("pendingTx", null); }
      await show();
    } catch (e) {
      $("status").textContent = A.errText(e);
      $("status").className = "status bad";
    }
  }

  (async () => {
    await A.loadConfig();
    if (A.cfg.setup) return A.note("pageNote", "This site is still being set up. Check back soon.", "warn");
    if (new URLSearchParams(location.search).has("started")) {
      $("okNote").classList.remove("hide");
      history.replaceState(null, "", "/credits.html");
    }
    if (!A.wallet()) {
      $("connectBtn").classList.add("hide");
      $("twBtn").classList.remove("hide");
      $("twBtn").href = A.deepLink();
      $("status").textContent = "Open this page in Trust Wallet's browser to see your credits.";
      return;
    }
    $("connectBtn").onclick = () => connect(true);
    $("stopBtn").onclick = () => act($("stopBtn"), "Stop autopay", "Stopping…", () => A.sub.cancel(), "Autopay stopped. No more payments will be taken.");
    $("revokeBtn").onclick = () => act($("revokeBtn"), "Remove approval", "Removing…", () => A.usdt.approve(A.cfg.contract, 0n), "Approval removed. This site can no longer take USDT from your wallet.");
    await connect(false); // no popup if the wallet is already connected
  })().catch((e) => A.note("pageNote", "Could not load the page: " + A.errText(e), "bad"));
})();
