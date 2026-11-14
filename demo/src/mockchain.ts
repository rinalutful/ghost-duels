// A stand-in for NEAR testnet, for the page test's mocked-chain pass: it answers the page's JSON-RPC
// (views, the access-key and block reads that local signing needs, send_tx and the tx poll) from a
// state held here, and lets a test hold a transaction to look at the page while it is pending.
// Every other request leaves this machine nowhere: it is aborted and listed in `escaped` (the faucet
// answers a fixed status, so "Play for real" can be tested without NEAR's real faucet). Nothing is
// signed for the real network: the page signs with throwaway keys made in the test.
import { createHash, randomBytes } from "node:crypto";
import { baseEncode } from "near-api-js";
import type { Page, Route } from "playwright";

export const RPC_HOSTS = ["test.rpc.fastnear.com", "near-testnet.drpc.org"];
export const FAUCET = "https://helper.nearprotocol.com/account";
const NEAR = 10n ** 24n;
export const yocto = (n: number) => (BigInt(Math.round(n * 1000)) * (NEAR / 1000n)).toString();
const BLOCK = baseEncode(new Uint8Array(32).fill(7));

export type Ghost = Record<string, unknown> & { id: number; owner: string; pot: string; stake: string; score: number; challengers: string[] };
export type Call = { method: string; args: Record<string, unknown>; signer: string; at: number };

/** A ghost as `get_ghosts` returns it, with the given fields changed. */
export function ghost(id: number, o: Partial<Ghost> = {}): Ghost {
  return {
    id, owner: "alice.testnet", pilot: "alice.testnet", score: 150, metres: 100, gems: 2, ticks: 900, pot: yocto(0.2), stake: yocto(0.05), qualified_pot: yocto(0.2), grown_in_pot: "0",
    defended: 0, forfeits: 0, beaten: 0, best_challenge: 0, earned: "0", grown: "0", raked: "0", racing: 0, seed: createHash("sha256").update(`seed ${id}`).digest("hex"),
    log_hash: createHash("sha256").update(`log ${id}`).digest("hex"), challengers: [], pot_locked_until_ms: 0, ...o,
  };
}

/** Borsh: the signer, receiver and first action of a signed transaction, and its hash. */
function decode(b64: string): { hash: string; signer: string; method: string; args: Record<string, unknown> } {
  const b = Buffer.from(b64, "base64");
  let o = 0;
  const u32 = () => ((o += 4), b.readUInt32LE(o - 4));
  const str = () => {
    const n = u32();
    return ((o += n), b.subarray(o - n, o).toString("utf8"));
  };
  const signer = str();
  o += 1 + 32 + 8; // public key (ed25519), nonce
  str(); // receiver
  o += 32; // block hash
  u32(); // number of actions
  const tag = b[o++];
  let method = "";
  let args: Record<string, unknown> = {};
  if (tag === 2) {
    method = str();
    const n = u32();
    try {
      args = JSON.parse(b.subarray(o, o + n).toString("utf8"));
    } catch {
      args = {};
    }
  } else method = ["create_account", "deploy", "call", "transfer", "stake", "add_key", "delete_key", "delete_account"][tag] ?? `action ${tag}`;
  // The signature is the last 65 bytes (ed25519: a type byte and 64); the hash is of the rest.
  const hash = baseEncode(createHash("sha256").update(b.subarray(0, b.length - 65)).digest());
  return { hash, signer, method, args };
}

export class MockChain {
  ghosts: Ghost[] = [];
  calls: Call[] = [];
  escaped: string[] = [];
  faucet: number[] = [];
  /** Delay for view calls, by method (to look at the page while a read is in flight). */
  slow: Record<string, number> = {};
  /** How long a run may last, as start_run's run says (deadline_ms - started_ms). */
  runSecs = 90;
  /** What submit_run says about a challenge. */
  verdict: "Won" | "Lost" = "Lost";
  /** A method that panics, and its message (a refused call). */
  refuse: Record<string, string> = {};
  faucetStatus = 429;
  /** Delay for the game's own wasm (the page's first paint, before it can draw). */
  slowWasm = 0;
  private runs = new Map<number, Record<string, unknown>>();
  private nextRun = 100;
  private nonce = 1;
  private done = new Map<string, { method: string; status: unknown }>();
  /** When the page learned each transaction was final (the tx poll answered FINAL). */
  landed: { method: string; at: number }[] = [];
  private holds = new Map<string, { gate: Promise<void>; open: () => void }>();

  /** Hold every `method` transaction at send_tx until the returned function is called. */
  hold(method: string): () => void {
    let open = () => {};
    const gate = new Promise<void>((ok) => (open = ok));
    this.holds.set(method, { gate, open });
    return () => {
      this.holds.delete(method);
      open();
    };
  }
  count = (method: string) => this.calls.filter((c) => c.method === method).length;

  async install(page: Page) {
    await page.route("**/*", (r) => this.handle(r));
  }

