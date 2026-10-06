// Deploys CreditSubscriptions.
//
//   node scripts/deploy.js            -> uses USDT_ADDRESS from .env
//   node scripts/deploy.js --mock     -> also deploys MockUSDT (local chain / testnet only)
//
// Needs in .env: RPC_URL, DEPLOYER_KEY, TREASURY_ADDRESS, and USDT_ADDRESS unless --mock.
// MIN_PERIOD_SECONDS defaults to 86400 (one day); the contract refuses shorter plan periods.
require("dotenv").config();
const { ethers } = require("ethers");
const art = (n) => require(`../artifacts/${n}.json`);

(async () => {
  const mock = process.argv.includes("--mock");
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  const net = await provider.getNetwork();
  console.log("chain", net.chainId.toString(), "deployer", wallet.address);

  if (mock && net.chainId === 56n) throw new Error("--mock is not allowed on BSC mainnet");

  let usdt = process.env.USDT_ADDRESS;
  if (mock) {
    const m = art("MockUSDT");
    const c = await new ethers.ContractFactory(m.abi, m.bytecode, wallet).deploy();
    await c.waitForDeployment();
    usdt = await c.getAddress();
    console.log("MockUSDT", usdt);
  }
  if (!ethers.isAddress(usdt)) throw new Error("USDT_ADDRESS missing");
  const treasury = process.env.TREASURY_ADDRESS || wallet.address;
  const minPeriod = Number(process.env.MIN_PERIOD_SECONDS || 86400);

  const a = art("CreditSubscriptions");
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(usdt, treasury, minPeriod);
  await c.waitForDeployment();
  console.log("CreditSubscriptions", await c.getAddress());
  console.log("treasury", treasury, "minPeriod", minPeriod);
  console.log("\nPut these in .env:\nUSDT_ADDRESS=%s\nCONTRACT_ADDRESS=%s", usdt, await c.getAddress());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
