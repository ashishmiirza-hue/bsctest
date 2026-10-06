# AI Credits — capped USDT subscriptions on BNB Smart Chain

Trust Wallet DApp Browser (ya koi bhi injected wallet) ke liye:
Connect → real USDT balance check → admin-set minimum par eligibility → disclosed, capped authorization →
first payment → backend on-chain verify → credits. Admin panel: plans, credit balances, payment history, charge/cancel.

## Kya kahan hai

| Path | Kaam |
|---|---|
| `contracts/CreditSubscriptions.sol` | Subscription contract (cap, period, cancel sab on-chain enforce) |
| `contracts/MockUSDT.sol` | Sirf local/testnet testing ke liye |
| `server/index.js` | Express + SQLite backend, verification, admin API |
| `public/index.html`, `app.js` | User DApp page |
| `public/admin.html`, `admin.js` | Admin panel (`/admin.html`) |
| `scripts/compile.js`, `deploy.js` | Compile + deploy |
| `test/e2e.js` | Local chain par poora flow test (34 checks) |

## Authorization kaise capped hai

User `approve` sirf **price × maxCharges** ka karta hai (unlimited kabhi nahi), aur spender contract hai, koi wallet nahi.
Contract khud ye guarantee deta hai — admin bhi inhe bypass nahi kar sakta:

- Har charge = wahi price jo subscribe ke time lock hui thi.
- Total charges ≤ `maxCharges` (first payment included). Uske baad subscription khud khatam.
- Do charges ke beech kam se kam ek `period`. Missed periods ka catch-up nahi hota.
- User kabhi bhi `cancel()` kar sakta hai; uske baad koi charge possible nahi.
- Paisa sirf `treasury` address par jata hai. Arbitrary amount nikalne ka koi function nahi hai.
- Plan terms immutable hain; badalna ho to plan close karke naya banao.

Renewal charge automatic nahi hai: admin panel → Subscriptions → **Charge** (owner wallet se sign). Private key server par nahi rehti.

## Local test

```
npm install
npm run compile
npm test
```

## Deploy (pehle BSC testnet par try karo)

1. `.env.example` ko `.env` me copy karo; `DEPLOYER_KEY`, `TREASURY_ADDRESS`, `ADMIN_PASSWORD`, `SESSION_SECRET` bharo.
   Testnet ke liye: `RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545`, `CHAIN_ID=97`, aur `npm run deploy -- --mock`.
2. Mainnet: `CHAIN_ID=56`, `USDT_ADDRESS=0x55d398326f99059fF775485246999027B3197955`, phir `npm run deploy`.
3. Output ka `CONTRACT_ADDRESS` `.env` me daalo. Deploy ke baad `DEPLOYER_KEY` ko server ke `.env` se hata do.
4. `npm start` → site `http://localhost:3000`, admin `http://localhost:3000/admin.html`.
5. Admin panel me owner wallet connect karke plan banao (price, period days, max charges, credits) aur Settings me minimum balance set karo.

Production notes:
- HTTPS zaroori hai (Trust Wallet DApp browser http par wallet inject nahi karta). Nginx/Caddy ke peeche chalao.
- Deployer wallet hi contract owner hai. Use hardware wallet/multisig par `transferOwnership` + `acceptOwnership` se shift karna behtar hai.
- Dedicated RPC (Ankr/NodeReal/QuickNode) use karo; public RPC rate-limit karta hai.
- `data/app.db` ka backup rakho (Render free plan disk persist nahi karta).
- Contract ko BscScan par verify karo (solc 0.8.26, optimizer 200 runs, evmVersion paris) taaki users terms khud padh saken.
- Mainnet par real paisa lagane se pehle contract ka independent review/audit karwao.

## Abhi kya nahi hai

- Credits kharch karne wali AI API (usage par credits debit) — abhi admin "Adjust credits" se manually debit hota hai.
- Auto-renew bot. Jaan-boojhkar manual rakha hai.
- Admin panel users ka wallet USDT balance nahi dikhata; "balances" = credit balances.

## Render par deploy

Contract admin panel se deploy hota hai (PC par kuch chalane ki zaroorat nahi):
`CONTRACT_ADDRESS` khaali chhodo → site setup mode me start hogi → `/admin.html` kholo (Trust Wallet DApp browser me) → login →
owner wallet connect → Deploy contract → jo address dikhe use Render env me `CONTRACT_ADDRESS` me daal do.
Private key kahin store nahi hoti; jo wallet deploy karta hai wahi owner banta hai. (`npm run deploy` wala tareeka bhi chalta hai.)

1. Code ko ek **private** GitHub repo me push karo (`.env` push nahi hota, `.gitignore` me hai).
2. Render → New → Web Service → repo select karo.
   - Runtime: Node · Build Command: `npm install` · Start Command: `npm start`
3. Environment variables: `RPC_URL`, `CHAIN_ID`, `USDT_ADDRESS`, `CONTRACT_ADDRESS` (admin panel se deploy ke baad), `CONFIRMATIONS`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `NODE_VERSION=22`.
   `PORT` Render khud deta hai. `DEPLOYER_KEY` Render par kabhi mat daalo.
4. Database: paid instance par Disk add karo (mount path `/var/data`) aur `DB_PATH=/var/data/app.db` set karo.
   Free plan par disk nahi hoti, to har restart par credits aur payment history ud jayegi.
5. Site: `https://<name>.onrender.com`, admin: `/admin.html`.

## Treasury badalna

`proposeTreasury(newAddress)` → 2 din wait → `applyTreasury()`. Turant badalne ka koi function nahi hai.
