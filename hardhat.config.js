// Hardhat is only used as a local test chain (`npm run chain`).
// Contracts are compiled with scripts/compile.js, so sources point at an empty folder.
module.exports = {
  paths: { sources: "./.hh-empty" },
  networks: { hardhat: { chainId: 31337 } },
};
