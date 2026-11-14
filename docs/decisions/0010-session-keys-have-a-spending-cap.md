# 0010: Session keys spend only up to a cap their account set

Supersedes the "stolen session key" consequence of [0007](0007-sessions-spend-an-in-game-balance.md).

## Context

0007 said a stolen session key "can lose the in-game balance". The AI judge showed it is worse: the
thief mints a ghost with a large stake and plays the victim's key against it with an empty log, an
honest loss that pays the thief 95% (5.000 to 2.998 NEAR in its test).

## Decision

- The contract sees the signing key (`env::signer_account_pk()`). Every method that puts balance at
  risk (`start_run`: stake, qualifier pot and fee; `refill_ghost`) checks a per-key cap:
  `key_caps[(account, public_key)] = {cap, spent}`, and refuses once `spent` would pass `cap`.
- **A key with no cap can't spend at all.** The cap is set with `set_key_cap(public_key, cap)`,
  which needs 1 yoctoNEAR, so only a full-access key can set it (the wallet confirms it with the
  deposit). `npm run session` and the demos set a 1 NEAR cap.
- A call with exactly 1 yoctoNEAR attached comes from a full-access key (a function-call key can't
  attach deposits): it is the account itself, and uncapped.
- `spent` is lifetime and doesn't come down with winnings: a cap is "how much this key may ever put
  at risk", like a prepaid card.

## Consequences

- A stolen key loses at most its cap (`attack_stolen_session_key_is_capped`).
- Players who play from a CLI with a full-access key attach 1 yoctoNEAR to `start_run`.
- A cap is per key, not per session time; expiring keys is the wallet's job (delete the key).
