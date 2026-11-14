# 0007: Sessions are function-call keys spending an in-game balance

## Context

The track gives a bonus "if players never notice the chain". A function-call access key signs
without prompts, but can't attach a deposit, so it can't pay a stake directly.

## Decision

Modeled on near-family-wallet: the player `deposit`s once into an in-game balance (the one step a
wallet confirms), and their app holds a function-call key limited to `start_run`, `submit_run`,
`mint_ghost` and `expire_run` on the game contract. Every game method spends the balance; none
takes a deposit. `withdraw` and `nft_transfer` require exactly 1 yoctoNEAR, so only a full-access
key can move money or ghosts out. The web page takes such a key from its URL fragment
(`npm run session` prints one); it never reaches a server.

## Consequences

- A stolen session key can't take money out, but it *can* lose the balance: stake it on runs that
  lose, possibly to a ghost the thief owns. Keep the balance small, like an arcade card; a per-session
  spending cap is an issue.
- Social login (NEAR Auth, or a FastAuth-style email login creating the account and its session key)
  is not built tonight: it's the next step, filed as an issue. The contract needs no change for it.
- Gas is paid from the key's allowance (0.25 NEAR covers dozens of runs on testnet).
