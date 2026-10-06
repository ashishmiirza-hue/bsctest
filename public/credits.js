/* global App */
// AI credits page: credits balance, spending limit (used / remaining), charge history, stop/resume.
(() => {
  const A = App, $ = A.$;

  async function show() {
    const acct = await A.api("/api/account/" + A.me);
    $("who").textContent = A.short(A.me);
    $("who").classList.add("on");
    $("connectBtn").classList.add("hide");
    $("credits").textContent = A.num(acct.credits);
    $("credits").classList.toggle("empty", acct.credits === 0);

    const limit = BigInt(acct.limit), remaining = BigInt(acct.remaining), hasLimit = limit > 0n;
    $("state").textContent = acct.stopped ? "Billing stopped" : hasLimit ? "Active" : "No limit set";
    $("state").classList.toggle("on", !acct.stopped && hasLimit);
    $("status").textContent = acct.stopped
      ? "Billing is stopped. No charges can be made."
      : hasLimit ? "You're billed only for the credits you use." : "Set a spending limit to start using credits.";

    $("details").classList.toggle("hide", acct.stopped || !hasLimit);
    $("stopped").classList.toggle("hide", !acct.stopped);
    $("setBtn").classList.toggle("hide", acct.stopped || hasLimit);
    $("dUsed").textContent = `${A.fmt(acct.used)} USDT`;
    $("dRemain").textContent = `${A.fmt(remaining)} USDT`;
    $("dBal").textContent = `${A.fmt(acct.balance)} USDT`;
    $("stopBtn").disabled = false;

    const box = $("charges");
    box.textContent = "";
    $("history").classList.toggle("hide", !acct.charges.length);
    for (const c of acct.charges) {
      const row = document.createElement("div"); row.className = "pay";
      const what = document.createElement("span"); what.textContent = "Usage charge";
      const amt = document.createElement("span"); amt.className = "plus"; amt.style.color = "var(--ink)"; amt.textContent = `${A.fmt(c.amount)} USDT`;
      const when = document.createElement("span"); when.className = "when";
      if (A.cfg.explorer) {
        const link = document.createElement("a"); link.href = `${A.cfg.explorer}/tx/${c.tx_hash}`; link.target = "_blank"; link.rel = "noopener";
        link.textContent = A.date(c.charged_at); when.append(link);
      } else when.textContent = A.date(c.charged_at);
      const blank = document.createElement("span");
      row.append(what, amt, when, blank);
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
      await A.api("/api/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: A.me }) }).catch(() => {});
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
      await show();
    } catch (e) {
      $("status").textContent = A.errText(e);
      $("status").className = "status bad";
    }
  }

  (async () => {
    await A.loadConfig();
    if (A.cfg.setup) return A.note("pageNote", "This site is still being set up. Check back soon.", "warn");
    if (new URLSearchParams(location.search).has("set")) {
      $("okNote").classList.remove("hide");
      history.replaceState(null, "", "/credits.html");
    }
    if (!A.wallet()) {
      $("connectBtn").classList.add("hide");
      $("twBtn").classList.remove("hide");
      $("twBtn").href = A.deepLink();
      $("status").textContent = "Open this page in Trust Wallet's browser to see your account.";
      return;
    }
    $("connectBtn").onclick = () => connect(true);
    $("stopBtn").onclick = () => act($("stopBtn"), "Stop billing", "Stopping…", () => A.bill.stop(), "Billing stopped. No more charges can be made.");
    $("resumeBtn").onclick = () => act($("resumeBtn"), "Resume billing", "Resuming…", () => A.bill.resume(), "Billing resumed.");
    // In a wallet browser the wallet answers the address request itself at load, so ask there;
    // on a desktop extension only use what is already shared (no popup on load).
    await connect(A.inWalletBrowser());
  })().catch((e) => A.note("pageNote", "Could not load the page: " + A.errText(e), "bad"));
})();
