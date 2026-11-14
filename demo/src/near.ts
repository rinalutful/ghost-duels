// Testnet RPC, calls that return the contract's panic message instead of throwing, and accounts whose
// keys live in the keychain. (Adapted from near-verdict's jury/src/near.ts, MIT, same author.)
import { createHash } from "node:crypto";
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, actions, baseEncode, encodeTransaction, formatNearAmount, nearToYocto, type KeyPairString } from "near-api-js";
import { keychainLoad, keychainSet } from "./keys.ts";

export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
/** Public testnet RPCs rate-limit a busy IP (fastnear answers 429): fall over to the next. */
export const RPCS = [...new Set([RPC, "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"])];
export const EXPLORER = "https://testnet.nearblocks.io";

export const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url }, { retries: 3, backoff: 2, wait: 500 })));
export type Named = { id: string; account: Account };
export type Result = { ok: boolean; value?: unknown; reason?: string; tx?: string; logs?: string[]; gasBurnt?: bigint };

export const txLink = (tx?: string) => (tx ? `${EXPLORER}/txns/${tx}` : "(no tx)");
export const near = (y: bigint | string) => `${formatNearAmount(y.toString(), 3)} NEAR`;
export const N = (n: string) => nearToYocto(n as `${number}`).toString();

/** Whether an account exists (a plain RPC query: the failover provider logs every miss as an error). */
export async function exists(id: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(RPCS[i % RPCS.length], { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }) });
      const j = await r.json();
      if (j.result) return true;
      if (JSON.stringify(j.error ?? "").includes("UNKNOWN_ACCOUNT")) return false;
    } catch {
      // a timeout or a 429: ask the next RPC
    }
    await new Promise((ok) => setTimeout(ok, 800));
  }
  throw new Error(`couldn't tell whether ${id} exists: no RPC answered`);
}

export async function balance(id: string): Promise<bigint> {
  return BigInt((await provider.viewAccount({ accountId: id })).amount);
}

export function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return provider.callFunction({ contractId, method, args }) as Promise<T>;
}

/** An account whose key is in the keychain (or env KEY_<id with dots and dashes as _>). */
export function keyed(id: string): Named {
  const env = process.env[`KEY_${id.replace(/[.-]/g, "_")}`];
  const key = (env ?? keychainLoad(id)) as KeyPairString;
  return { id, account: new Account(id, provider, key) };
}

/** An account signing with a given key (a function-call session key, say). */
export function withKey(id: string, key: string): Named {
  return { id, account: new Account(id, provider, key as KeyPairString) };
}

/** Call a contract; a refusal comes back as `{ok: false, reason}` with the contract's own words. */
export async function call(who: Named, contractId: string, method: string, args: Record<string, unknown>, deposit = 0n, tgas = 150n): Promise<Result> {
  // An RPC hiccup (429, a 500) before the transaction is accepted is retried; a contract's refusal isn't.
  for (let attempt = 0; ; attempt++) {
    const r = await callOnce(who, contractId, method, args, deposit, tgas);
    if (r.ok || r.tx || attempt >= 3 || !/Internal server error|429|Rate limit|fetch failed|ECONNRESET|timed? ?out/i.test(r.reason ?? "")) return r;
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
  }
}

async function callOnce(who: Named, contractId: string, method: string, args: Record<string, unknown>, deposit: bigint, tgas: bigint): Promise<Result> {
  try {
    // Signed here, sent without waiting, then polled by its hash until FINAL (every receipt, callbacks
    // included). near-api-js' own FINAL wait hung for minutes on txs signed by sub-accounts on
    // 2026-10-30, and some RPCs answer INCLUDED without the transaction (CLAUDE.md).
    const hash = await submitTx(who, contractId, [actions.functionCall(method, args, tgas * 10n ** 12n, deposit)]);
    const r = await finalOutcome(hash, who.id);
    const logs = [...r.transaction_outcome.outcome.logs, ...r.receipts_outcome.flatMap((o) => o.outcome.logs)];
    const gasBurnt = BigInt(r.transaction_outcome.outcome.gas_burnt) + r.receipts_outcome.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
    const failure = r.receipts_outcome.map((o) => (o.outcome.status as { Failure?: unknown }).Failure).find(Boolean);
    const status = r.status as { SuccessValue?: string; Failure?: unknown };
    if (status.Failure) return { ok: false, reason: panicOf(JSON.stringify(status.Failure)), tx: r.transaction.hash, logs, gasBurnt };
    const value = status.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) : undefined;
    return { ok: true, value, tx: r.transaction.hash, logs, gasBurnt, ...(failure ? { reason: `a later receipt failed: ${panicOf(JSON.stringify(failure))}` } : {}) };
  } catch (e) {
    return { ok: false, reason: panicOf(String((e as Error)?.message ?? e)) };
  }
}

