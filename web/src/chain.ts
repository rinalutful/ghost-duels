// Testnet reads (plain JSON-RPC, no wallet) and real play with a guest account.
//
// "Play for real" makes a guest: this page generates a key pair, asks NEAR's public testnet faucet
// service to create an account for its public key (the faucet funds it; nothing of ours pays), then
// with that account's full-access key adds a function-call "session" key limited to the game's
// methods, deposits into the game and caps what the session key may put at risk. Races are signed
// with the session key (no prompts; the contract enforces its cap). Naming who may race your money,
// giving a ghost away, refilling, retiring and cashing out are signed with the guest's full-access
// key. Both keys live in this browser's localStorage and never leave it: it's a testnet guest.
// near-api-js is loaded only when signing, so the read-only page never depends on it.
// A session can also come from the URL fragment (#session=<account>:<key>, `npm run session`).
import type { Account, KeyPairString } from "near-api-js";
import { cleanGhost, cleanLog, cleanRun, contractFrom, type CleanGhost, type CleanRun } from "./rules.ts";

export const RPC = "https://test.rpc.fastnear.com";
/** A second public RPC, for when the first rate-limits (429) or fails. */
export const RPCS = [RPC, "https://near-testnet.drpc.org"];
import deploy from "../../res/deploy.json";
/** The game's own contract: the live deploy named in res/deploy.json. */
export const V4 = deploy.contract;
/** The contract version deployed there ("v4" until v5 is deployed: res/deploy.json). */
export const LIVE_VERSION = deploy.version;
/** The deploy this page reads: v4, or the one a link names with #contract=<account id> (anything
 *  that isn't an account id is ignored; what that contract answers is still never trusted as HTML). */
export const CONTRACT = (import.meta.env.VITE_GD as string | undefined) ?? contractFrom(new URLSearchParams(location.hash.slice(1)).get("contract"), V4);
export const EXPLORER = "https://testnet.nearblocks.io";
export const FAUCET = "https://helper.nearprotocol.com/account";
/** What a session key may call: never withdraw, set_key_cap, set_challengers or nft_transfer. */
export const SESSION_METHODS = ["start_run", "submit_run", "expire_run", "refill_ghost"];
const TGAS = 10n ** 12n;

export type Ghost = CleanGhost;
export type Run = CleanRun;
export type Signer = { id: string; account: Account };
export type Guest = { id: string; full: Signer; session: Signer; sessionPk: string };

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

async function rpc(body: unknown): Promise<{ result?: any; error?: unknown }> {
  let last: unknown = null;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.error && /Rate limit|429|Internal/i.test(JSON.stringify(j.error))) {
        last = j.error;
        continue;
      }
      return j;
    } catch (e) {
      last = String(e);
    }
  }
  return { error: last };
}

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const j = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: b64(JSON.stringify(args)) } });
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

/** Every ghost, 100 at a time, oldest first (at most `max`: the board never reads without end). */
export async function readGhosts(max = 600): Promise<Ghost[]> {
  const all: Ghost[] = [];
  for (let from = 0; from < max; from += 100) {
    const page = await view<unknown[]>("get_ghosts", { from_index: from, limit: 100 });
    all.push(...page.map(cleanGhost).filter((g) => g.id > 0));
    if (page.length < 100) break;
  }
  return all;
}
export const readGhost = async (id: number): Promise<Ghost | null> => {
  const g = await view<unknown>("get_ghost", { ghost_id: id });
  return g ? cleanGhost(g) : null;
};
export const readGhostLog = async (id: number) => cleanLog(await view<unknown>("get_ghost_log", { ghost_id: id }));
export const readRun = async (id: number): Promise<Run> => cleanRun(await view<unknown>("get_run", { run_id: id }));

async function accountExists(id: string): Promise<boolean> {
  const j = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } });
  return Boolean(j.result && !j.result.error);
}

export const near = (y: string | bigint) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(3);
/** "0.25" NEAR → yoctoNEAR, exactly (no floats). */
export function yocto(nearAmount: string): string {
  const m = nearAmount.trim().match(/^(\d+)(?:\.(\d{0,24}))?$/);
  if (!m) throw new Error(`not an amount of NEAR: "${nearAmount}"`);
  return (BigInt(m[1]) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0"))).toString();
}

async function signer(id: string, key: string): Promise<Signer> {
  const { Account, FailoverRpcProvider, JsonRpcProvider } = await import("near-api-js");
  const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));
  return { id, account: new Account(id, provider, key as KeyPairString) };
}

