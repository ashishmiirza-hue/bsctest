// Compiles contracts/*.sol into artifacts/<Name>.json ({ abi, bytecode }).
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const dir = path.join(__dirname, "..", "contracts");
const out = path.join(__dirname, "..", "artifacts");
const sources = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sol"))) {
  sources[f] = { content: fs.readFileSync(path.join(dir, f), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const result = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (result.errors || []).filter((e) => e.severity === "error");
for (const e of result.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync(out, { recursive: true });
for (const file of Object.keys(result.contracts)) {
  for (const [name, c] of Object.entries(result.contracts[file])) {
    if (!c.evm.bytecode.object) continue; // interfaces
    fs.writeFileSync(
      path.join(out, `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    console.log("compiled", name);
  }
}
