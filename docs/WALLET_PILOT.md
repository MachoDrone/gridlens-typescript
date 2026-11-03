# Wallet: controlled NOS transfer and rewards pilots

Wallet provides owner-controlled setup and the original single NOS transfer.
The separate rewards pilot below adds one reviewed full-rewards claim per host.
Source implementation does not establish publication or live claim acceptance.
Combined collection and forwarding rewards remain later work.

## Operator flow

Complete **Secure** on the browser/device and open the saved HTTPS address without
bypassing certificate warnings. Opening Wallet from HTTP returns to Secure and
then Wallet. Already connected HTTPS browsers do not repeat the guide. GridLens
cannot inspect the browser's certificate trust store.

After installing a Wallet-capable release, rerun that release's normal installer
command with `--treasury-setup` on the installation PC. It prints a private,
single-use HTTPS link valid for five minutes. Open it in the already connected
browser, set the owner password and enter the receiving public Solana address.
Never enter a wallet private key or seed phrase. Ordinary operator access and
Secure setup do not establish financial ownership.

Wallet requires the password on each entry/reload and locks after five minutes
without activity. Status polling does not extend authorization. Changing the
destination/password requires the current password, locks prior authorizations
and invalidates reviews. Installation-PC recovery uses `--treasury-reset` with an
explicit terminal confirmation. Recovery preserves transaction history and the
consumed allowance and requires destination confirmation again.

Select one host and review its full address, the full receiving address,
**exactly 1 NOS**, network fee and receiving token-account creation cost. The
source must retain 0.05 SOL; combined fee/account-creation cost cannot exceed
0.005 SOL. These are conservative application limits, not asserted Nosana host
minimums. Frozen accounts, changed identities, insufficient balances, unavailable
RPC capacity and expired reviews block signing. Staked NOS is untouched.

Confirmation reserves the installation's entire **1 NOS total** pilot allowance.
The application stops after this operation. Even an unsuccessful or uncertain
attempt stays locked for review; settings changes, password recovery, restart
and rollback cannot create another transfer allowance. The specific source and receiving
address must be reviewed before the live test. Repeated transfers, sweeping and
combined forwarding require later work. The separate rewards pilot does not reset
this transfer allowance.

## Authority and transaction boundary

Only the HTTPS gateway mounts the dedicated `treasury-ipc` volume, read-only. The
collection owner mounts it read/write and exposes a fixed financial dispatcher.
HTTP, the updater and preview do not mount it. Forwarded headers and request
flags cannot turn the shared read socket into financial authority. Wallet checks
actual TLS, exact saved origin/certificate identity, current app access and a
separate owner unlock. Passwords and unlock tokens stay out of URLs, browser
storage and logs; the setup ticket is removed from its fragment before requests.

The retained safety ledger stores a salted scrypt verifier and encrypted
configuration/operation records. A dedicated key in the protected credential
volume encrypts them; it is not a source wallet key. Installation administrators
and people controlling host private keys remain trusted. Protected runtimes add
[owner-bound source guardians](OWNER_BOUND_FINANCE.md), so staff viewers and
secondary installations cannot acquire authority by choosing another password.
Staff must not hold unrestricted source Docker/root access or hub credentials.
Legacy runtimes retain the earlier installation-local boundary. Missing or
corrupt financial state disables Wallet rather than granting a fresh owner or
allowance. Preserve the state for recovery; monitoring remains available.

The backend prepares an exact classic Token `TransferChecked` for the official
NOS mint and six decimals, optionally preceded by idempotent creation of the
receiving NOS associated token account. It verifies current chain accounts/costs,
PC/SSH identity and the running source container. A bundled helper independently
reconstructs and validates the permitted message before signing inside that
container. It returns only signed bytes and a signature and never broadcasts.
Existing wallet keys and reusable Nosana authorization never leave the source;
no dependencies are installed there. The helper is not a generic signing API.

