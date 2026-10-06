/* global ethers */
// Shared by the home page and the AI credits page.
window.App = (() => {
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
  const A = { $, cfg: null, me: null, usdt: null, sub: null };

  A.api = async (path, opts) => {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  };
  A.fmt = (v) => {
    const [a, b = ""] = ethers.formatUnits(v, A.cfg.decimals).split(".");
    const frac = b.slice(0, 2).replace(/0+$/, "");
    return Number(a).toLocaleString("en-US") + (frac ? "." + frac : "");
  };
  A.num = (n) => Number(n).toLocaleString("en-US");
  A.every = (sec) => {
    if (sec === 86400 * 30) return "month";
    if (sec === 86400 * 7) return "week";
    if (sec % 86400 === 0) { const d = sec / 86400; return d === 1 ? "day" : d + " days"; }
    if (sec % 3600 === 0) return sec / 3600 + " hours";
    return sec + " seconds";
  };
  A.short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  A.date = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  A.errText = (e) => {
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "You declined the request in your wallet. Nothing was charged.";
    if (/insufficient funds/i.test(e?.message || "")) return "Not enough BNB in this wallet to pay the network fee.";
    return e?.shortMessage || e?.reason || e?.message || "Something went wrong. Try again.";
  };
  A.note = (id, text, kind) => {
    const el = $(id);
    el.textContent = text || "";
    el.className = "note" + (kind ? " " + kind : "") + (text ? "" : " hide");
  };
  A.wallet = () => window.ethereum || window.trustwallet;
  A.deepLink = () => "https://link.trustwallet.com/open_url?coin_id=20000714&url=" + encodeURIComponent(location.href);

  A.loadConfig = async () => (A.cfg = await A.api("/api/config"));

  // prompt=false only uses a wallet that is already connected to this site (no popup).
  A.connect = async (prompt = true) => {
    const eth = A.wallet();
    if (!eth) throw new Error("No wallet found. Open this page in Trust Wallet's browser.");
    const accounts = await eth.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" });
    if (!accounts?.length) return null;
    const hex = "0x" + A.cfg.chainId.toString(16);
    if ((await eth.request({ method: "eth_chainId" })) !== hex) {
      if (!prompt) return null; // never open a wallet popup on page load
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch (e) {
        if (A.cfg.chainId !== 56 || (e.code !== 4902 && e.code !== -32603)) throw new Error("Switch your wallet to BNB Smart Chain and try again.");
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: "0x38", chainName: "BNB Smart Chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            rpcUrls: ["https://bsc-dataseed.binance.org"], blockExplorerUrls: ["https://bscscan.com"] }],
        });
      }
    }
    const provider = new ethers.BrowserProvider(eth);
    if (Number((await provider.getNetwork()).chainId) !== A.cfg.chainId) throw new Error("Switch your wallet to BNB Smart Chain and try again.");
    const signer = await provider.getSigner(accounts[0]);
    A.me = await signer.getAddress();
    A.provider = provider;
    A.usdt = new ethers.Contract(A.cfg.usdt, ERC20_ABI, signer);
    A.sub = new ethers.Contract(A.cfg.contract, SUB_ABI, signer);
    eth.on?.("accountsChanged", () => location.reload());
    eth.on?.("chainChanged", () => location.reload());
    return A.me;
  };

  // Ask the backend to confirm a transaction on chain; resolves once credits are booked.
  A.confirmOnChain = async (txHash, onProgress) => {
    for (let i = 0; i < 90; i++) {
      const r = await A.api("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash }) });
      if (r.status === "confirmed") return r;
      if (r.status === "failed" || r.status === "ignored") throw new Error(r.reason || "The payment failed on chain. Nothing was charged.");
      onProgress?.(r.status === "confirming" ? `Confirming on chain, block ${r.confirmations} of ${r.required}` : "Waiting for the network");
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error("The network is slow. Your payment is safe: open your AI credits page in a minute and it will be there.");
  };

  A.store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  return A;
})();
