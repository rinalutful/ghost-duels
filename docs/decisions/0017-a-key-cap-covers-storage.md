# 0017: A session key's cap covers everything a run takes, storage included

Amends [0010](0010-session-keys-have-a-spending-cap.md).

## Context

0010 capped stakes, pots and fees. The AI judge's second round set a key's cap to zero and played
100 practice runs through it: each paid its own storage from the balance, 0.45 NEAR in all.

## Decision

`start_run` counts stake or pot, fee, the refundable settlement reserve and the run's measured
storage toward the key's cap; `submit_run` counts a pending log's storage too when the signing key
has a cap. A key capped at zero can't start anything.

## Consequences

- `attack_zero_cap_key_cannot_burn_the_balance`. A practice run needs about 0.03 NEAR of cap (most
  of it the reserve, refunded at settlement but still counted as spent).
