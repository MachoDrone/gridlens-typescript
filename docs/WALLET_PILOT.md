# Wallet: controlled 1 NOS pilot

This candidate adds owner-controlled Wallet setup and a single NOS transfer. It
does not establish publication, live enablement or a completed transfer. Rewards
monitoring stays read-only; reward claims and combined collection remain later work.

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
and rollback cannot create another allowance. The specific source and receiving
address must be reviewed before the live test. Repeated transfers, sweeping and
reward claims require later work.

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
and people controlling host private keys remain trusted, as agreed. Missing or
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

## Candidate verification — November 2, 2026

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
