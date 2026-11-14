// `npm run reclaim -- <account> [...]`: return a demo player's NEAR to the account that funded it.
// Withdraws its in-game balance from the live contract (v4; full-access key, 1 yoctoNEAR), then deletes the
// account with the funder as beneficiary. Keys come from the keychain. For cleaning up after demos
// and recordings, so funders stay within their limits.
import { actions } from "near-api-js";
import { balance, call, keyed, near, sendActions, view } from "./src/near.ts";
import { SHARED_CONTRACT } from "./src/world.ts";

for (const id of process.argv.slice(2)) {
  const parent = id.split(".").slice(1).join(".");
  const who = keyed(id);
  const inGame = BigInt(await view<string>(SHARED_CONTRACT, "get_balance", { account_id: id }));
  if (inGame > 0n) {
    const r = await call(who, SHARED_CONTRACT, "withdraw", {}, 1n, 30n);
    console.log(`${id}: withdrew ${near(inGame)} from the game ${r.ok ? "" : `(refused: ${r.reason})`}`);
  }
  const before = await balance(id);
  await sendActions(who, id, [actions.deleteAccount(parent)]);
  console.log(`${id}: deleted, ${near(before)} back to ${parent}`);
}