  private async handle(r: Route) {
    const url = new URL(r.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      if (this.slowWasm && url.pathname.endsWith(".wasm")) await new Promise((ok) => setTimeout(ok, this.slowWasm));
      return r.continue();
    }
    if (url.href.startsWith(FAUCET)) {
      this.faucet.push(this.faucetStatus);
      return r.fulfill({ status: this.faucetStatus, contentType: "application/json", body: "{}" });
    }
    if (!RPC_HOSTS.includes(url.hostname)) {
      this.escaped.push(url.href);
      return r.abort();
    }
    const body = JSON.parse(r.request().postData() ?? "{}");
    const result = await this.rpc(body.method, body.params).catch((e) => ({ error: { name: "HANDLER_ERROR", cause: { name: String(e) } } }));
    await r.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, ...result }) }).catch(() => {});
  }

  private async rpc(method: string, p: Record<string, any>): Promise<{ result?: unknown; error?: unknown }> {
    if (method === "block") return { result: { header: { hash: BLOCK, height: 1000, timestamp: 0 }, chunks: [] } };
    if (method === "query" && p.request_type === "view_access_key") return { result: { nonce: this.nonce++, permission: "FullAccess", block_height: 1000, block_hash: BLOCK } };
    if (method === "query" && p.request_type === "view_account") return { result: { amount: yocto(5), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, storage_paid_at: 0, block_height: 1000, block_hash: BLOCK } };
    if (method === "query" && p.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8") || "{}");
      if (this.slow[p.method_name]) await new Promise((ok) => setTimeout(ok, this.slow[p.method_name]));
      const v = this.view(p.method_name, args);
      return { result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1000, block_hash: BLOCK } };
    }
    if (method === "send_tx") {
      const t = decode(p.signed_tx_base64);
      this.calls.push({ method: t.method, args: t.args, signer: t.signer, at: Date.now() });
      await this.holds.get(t.method)?.gate;
      this.done.set(t.hash, { method: t.method, status: this.outcome(t.method, t.args) });
      return { result: { final_execution_status: "INCLUDED" } };
    }
    if (method === "tx") {
      const d = this.done.get(p.tx_hash);
      if (!d) return { result: { final_execution_status: "INCLUDED", status: {}, receipts_outcome: [] } };
      this.landed.push({ method: d.method, at: Date.now() });
      const status = d.status;
      return { result: { final_execution_status: "FINAL", status, transaction: { hash: p.tx_hash }, receipts_outcome: [] } };
    }
    return { error: { name: "UNKNOWN", cause: { name: `no mock for ${method}` } } };
  }

  private view(method: string, a: Record<string, any>): unknown {
    switch (method) {
      case "get_config":
        return { replay_fee: "0" };
      case "get_ghosts":
        return this.ghosts.slice(a.from_index ?? 0, (a.from_index ?? 0) + (a.limit ?? 100));
      case "get_ghost":
        return this.ghosts.find((g) => g.id === a.ghost_id) ?? null;
      case "get_ghost_log": {
        const g = this.ghosts.find((x) => x.id === a.ghost_id);
        return g ? { seed: g.seed, log: [20, 40, 70, 90, 120, 140, 170, 190, 220, 240] } : null;
      }
      case "get_balance":
        return yocto(2);
      case "get_key_cap":
        return { cap: yocto(0.5), spent: "0" };
      case "get_run":
        return this.runs.get(a.run_id) ?? null;
      default:
        return null;
    }
  }

  private outcome(method: string, a: Record<string, any>): unknown {
    if (this.refuse[method]) return { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${this.refuse[method]}` } } } } };
    const value = (v: unknown) => ({ SuccessValue: v === undefined ? "" : Buffer.from(JSON.stringify(v)).toString("base64") });
    if (method === "start_run") {
      const now = Date.now();
      const g = this.ghosts.find((x) => x.id === a.ghost_id);
      const run = { id: this.nextRun++, seed: randomBytes(32).toString("hex"), status: "Playing", note: null, stake: a.qualify ? a.qualify.stake : g?.stake ?? "0", minted: null, started_ms: now, deadline_ms: now + this.runSecs * 1000, replay: null, ghost_id: a.ghost_id ?? null, qualify: a.qualify ?? null };
      this.runs.set(run.id, run);
      return value(run);
    }
    if (method === "submit_run") {
      const run = this.runs.get(a.run_id) as Record<string, any>;
      const score = a.claimed_score as number;
      const replay = { score, via: "on-chain: this contract replayed the log" };
      if (run.qualify) {
        const id = Math.max(0, ...this.ghosts.map((g) => g.id)) + 1;
        this.ghosts.push(ghost(id, { owner: this.calls.at(-1)!.signer, pot: run.qualify.pot, stake: run.qualify.stake, challengers: run.qualify.challengers ?? [], score }));
        Object.assign(run, { status: "Minted", minted: id, note: `${score} points: minted as ghost #${id}`, replay });
      } else {
        const g = this.ghosts.find((x) => x.id === run.ghost_id)!;
        Object.assign(run, { status: this.verdict, note: this.verdict === "Won" ? `beat ghost #${g.id} (${score} vs ${g.score})` : `ghost #${g.id} held (${g.score} vs ${score})`, replay });
      }
      return value(run);
    }
    return value(null);
  }
}
