// Keys live in the OS keyring, never in a file (service `near-lab-testnet`, account = the NEAR account id):
//   - macOS: the login keychain, through `security`;
//   - Linux: the Secret Service (GNOME keyring, KWallet), through `secret-tool` (libsecret-tools);
//   - NO_KEYCHAIN set (`npm run demo` sets it for a judge's fresh run): this process only, forgotten
//     when it exits. That is the only way a key is ever kept in memory.
// Anywhere else, or if the keyring can't be reached, storing a key throws: a key is never kept where it
// could be lost. (A funded faucet account was lost once because a keyring check misread
// `secret-tool --version`'s exit code and fell back to memory; an earlier mistake.) A stored key is
// read back and compared before the caller gets to use it.
// (Adapted from near-verdict's jury/src/keys.ts, MIT, same author.)
import { execFileSync, spawnSync } from "node:child_process";

export const SERVICE = process.env.KEYCHAIN_SERVICE ?? "near-lab-testnet";
const memoryOnly = () => Boolean(process.env.NO_KEYCHAIN);
const memory = new Map<string, string>();

/** Which keyring this process uses. `secret-tool` is detected by whether it can be spawned at all
 *  (ENOENT), never by its exit code: `secret-tool --version` exits 2 even when it works. */
export function keyring(): "memory" | "macos" | "secret-tool" | "none" {
  if (memoryOnly()) return "memory";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") {
    const r = spawnSync("secret-tool", ["--version"], { stdio: "ignore" });
    return (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "none" : "secret-tool";
  }
  return "none";
}

function keychainGet(account: string): string | undefined {
  const k = keyring();
  if (k === "memory") return memory.get(account);
  if (k === "macos") {
    try {
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (k === "secret-tool") {
    // `lookup` prints the secret to its stdout (a pipe to this process only) and exits 1 when there is none.
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
    const v = r.status === 0 ? r.stdout.toString().trim() : "";
    return v || undefined;
  }
  return undefined;
}

/** Store a key and read it back. Throws (and keeps nothing anywhere) if it can't be stored or the
 *  read-back differs, so a caller can stop before the key controls anything. */
export function keychainSet(account: string, secret: string): void {
  const k = keyring();
  if (k === "memory") {
    memory.set(account, secret);
    return;
  }
  if (k === "macos") {
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", secret]);
  } else if (k === "secret-tool") {
    // The secret goes in on stdin, never on the command line (where `ps` would show it).
    const r = spawnSync("secret-tool", ["store", "--label", account, "service", SERVICE, "account", account], { input: secret, stdio: ["pipe", "ignore", "pipe"], timeout: 20_000 });
    if (r.error || r.status !== 0) throw new Error(`secret-tool couldn't store the key for ${account}: ${r.error?.message ?? r.stderr.toString().trim() ?? `exit ${r.status}`}`);
  } else {
    throw new Error(`no keyring here to keep ${account}'s key (macOS keychain, or secret-tool on Linux: apt install libsecret-tools). Set NO_KEYCHAIN=1 to keep it in this process only.`);
  }
  if (keychainGet(account) !== secret) throw new Error(`the key stored for ${account} didn't read back the same from the ${k} keyring; stopping before it is used`);
}

export function keychainLoad(account: string): string {
  const v = keychainGet(account);
  if (!v) throw new Error(keyring() === "memory" ? `no key for ${account} in this process (NO_KEYCHAIN)` : `no key for ${account} in the ${keyring()} keyring (service ${SERVICE})`);
  return v;
}

export function keychainHas(account: string): boolean {
  return keychainGet(account) !== undefined;
}