/** A session from the URL fragment: #session=<account>:<ed25519:secret> (`npm run session`). */
export async function fragmentSession(): Promise<Signer | null> {
  const raw = new URLSearchParams(location.hash.slice(1)).get("session");
  if (!raw) return null;
  const i = raw.indexOf(":");
  return signer(raw.slice(0, i), raw.slice(i + 1));
}

// ---------- the guest, kept in this browser ----------

const STORE = `ghost-duels-guest:${CONTRACT}`;
type Stored = { id: string; full: string; session?: string };
function load(): Stored | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "null") as Stored | null;
  } catch {
    return null;
  }
}
function save(s: Stored | null) {
  try {
    if (s) localStorage.setItem(STORE, JSON.stringify(s));
    else localStorage.removeItem(STORE);
  } catch {
    throw new Error("this browser won't keep the guest's keys (private mode or blocked storage), so it can't play for real");
  }
}

/** The guest this browser holds, if it finished setting up. */
export async function storedGuest(): Promise<Guest | null> {
  const s = load();
  if (!s?.session) return null;
  const { KeyPair } = await import("near-api-js");
  return { id: s.id, full: await signer(s.id, s.full), session: await signer(s.id, s.session), sessionPk: KeyPair.fromString(s.session as KeyPairString).getPublicKey().toString() };
}

/** A half-made guest (the account exists, the game isn't set up): finish it with `makeGuest`. */
export const pendingGuest = () => (load()?.session ? null : load()?.id ?? null);

export function forgetGuest() {
  save(null);
}

/** What to tell a visitor when NEAR's public testnet faucet won't make the guest account. */
export function faucetRefusal(status: number | null): string {
  const why = status === null ? "couldn't be reached" : status === 429 ? "has made its few accounts for this network address today (HTTP 429)" : `answered HTTP ${status}`;
  return `NEAR's public testnet faucet ${why}, so this page couldn't get you a test account. It isn't the game: try again later or from another network. With a testnet account of your own, the README's "If the faucet says no" gets you playing for real in one command.`;
}

/** Make (or finish making) the guest: account from the faucet, session key, deposit, cap. */
export async function makeGuest(say: (line: string) => void, deposit = "1", cap = "0.5"): Promise<Guest> {
  const { KeyPair, actions } = await import("near-api-js");
  let s = load();
  if (!s) {
    const key = KeyPair.fromRandom("ed25519");
    const id = `gd-${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10)}.testnet`;
    s = { id, full: key.toString() };
    save(s); // before the account exists: a reload can't lose a funded account's key
    say(`Asking NEAR's testnet faucet for ${id}…`);
    // The faucet is NEAR's, not ours: it makes a few accounts a day per network address and is
    // sometimes down. Say so plainly, and say what still works (README: "If the faucet says no").
    const r = await fetch(FAUCET, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }) }).catch(() => null);
    if (!r?.ok) {
      save(null);
      throw new Error(faucetRefusal(r?.status ?? null));
    }
  }
  for (let i = 0; i < 40 && !(await accountExists(s.id)); i++) await new Promise((ok) => setTimeout(ok, 1000));
  const full = await signer(s.id, s.full);
  const session = KeyPair.fromRandom("ed25519");
  say("Adding this page's game key (it can only play: no withdrawals, no transfers)…");
  await send(full, s.id, [actions.addFunctionCallAccessKey(session.getPublicKey(), CONTRACT, SESSION_METHODS, BigInt(yocto("0.25")))]);
  // Deposit what the wallet can spare (it keeps some for gas), and cap the game key.
  const wallet = BigInt((await full.account.getState()).balance.available);
  const want = BigInt(yocto(deposit));
  const spare = wallet - BigInt(yocto("0.35"));
  const amount = spare < want ? spare : want;
  if (amount < BigInt(yocto("0.1"))) throw new Error(`${s.id} has ${near(wallet)} NEAR: too little to deposit into the game`);
  say(`Depositing ${near(amount)} NEAR into the game and capping the game key at ${cap} NEAR…`);
  await send(full, CONTRACT, [
    actions.functionCall("deposit", {}, 30n * TGAS, amount),
    actions.functionCall("set_key_cap", { public_key: session.getPublicKey().toString(), cap: yocto(cap) }, 30n * TGAS, 1n),
  ]);
  s.session = session.toString();
  save(s);
  return { id: s.id, full, session: await signer(s.id, s.session), sessionPk: session.getPublicKey().toString() };
}