type Outcome = Awaited<ReturnType<Named["account"]["callFunctionRaw"]>>;

/** Sign once, send the same bytes until an RPC accepts them (resending a signed transaction is
 *  idempotent: it has one hash and one nonce), and return its hash. */
export async function submitTx(who: Named, receiverId: string, acts: ReturnType<typeof actions.transfer>[]): Promise<string> {
  const signed = await who.account.createSignedTransaction({ receiverId, actions: acts });
  const hash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
  const b64 = Buffer.from(signed.encode()).toString("base64");
  const fatal = /InvalidTxError|NotEnoughBalance|InvalidAccessKey|InvalidNonce|Expired/;
  let last = "";
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(RPCS[i % RPCS.length], { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send_tx", params: { signed_tx_base64: b64, wait_until: "INCLUDED" } }) });
      const j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
      if (!j.error) return hash;
      last = JSON.stringify(j.error).slice(0, 300);
    } catch (e) {
      last = String(e).slice(0, 300);
    }
    // An invalid transaction (bad nonce, no balance) won't get better by resending it.
    if (fatal.test(last)) throw new Error(last);
    await new Promise((ok) => setTimeout(ok, 1000 + 500 * i));
  }
  throw new Error(`no RPC accepted ${hash}: ${last}`);
}

/** Poll the `tx` RPC until the transaction and all its receipts are final. */
export async function finalOutcome(hash: string, sender: string): Promise<Outcome> {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(RPCS[i % RPCS.length], { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } }) });
      const j = await res.json();
      if (j.result?.final_execution_status === "FINAL") return j.result as Outcome;
    } catch {
      // a timed-out wait: ask again
    }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  throw new Error(`transaction ${hash} not final after 90 tries`);
}

function panicOf(text: string): string {
  return text.match(/Smart contract panicked: ([^\n"\\]+)/)?.[1] ?? text.match(/ExecutionError\W+([^"\\]+)/)?.[1] ?? text.slice(0, 240);
}

/** A sub-account of `parent`, funded from it; its key goes to the keychain (or this process only). */
export async function subAccount(parent: Named, name: string, nearAmount: string): Promise<Named> {
  const id = `${name}.${parent.id}`;
  const key = KeyPair.fromRandom("ed25519");
  await parent.account.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(nearAmount as `${number}`) });
  keychainSet(id, key.toString());
  return { id, account: new Account(id, provider, key.toString() as KeyPairString) };
}

/** Sign and send `acts` to `receiverId`, then wait until final (see `call`). Returns the tx hash. */
export async function sendActions(who: Named, receiverId: string, acts: ReturnType<typeof actions.transfer>[]): Promise<string> {
  const hash = await submitTx(who, receiverId, acts);
  await finalOutcome(hash, who.id);
  return hash;
}

/** Add a function-call key on `who` for `contractId`'s `methods` (a session key). */
export async function addSessionKey(who: Named, contractId: string, methods: string[], allowance: string): Promise<string> {
  const k = KeyPair.fromRandom("ed25519");
  await sendActions(who, who.id, [actions.addFunctionCallAccessKey(k.getPublicKey(), contractId, methods, nearToYocto(allowance as `${number}`))]);
  return k.toString();
}

export async function send(from: Named, to: string, nearAmount: string): Promise<void> {
  await sendActions(from, to, [actions.transfer(nearToYocto(nearAmount as `${number}`))]);
}
