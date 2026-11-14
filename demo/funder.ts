// `npm run funder`: one faucet draw (2026-11-10): a new funder for v4,
// near-ghost-duels-<random>.testnet. Its key goes to the OS keyring (macOS keychain, or secret-tool on
// Linux) and is read back BEFORE the faucet is asked; then the account's on-chain key is checked
// against the stored one. It refuses to run once the repo names its funder (V4_FUNDER in
// demo/src/world.ts): one draw per repo, unless the owner asks for v5's (OWNER_DRAW=v5). Prints the account id and balance, never the key.
import { KeyPair, type KeyPairString } from "near-api-js";
import { faucetAccount } from "./src/faucet.ts";
import { keychainLoad, keyring } from "./src/keys.ts";
import { balance, near, provider } from "./src/near.ts";
import { V4_FUNDER } from "./src/world.ts";

// A further draw (a funder for v5) is the repository owner's decision, never a script's default.
const forV5 = process.env.OWNER_DRAW === "v5";
if (V4_FUNDER && !forV5) throw new Error(`this repo's funder is ${V4_FUNDER} already: one faucet draw per repo (the owner may run OWNER_DRAW=v5 npm run funder for v5's)`);
const k = keyring();
if (k !== "macos" && k !== "secret-tool") throw new Error(`needs a real keyring (macOS keychain or secret-tool), not "${k}": the faucet was not asked`);
const id = await faucetAccount("near-ghost-duels");
const pk = KeyPair.fromString(keychainLoad(id) as KeyPairString).getPublicKey().toString();
const onChain = await provider.viewAccessKey({ accountId: id, publicKey: pk }).then(() => true, () => false);
console.log(`${id}: ${near(await balance(id))}; its key is in the ${k} keyring (service near-lab-testnet) and ${onChain ? "matches the account's access key" : "DOES NOT match any access key on chain"}`);
if (!onChain) process.exit(1);
console.log(forV5 ? `Next: CONFIRM_V5=1 V5_FUNDER=${id} npm run deploy-v5` : `Next: set V4_FUNDER = "${id}" in demo/src/world.ts, then npm run deploy-v4.`);
