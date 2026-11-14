// `npm run session`: play for real without the page's faucet guest (the usual way is the page's own
// "Play for real"). Two ways:
//
//   PLAYER=you.testnet KEY_you_testnet=ed25519:... npm run session
//     Your own testnet account (from any wallet; the key is its full-access key, read from that
//     environment variable only: KEY_ + the account id with dots and dashes as underscores). It
//     deposits DEPOSIT (default 0.3) NEAR into the game. Nothing of ours pays, and no faucet is asked.
//
//   npm run session
//     The builder's way: a new player under the deploy's funder, whose key is in the builder's keyring.
//
// Either way it adds a function-call key that can only call the game's methods, caps what that key
// may put at risk (the full-access key sets the cap), and prints the page URL with the session key
// in its fragment. Open it and races are real, with no wallet prompts. The session key exists only
// in that URL; it can't withdraw, transfer a ghost or name challengers.
import { KeyPair, type KeyPairString } from "near-api-js";
import { N, addSessionKey, call, keyed, subAccount, txLink } from "./src/near.ts";
import { SESSION_METHODS, SHARED_CONTRACT, SHARED_FUNDER } from "./src/world.ts";

const contract = process.env.GD ?? SHARED_CONTRACT;
const own = process.env.PLAYER;
const amount = process.env.DEPOSIT ?? (own ? "0.3" : "0.5");
const player = own ? keyed(own) : await subAccount(keyed(SHARED_FUNDER), `player-${Math.random().toString(36).slice(2, 7)}`, "0.8");
const d = await call(player, contract, "deposit", {}, BigInt(N(amount)), 30n);
if (!d.ok) throw new Error(`deposit: ${d.reason}`);
console.log(`${player.id}: deposited ${amount} NEAR into the game ${txLink(d.tx)}`);
const key = await addSessionKey(player, contract, SESSION_METHODS, "0.25");
const cap = await call(player, contract, "set_key_cap", { public_key: KeyPair.fromString(key as KeyPairString).getPublicKey().toString(), cap: N(amount) }, 1n, 30n);
console.log(`its session key may put at most ${amount} NEAR at risk ${txLink(cap.tx)}`);
const base = process.env.WEB ?? "http://localhost:5173/";
console.log(`\nOpen (the key is only in this fragment):\n${base}#contract=${contract}&session=${player.id}:${key}\n`);
