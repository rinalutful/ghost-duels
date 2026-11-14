// A small NEAR host for Node: it runs a contract's wasm (the committed res/ghost_duels.wasm, the bytes a
// deploy runs) one receipt at a time, the way the runtime does: a fresh instance per call, the call's
// input and context, storage read from and written to this contract's own map, and nothing kept if the
// call panics. It implements the host functions near-sdk 5.29 imports for this contract, and records
// the promises a call creates instead of running them: the caller decides when a callback runs and what
// result it sees. A host function it doesn't implement throws when called, so nothing passes by being
// skipped. (Shared with our near-account-nfts and near-swarm-for-hire repos, MIT; the signer's public
// key was added here for session-key caps, and ecrecover dropped.)
//
// Not emulated: gas (prepaid gas is reported, nothing is metered), the protocol's own checks on access
// keys (that a function-call key can't attach a deposit is the chain's rule, taken as given), other
// accounts. Storage is counted by a fixed rule (key + value + 40 bytes an entry), close to the chain's
// but not equal. Those are what the local-node suite (npm run judge:full) and the testnet demos cover.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const U64_MAX = (1n << 64n) - 1n;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type Action =
  | { kind: "transfer"; amount: bigint }
  | { kind: "call"; method: string; args: Uint8Array; deposit: bigint; gas: bigint }
  | { kind: "create_account" }
  | { kind: "deploy"; code: Uint8Array }
  | { kind: "add_function_call_key"; publicKey: Uint8Array; allowance: bigint; receiver: string; methods: string }
  | { kind: "add_full_access_key"; publicKey: Uint8Array }
  | { kind: "delete_key"; publicKey: Uint8Array }
  | { kind: "delete_account"; beneficiary: string };
/** A promise the call created: a batch of actions on `receiver`, maybe waiting on others (`then`, `and`). */
export type Receipt = { index: number; receiver: string; actions: Action[]; after: number[]; and?: number[] };

export type Ctx = {
  predecessor: string;
  deposit?: bigint;
  /** Promise results a callback sees, in order: bytes for a success, null for a failure. */
  results?: (Uint8Array | null)[];
  gas?: bigint;
  timestampMs?: number;
  /** The signing key (borsh: curve byte + 32 bytes), for a call signed by a session key. */
  signerPk?: Uint8Array;
};
export type Outcome =
  | { ok: true; value: Uint8Array | null; logs: string[]; receipts: Receipt[]; returned: number | null }
  | { ok: false; error: string; logs: string[] };

class Panic extends Error {}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class Contract {
  readonly module: WebAssembly.Module;
  storage = new Map<string, Uint8Array>();
  /** yoctoNEAR on the contract's account: grows by what a call attaches, shrinks by the transfers it schedules. */
  balance = 0n;
  private calls = 0;

  constructor(readonly id: string, wasm: Uint8Array | string) {
    this.module = new WebAssembly.Module(typeof wasm === "string" ? readFileSync(wasm) : wasm);
  }

  /** Run one receipt: `method` with `args` (JSON, or raw bytes). Storage and balance changes are kept only if it doesn't panic. */
  call(method: string, args: unknown, ctx: Ctx): Outcome {
    const input = args instanceof Uint8Array ? args : enc.encode(args === undefined ? "" : JSON.stringify(args));
    return this.run(method, input, ctx);
  }