The backend verifies and durably records the signed transaction before recording
submission intent and sending once. It never automatically re-signs or resubmits
the pilot. Unknown outcomes are checked using the recorded signature. Success
requires the finalized transaction's exact message, recipient and NOS changes to
match the review. RPC acknowledgment and rounded Fleet balances are not receipts.
Normal observations update Fleet independently. All RPC methods share the current
provider allowance; a receipt may remain pending until that allowance permits its
read. Capacity forecasts neither reserve nor increase the allowance.

Financial records remain outside rollbackable observation snapshots. Reset
cancels unsent work; submitted work continues reconciliation. Closing a browser
cannot reverse an already submitted blockchain transaction.

### Preparing a review while Fleet is collecting

A validated review is returned even when execution capacity is temporarily busy.
Preparation does not reserve the 1 NOS allowance or access a source signing key.
Confirmation checks capacity before reserving that allowance. A known rejection
keeps the review available until expiry and requires another explicit owner action;
an ambiguous confirmation response still requires checking activity before retrying.

The transfer path uses eight RPC methods with an already verified mainnet provider
(nine when genesis verification is needed), sharing the unchanged Fleet request
limits. Before signing, a current fee check and unsigned simulation validate the
fixed transfer, current token-account identities/states and resulting SOL reserve.
Normal balance changes need not equal the earlier review's balances. The resulting
preflight proof expires after 15 seconds and is bound to the exact signed bytes;
submission still requests RPC signature verification/preflight and no retries.
The review expires no later than 60 seconds after its verified bank timestamp;
a later response at the same stalled bank cannot renew that freshness proof.
The finalized receipt must still prove the exact token movement. Concurrent
external spending cannot be atomically prevented by these application checks.

Blocked reviews carry a finite reason code, distinguishing GridLens request
capacity, provider availability, balances, costs, account/source changes and
expired reviews. Raw exceptions, credentials, URLs and authorization material are
never forwarded. Retry times are shown only when the scheduler supplies one;
they describe local eligibility, not a promised provider recovery time.
Preparation has a 28-second RPC-phase bound including queue waits, a 35-second
owner-call bound and a 55-second browser bound including the preceding security
check. Other browser requests retain their existing 20-second bound.

## Interfaces and staged release

The HTTPS-only `/api/shared/treasury/*` API provides status, setup, unlock, lock,
configuration, prepare, confirm and operation reads. POSTs use `version: 1` and
the separate owner unlock header `X-GridLens-Wallet`. Confirmation takes a review
identifier/digest and idempotency key, never arbitrary messages or replacement
amounts/destinations. The server binds the review to the current configuration,
fleet revision, source identities and spending limits.

Publish compatible coordinator/updater support before enabling Wallet:

1. Build the compatibility release with default Docker Wallet protocol `0`.
   It contains coordinator version 2 and future socket provisioning support,
   enables no financial operations, and retains minimum coordinator 1 so current
   updaters can install it.
2. Verify the generated setup/upgrade entry points and actual updater on isolated
   Docker resources, then follow repository review/publication approval. Existing
   installations must receive compatible support first.
3. Build the financial release with `build:modern -- --enable-wallet` plus the
   normal release arguments. Its immutable image advertises
   `io.gridlens.treasury-protocol=1`; its signed manifest requires coordinator 2.
   Older updaters reject it. The current coordinator provisions and validates the
   additional named volume only for a capable target image.
4. Rolling back to an older image omits financial access while retaining the
   ledger, encryption key and allowance. Preserve existing certificates, endpoints,
   grants, workloads and data through both stages.

The developer preview and portable handoff have no financial authority. The
signer bundle in `dist/backend/` is not a static HTTP asset. Tests use generated
keys, isolated stores and injected providers, never existing node keys or live
transactions. Physical browser checks, publication, migration and the reviewed
live receipt remain separate from automated implementation checks.

## Original transfer candidate verification — November 2, 2026

The final pinned-toolchain `npm run check` passed: 1,106 Node tests and 473
browser tests. Coverage includes real CA-validated loopback TLS and the dedicated
financial IPC path, generated-key signing, exact transaction/receipt validation,
shared RPC limits, owner recovery, and the existing Fleet/mobile workflows.