/** Cash out: withdraw the in-game balance, then close the guest account and send all its NEAR to
 *  `beneficiary` (your own account). The guest is gone afterwards. */
export async function cashOut(g: Guest, beneficiary: string, say: (line: string) => void): Promise<string> {
  const { actions } = await import("near-api-js");
  const bal = BigInt(await view<string>("get_balance", { account_id: g.id }));
  if (bal > 0n) {
    say(`Withdrawing ${near(bal)} NEAR from the game…`);
    await callGame(g.full, "withdraw", {}, 30n, 1n);
  }
  say(`Closing ${g.id}; everything goes to ${beneficiary}…`);
  const hash = await send(g.full, g.id, [actions.deleteAccount(beneficiary)]);
  forgetGuest();
  return hash;
}

// ---------- sending ----------

/** Sign here, send the same bytes until an RPC takes them (one hash, one nonce: resending is
 *  idempotent), then poll the `tx` RPC until FINAL. near-api-js' own FINAL wait hung for sub-account
 *  signers in testing, and some RPCs answer INCLUDED without the transaction (CLAUDE.md). */
async function send(s: Signer, receiverId: string, acts: unknown[]): Promise<string> {
  const { baseEncode, encodeTransaction } = await import("near-api-js");
  const signed = await s.account.createSignedTransaction({ receiverId, actions: acts as never });
  const hash = baseEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encodeTransaction(signed.transaction) as BufferSource)));
  const tx = btoa(String.fromCharCode(...signed.encode()));
  for (let i = 0; i < 6; i++) {
    const j = await rpc({ jsonrpc: "2.0", id: 1, method: "send_tx", params: { signed_tx_base64: tx, wait_until: "INCLUDED" } });
    if (!j.error) break;
    if (/InvalidTx|NotEnoughBalance|InvalidNonce|Expired/.test(JSON.stringify(j.error))) throw new Error(JSON.stringify(j.error).slice(0, 160));
    await new Promise((ok) => setTimeout(ok, 800));
  }
  for (let i = 0; i < 90; i++) {
    const j = await rpc({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: s.id, wait_until: "FINAL" } });
    if (j.result?.final_execution_status === "FINAL") {
      lastResult = { hash, status: j.result.status };
      // A later receipt's failure counts too (a promise the call made), except the gas refund to an
      // account this very transaction deleted (cash out), which always "fails".
      const later = j.result.receipts_outcome?.map((o: { outcome: { status: { Failure?: unknown } } }) => o.outcome.status.Failure).find((f: unknown) => f && !JSON.stringify(f).includes("AccountDoesNotExist"));
      const failure = j.result.status.Failure ?? later;
      if (failure) {
        const text = JSON.stringify(failure);
        throw new Error(text.match(/panicked: ([^"\\]+)/)?.[1] ?? text.slice(0, 160));
      }
      return hash;
    }
    await new Promise((ok) => setTimeout(ok, 700));
  }
  throw new Error(`transaction ${hash} not final yet; check ${EXPLORER}/txns/${hash}`);
}
let lastResult: { hash: string; status: { SuccessValue?: string } } | null = null;

/** Call the game. `deposit` 1 yoctoNEAR marks the account's full-access key (naming challengers,
 *  giving a ghost away); a session key attaches nothing. Returns the method's value and the tx. */
export async function callGame<T>(s: Signer, method: string, args: Record<string, unknown>, tgas = 100n, deposit = 0n): Promise<T> {
  const { actions } = await import("near-api-js");
  await send(s, CONTRACT, [actions.functionCall(method, args, tgas * TGAS, deposit)]);
  const v = lastResult?.status.SuccessValue;
  return (v ? JSON.parse(atob(v)) : null) as T;
}
/** start_run / submit_run: the run the contract returned, coerced (null when it returned none). */
export async function callRun(s: Signer, method: string, args: Record<string, unknown>, tgas = 100n, deposit = 0n): Promise<Run | null> {
  const v = await callGame<unknown>(s, method, args, tgas, deposit);
  return v ? cleanRun(v) : null;
}

/** The last transaction this page sent (for its explorer link). */
export const lastTx = () => lastResult?.hash ?? null;