  private run(method: string, input: Uint8Array, ctx: Ctx): Outcome {
    const seed = createHash("sha256").update(`block ${this.calls++}`).digest();
    const balance = this.balance + (ctx.deposit ?? 0n);
    const storage = new Map(this.storage);
    const regs = new Map<bigint, Uint8Array>();
    const logs: string[] = [];
    const receipts: Receipt[] = [];
    let value: Uint8Array | null = null;
    let returned: number | null = null;
    let mem: WebAssembly.Memory;
    const bytes = (len: bigint, ptr: bigint) => new Uint8Array(mem.buffer, Number(ptr), Number(len)).slice();
    const put = (ptr: bigint, b: Uint8Array) => new Uint8Array(mem.buffer).set(b, Number(ptr));
    const u128 = (ptr: bigint) => {
      const b = bytes(16n, ptr);
      return b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
    };
    const putU128 = (ptr: bigint, v: bigint) => put(ptr, Uint8Array.from({ length: 16 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn)));
    const reg = (id: bigint, b: Uint8Array) => void regs.set(id, b);
    const receipt = (i: bigint) => receipts[Number(i)] ?? fail(`no promise ${i}`);
    const fail = (why: string): never => { throw new Error(`host: ${why}`); };
    const results = ctx.results ?? [];

    const host: Record<string, (...a: bigint[]) => bigint | void> = {
      read_register: (id, ptr) => put(ptr, regs.get(id) ?? fail(`register ${id} is empty`)),
      register_len: (id) => (regs.has(id) ? BigInt(regs.get(id)!.length) : U64_MAX),
      write_register: (id, len, ptr) => reg(id, bytes(len, ptr)),
      current_account_id: (r) => reg(r, enc.encode(this.id)),
      predecessor_account_id: (r) => reg(r, enc.encode(ctx.predecessor)),
      signer_account_id: (r) => reg(r, enc.encode(ctx.predecessor)),
      input: (r) => reg(r, input),
      block_timestamp: () => BigInt(ctx.timestampMs ?? 1_762_000_000_000) * 1_000_000n,
      attached_deposit: (ptr) => putU128(ptr, ctx.deposit ?? 0n),
      account_balance: (ptr) => putU128(ptr, balance),
      random_seed: (r) => reg(r, seed),
      // The key that signed the transaction, as near-sdk reads it: a curve byte (0, ed25519) and 32 bytes.
      signer_account_pk: (r) => reg(r, ctx.signerPk ?? fail("this call has no signer key set")),
      prepaid_gas: () => ctx.gas ?? 300_000_000_000_000n,
      used_gas: () => 0n,
      storage_usage: () => BigInt([...storage].reduce((n, [k, v]) => n + k.length / 2 + v.length + 40, 100)),
      sha256: (len, ptr, r) => reg(r, createHash("sha256").update(bytes(len, ptr)).digest()),
      value_return: (len, ptr) => { value = bytes(len, ptr); },
      log_utf8: (len, ptr) => void logs.push(dec.decode(bytes(len, ptr))),
      panic_utf8: (len, ptr) => { throw new Panic(dec.decode(bytes(len, ptr))); },
      panic: () => { throw new Panic("explicit guest panic"); },
      storage_write: (kl, kp, vl, vp, r) => {
        const k = hex(bytes(kl, kp)), old = storage.get(k);
        storage.set(k, bytes(vl, vp));
        if (old) reg(r, old);
        return old ? 1n : 0n;
      },
      storage_read: (kl, kp, r) => {
        const v = storage.get(hex(bytes(kl, kp)));
        if (v) reg(r, v);
        return v ? 1n : 0n;
      },
      storage_remove: (kl, kp, r) => {
        const k = hex(bytes(kl, kp)), old = storage.get(k);
        if (old) { reg(r, old); storage.delete(k); }
        return old ? 1n : 0n;
      },
      storage_has_key: (kl, kp) => (storage.has(hex(bytes(kl, kp))) ? 1n : 0n),
      promise_batch_create: (len, ptr) => BigInt(receipts.push({ index: receipts.length, receiver: dec.decode(bytes(len, ptr)), actions: [], after: [] }) - 1),
      promise_batch_then: (i, len, ptr) => {
        receipt(i);
        return BigInt(receipts.push({ index: receipts.length, receiver: dec.decode(bytes(len, ptr)), actions: [], after: [Number(i)] }) - 1);
      },
      promise_and: (ptr, count) => {
        const ids = Array.from({ length: Number(count) }, (_, k) => Number(new DataView(mem.buffer).getBigUint64(Number(ptr) + 8 * k, true)));
        return BigInt(receipts.push({ index: receipts.length, receiver: "", actions: [], after: [], and: ids }) - 1);
      },
      promise_return: (i) => { receipt(i); returned = Number(i); },
      promise_batch_action_transfer: (i, amount) => void receipt(i).actions.push({ kind: "transfer", amount: u128(amount) }),
      promise_batch_action_function_call: (i, nl, np, al, ap, amount, gas) =>
        void receipt(i).actions.push({ kind: "call", method: dec.decode(bytes(nl, np)), args: bytes(al, ap), deposit: u128(amount), gas }),
      promise_batch_action_function_call_weight: (i, nl, np, al, ap, amount, gas) =>
        void receipt(i).actions.push({ kind: "call", method: dec.decode(bytes(nl, np)), args: bytes(al, ap), deposit: u128(amount), gas }),
      promise_batch_action_create_account: (i) => void receipt(i).actions.push({ kind: "create_account" }),
      promise_batch_action_deploy_contract: (i, len, ptr) => void receipt(i).actions.push({ kind: "deploy", code: bytes(len, ptr) }),
      promise_batch_action_add_key_with_function_call: (i, pl, pp, _nonce, allowance, rl, rp, ml, mp) =>
        void receipt(i).actions.push({ kind: "add_function_call_key", publicKey: bytes(pl, pp), allowance: u128(allowance), receiver: dec.decode(bytes(rl, rp)), methods: dec.decode(bytes(ml, mp)) }),
      promise_batch_action_add_key_with_full_access: (i, pl, pp) => void receipt(i).actions.push({ kind: "add_full_access_key", publicKey: bytes(pl, pp) }),
      promise_batch_action_delete_key: (i, pl, pp) => void receipt(i).actions.push({ kind: "delete_key", publicKey: bytes(pl, pp) }),
      promise_batch_action_delete_account: (i, len, ptr) => void receipt(i).actions.push({ kind: "delete_account", beneficiary: dec.decode(bytes(len, ptr)) }),
      promise_results_count: () => BigInt(results.length),
      promise_result: (i, r) => {
        if (i >= BigInt(results.length)) fail(`no promise result ${i}`);
        const res = results[Number(i)];
        if (res === null) return 2n;
        reg(r, res);
        return 1n;
      },
    };
    const imports: Record<string, WebAssembly.ImportValue> = {};
    for (const imp of WebAssembly.Module.imports(this.module)) {
      imports[imp.name] = host[imp.name] ?? ((): never => fail(`${imp.name} isn't emulated`));
    }
    const instance = new WebAssembly.Instance(this.module, { env: imports });
    mem = instance.exports.memory as WebAssembly.Memory;
    const fn = instance.exports[method] as (() => void) | undefined;
    if (!fn) return { ok: false, error: `MethodNotFound: ${method}`, logs };
    try {
      fn();
    } catch (e) {
      if (e instanceof Panic) return { ok: false, error: e.message, logs };
      if (e instanceof WebAssembly.RuntimeError) return { ok: false, error: `wasm trap: ${e.message}`, logs };
      throw e;
    }
    this.storage = storage;
    this.balance = balance - transferred(receipts);
    return { ok: true, value, logs, receipts, returned };
  }