Isolated Docker acceptance passed for published dev.16 source to compatibility
support, then compatibility support to Wallet protocol 1. The actual updater
loaded verified signed fixture archives, replaced itself, returned the browser
to Fleet and recovered from an intentionally failing update. Wallet owner setup
used generated fixture credentials on an empty fleet. HTTP requests were denied;
the financial socket was absent from HTTP and updater containers. Encryption
key, configuration and password verifier survived rollback, while old unlocks
were rejected. These fixtures requested zero financial operations.

Fresh install, interrupted upgrade, restart, shared-cache/grant preservation and
paired rollback also passed. The financial image completed an uncached build
through the runtime's Docker CLI in a container with a read-only root filesystem.
All acceptance fixtures were cleaned up; review images and private evidence are
retained outside the source tree.

These results do not establish publication or live financial enablement. Validate
the exact published setup/upgrade commands during the compatibility-first rollout
before advancing the live runtime. Physical browser review and the explicitly
reviewed one-host/one-wallet 1 NOS receipt are still pending. No existing wallet
key was accessed and no live transfer or reward claim was made during this work.

## Rewards claim pilot — implementation candidate

The operator subsequently verified the original 1 NOS transfer and manually
observed that a Nosana uptime claim pays the entire available amount into the
claiming host's standard NOS associated token account. The new Wallet flow uses
that fixed payout behavior. It does not send rewards to Wallet's separate
receiving/consolidation address, and does not offer a partial 1 NOS claim.

Unlock the saved HTTPS Wallet, choose one host with current positive rewards,
and review **Claim ALL available rewards**. The review shows the host, its payout
owner and token account, the last reported amount and its time. Nosana determines
the final amount; it can differ from the review. Confirmation authorizes only
this host. After a finalized verified receipt, a different host can be selected
for a demonstration. Each public host has one attempt in this initial rollout,
and only one unresolved claim is allowed across the installation. Even a known
pre-dispatch cancellation conservatively retains that host's attempt.

No extension or web-wallet switching is involved. The owner revalidates the
approved PC, pinned SSH identity, exact running node container, active rewards
permission, provider waits and a current reward observation (at most five
minutes old). It does not substitute a retained amount after a failed read.
The helper signs the public address for Nosana authorization inside that node,
then sends one empty-body POST to the fixed official payment endpoint. Source
keys and authorization headers never leave the node. The helper accepts no
amount, destination, arbitrary URL or transaction instruction and follows no
redirects. Network time is bounded to 60 seconds; the parent command to 75.
The payment POST response's `claimableAmount` is an integer count of NOS base
units. It is distinct from the rewards GET's decimal NOS amount. The helper
preserves exact numeric lexemes, rejects fractional base units and marks its
normalized response explicitly as base units; it does not multiply this payment
amount by 1,000,000 again. This unit contract was established by matching a
captured production acknowledgment to its exact finalized payout, rather than
inferring units from the upstream field name or UI label.
Planned upgrades and rollback give the collection owner up to 90 seconds to
stop, allowing an already dispatched claim response to be journaled. An idle
owner exits immediately; gateway and updater stop limits remain unchanged.
Power loss or forced termination can still leave a claim needing verification.

`treasury.claims.v1` and its encrypted per-operation records are separate from
`treasury.v1`, in the retained safety ledger. A private initialization marker in
the existing credential volume binds the journal to the installation and its
encryption identity. Missing/corrupt records or marker disable claims while
preserving the original Wallet. Owner reset, restart and paired rollback never
replenish claim attempts. The journal records intent before dispatch; the
already dispatched response is retained even if the browser locks or closes.

No automatic claim retries occur. Lost responses, missing signatures, rejected
or malformed responses, and interrupted dispatches remain **Needs verification**.
They block another claim because a payment may already have occurred. An API
success alone is not a receipt. Read-only reconciliation uses the captured
signature and exact reported amount through the existing shared RPC budget.
Finalized legacy/v0 transactions must prove the official NOS mint, classic Token
program, six decimals, expected host/ATA and exact credit. Known Transfer and
TransferChecked layouts and narrowly validated ATA setup are supported; unknown
layouts remain unverified. This validator does not relax the original transfer's
exact signed-message checks.

