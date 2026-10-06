# AI Credits — pay-as-you-go USDT billing on BNB Smart Chain

Trust Wallet DApp Browser (ya koi bhi injected wallet) ke liye:
Check balance → user apni **spending limit** chunta hai → ek baar approve (kuch nahi kat-ta) →
jab usage ho, admin panel se **actual usage jitna** charge → backend on-chain verify.
Admin panel: customers (approved / charged / credits), charge history, credits ledger, settings.

## Kya kahan hai

| Path | Kaam |
|---|---|
| `contracts/MeteredBilling.sol` | Billing contract — user ki approval hi hard limit hai, user kabhi bhi stop kar sakta hai |
| `contracts/MockUSDT.sol` | Sirf local/testnet testing ke liye |
| `server/index.js` | Express + SQLite backend, on-chain verification, admin API |
| `public/index.html`, `app.js` | Home: Check balance → limit chuno → approve |
| `public/credits.html`, `credits.js` | User ka AI credits page (credits, approved/charged, stop) |
| `public/admin.html`, `admin.js` | Admin panel (`/admin.html`) |
| `public/common.js`, `site.css` | User pages ka shared code + design |
| `scripts/compile.js`, `deploy.js` | Compile + deploy |
| `test/e2e.js` | Local chain par poora flow test (35 checks) |

## Billing model (metered / postpaid)

1. **User limit set karta hai.** Page par suggested limits (50 / 200 / 1000 USDT) + custom amount. Bade users ($1000+) badi limit chunte hain. Ye sirf ek USDT `approve` hai — **turant kuch nahi kat-ta**.
2. **Usage ke baad admin charge karta hai.** Admin panel → Customers → amount daalo → Charge (owner wallet se sign). Amount fixed nahi hai, jitna usage hua utna.
3. **Contract ye guarantee deta hai** — admin bhi bypass nahi kar sakta:
   - Charge kabhi user ki bachi hui approval se zyada nahi ho sakta (allowance hard ceiling hai, har charge ke saath ghat-ti hai).
   - Limit badhane ka koi owner function nahi — sirf user khud dobara approve karke badha sakta hai.
   - User `stop()` kare to koi charge possible nahi, approval bachi ho tab bhi. Wallet se allowance zero karna bhi kaafi hai.
   - Paisa sirf `treasury` par jata hai. Treasury badalne mein 2 din ka public delay.
   - `maxPerCharge`: ek single charge ki extra ceiling (Settings mein set karo) — owner key chori ho to bhi ek baar mein poori limit nahi khinch sakta.
4. **Credits** alag ledger hai (Admin → Credits → Adjust). USDT charge = paisa, credits adjust = usage. Dono alag kaam hain.

## Local test

```
npm install
npm run compile
npm test
```

## Render par deploy

Contract admin panel se deploy hota hai (PC par kuch chalane ki zaroorat nahi):
`CONTRACT_ADDRESS` khaali chhodo → site setup mode me start hogi → `/admin.html` kholo (Trust Wallet DApp browser me) → login →
owner wallet connect → treasury address → Deploy contract → jo address dikhe use Render env me `CONTRACT_ADDRESS` me daal do.
Private key kahin store nahi hoti; jo wallet deploy karta hai wahi owner banta hai. (`npm run deploy` wala tareeka bhi chalta hai.)

1. Code ko ek **private** GitHub repo me push karo (`.env` push nahi hota, `.gitignore` me hai).
2. Render → New → Web Service → repo select karo. Runtime: Node · Build Command: `npm install` · Start Command: `npm start`
3. Environment variables: `RPC_URL`, `CHAIN_ID`, `USDT_ADDRESS`, `CONTRACT_ADDRESS` (admin panel se deploy ke baad), `CONFIRMATIONS`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `NODE_VERSION=22`.
   `PORT` Render khud deta hai. `DEPLOYER_KEY` Render par kabhi mat daalo.
4. Database: paid instance par Disk add karo (mount path `/var/data`) aur `DB_PATH=/var/data/app.db` set karo.
   Free plan par disk nahi hoti, to har restart par credits aur charge history ud jayegi (payments chain par safe rehti hain; admin "Verify a transaction manually" se wapas laa sakta hai).
5. Site: `https://<name>.onrender.com`, admin: `/admin.html`.

Production notes:
- HTTPS zaroori hai (Trust Wallet DApp browser http par wallet inject nahi karta).
- Owner wallet hi sab charge karta hai — use hardware wallet/multisig (Safe) par `transferOwnership` + `acceptOwnership` se shift karo.
- Settings → "max per single charge" zaroor set karo (apne sabse bade expected bill jitna).
- Dedicated RPC (Ankr/NodeReal/QuickNode) use karo; public RPC rate-limit karta hai.
- Contract ko BscScan par verify karo (solc 0.8.26, optimizer 200, evmVersion paris) taaki users terms khud padh saken.
- Mainnet par real paisa lagane se pehle contract ka independent review/audit karwao.

## Treasury badalna

`proposeTreasury(newAddress)` → 2 din wait → `applyTreasury()`. Turant badalne ka koi function nahi hai.
