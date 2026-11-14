// One account from the public testnet faucet. Its key is stored in the keyring (or, with NO_KEYCHAIN,
// this process) and read back BEFORE the faucet is asked, so a funded account can never exist whose
// key was lost. The faucet allows a few accounts a day per IP.
import { KeyPair } from "near-api-js";
import { keychainLoad, keychainSet } from "./keys.ts";
import { RPC } from "./near.ts";

const FAUCET = process.env.FAUCET ?? "https://helper.nearprotocol.com/account";

export async function faucetAccount(prefix: string): Promise<string> {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}.testnet`;
  const key = KeyPair.fromRandom("ed25519");
  keychainSet(id, key.toString()); // throws unless it reads back the same
  if (keychainLoad(id) !== key.toString()) throw new Error(`the key for ${id} didn't read back; the faucet was not asked`);
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`The faucet refused ${id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  // The faucet answers before its transaction is final; wait until the account shows up.
  for (let i = 0; i < 30; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }) });
    if (!(await r.json()).error) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return id;
}