### Recovering a dev.20 receipt amount

Dev.20's initial payment-response parser incorrectly treated the POST amount as
decimal NOS and scaled it again. The empty-body claim request still paid the
correct amount, but the recorded expected amount could be a million times too
large and leave Wallet showing Verifying after the payment completed.

The correction recognizes only unmarked legacy acknowledgments. It first checks
the recorded amount using the existing exact receipt validator. If that proof
does not match and the recorded amount divides exactly by 1,000,000, it verifies
that deterministic candidate against the same finalized transaction. It does
not choose an amount from a displayed balance or guess from the last reward
reading. Only a fully verified signature, NOS mint, host owner/ATA, transfer and
exact balance changes permit correction.

The confirmed amount and an encrypted audit of the original interpretation are
saved atomically. The operation ID, captured signature, source reservation,
idempotency information and original 1 NOS transfer remain intact. Marked new
responses never take this correction path, and already settled legacy records
are left unchanged. No new claim POST, signing, forwarding or allowance reset
is involved. Rolling back to dev.20 makes its strict old reader reject the new
record fields, disabling claims while retaining their history.

The correction candidate passed the pinned `npm run check`: **1,174 Node tests
and 501 browser tests**. A four-stage isolated Docker test used the actual dev.20
decoder to create a generated legacy record, corrected it through the candidate's
production RPC driver and unchanged strict validator, confirmed that dev.20 then
failed closed without changing ledger rows, and reopened the candidate with the
same confirmed receipt and spent host. The fixture used disabled networking,
generated responses and no source wallet keys or real claims; cleanup passed.
A separately captured finalized payout also passed an offline replay of the
corrected driver. These checks do not constitute deployment or live UI acceptance.

Wallet keeps a separate Rewards activity section, with the full transaction
link and payout details after reload/unlock. Reads never refresh the owner
inactivity deadline or submit claims. The HTTPS-only API adds
`claims/status`, `claims/prepare`, `claims/confirm`, `claims/operations` and
`claims/operations/:id` under `/api/shared/treasury/`. POSTs retain the versioned
body, exact origin and separate owner unlock. Reviews bind the exact unlock
session, owner/configuration revision, fleet and source identities. The ordinary
read socket has no claim authority.

Implementation tests use generated fixtures and injected providers. Live host
selection, full-amount confirmation, publication and installation remain separate
from those checks; no live claim is part of implementation verification.

### Rewards candidate verification — November 2, 2026

The final pinned-toolchain `npm run check` passed: **1,163 Node tests and 501
browser tests**. Generated fixtures cover the HTTPS financial socket, owner
session changes, both sequential host claims, exact payout verification, lost
acknowledgments, clock changes, duplicate confirmation, retained SQLite history
and the existing NOS transfer. A malformed API response that reflects the
authentication signature is withheld inside the source helper; it cannot become
a public transaction link or leave that container.

Isolated Docker acceptance passed from dev.19 to the candidate through the actual
worker, including worker replacement, browser return and recovery from an
intentionally failing update. Wallet ownership, its encryption identity, the
claim initialization marker and ledger survived rollback. HTTP financial access
remained blocked. These upgrade fixtures used an empty fleet and requested zero
financial operations.

A separate network-disabled Docker fixture exercised the real claims engine
and SQLite with a generated acknowledgment arriving 35 seconds after SIGTERM.
The owner exited cleanly, preserved the acknowledgment and reconciled its recorded
signature after restart without repeating the synthetic claim. Idle shutdown
took about 0.4 seconds; the 90-second limit is a maximum grace period. All fixture
containers and volumes were cleaned up. These results do not establish live
Nosana claim acceptance or publication; existing source wallet keys were not
accessed and no real funds were moved during implementation verification.