  /** A view: run it on a copy, so nothing it does is kept. */
  view<T = unknown>(method: string, args: unknown = {}): T {
    const saved = this.storage, balance = this.balance;
    const r = this.call(method, args, { predecessor: "viewer.near" });
    this.storage = saved;
    this.balance = balance;
    if (!r.ok) throw new Error(`${method}: ${r.error}`);
    return (r.value ? JSON.parse(dec.decode(r.value)) : null) as T;
  }
}

export const json = (o: Outcome) => (o.ok && o.value ? JSON.parse(dec.decode(o.value)) : undefined);
export const text = (b: Uint8Array) => dec.decode(b);
export const bytesOf = (s: string) => enc.encode(s);

/** The calls a receipt list makes to `method`, with their JSON arguments. */
export function scheduled(rs: Receipt[], method: string): { receiver: string; args: any; deposit: bigint }[] {
  return rs.flatMap((r) => r.actions.flatMap((a) => (a.kind === "call" && a.method === method
    ? [{ receiver: r.receiver, args: a.args.length ? safeJson(a.args) : undefined, deposit: a.deposit }] : [])));
}
const safeJson = (b: Uint8Array) => { try { return JSON.parse(dec.decode(b)); } catch { return b; } };

/** NEAR sent by the transfers in a receipt list, to `to` or to anyone. */
export function transferred(rs: Receipt[], to?: string): bigint {
  return rs.filter((r) => to === undefined || r.receiver === to)
    .flatMap((r) => r.actions).reduce((n, a) => n + (a.kind === "transfer" ? a.amount : 0n), 0n);
}
