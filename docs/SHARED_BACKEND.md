# Shared backend candidate

The installed composition adds a TypeScript collection owner, durable SQLite
cache, authenticated HTTPS gateway, browser PC management and optional Android pairing.
The developer preview remains a separate application composition with its original
startup files and demand-driven public readers. No operator host file is imported
or rewritten by installed setup. The candidate passed isolated Docker acceptance
on an authorized Nosana host. Development release 0.1.0-dev.1 is published;
later candidates and live fleet enrollment have separate acceptance records.

## Data and authority

The owner reuses the existing public providers and `FleetSnapshotStore`
normalization. Optional checkpoints preserve provider cache observations,
request reservations, first/repeat discovery history, failure state, disabled
providers, retry deadlines and scheduling evidence. Existing preview callers omit
these checkpoints. Their budgets, batching, freshness and cancellation stay the
same. The installed owner continues approved collection without viewers.

One SQLite owner holds a database write lock for its lifetime. A second owner
fails before collecting. SQLite releases the lock after process exit; startup
does not guess from stale PIDs. Writes use WAL and full synchronous commits.
An ambiguous persistence failure stops further use until reopening validates
the saved data. Node's built-in SQLite API is experimental in the pinned runtime;
that is a runtime dependency, not an assertion of distributed database support.

The observation cache lives in `state.sqlite`. The separate safety ledger holds
access decisions, revocations, provider checkpoints, permissions and owner lock.
PC summaries and each host's bounded GPU history use separate ledger records;
an atomic transaction commits each history with its summary. Large fleets do not
combine all GPU samples into a single value or reduce individual history capacity.
Ordinary paired image/cache rollback preserves that ledger and the credential
volume. It cannot replenish request allowances or reinstate revoked access.
See [installation and recovery](MODERN_INSTALL.md) for the named-volume layout.

The HTTPS gateway has the restricted read/setup socket and its TLS leaf certificate/key.
It receives no Docker socket, credential volume, state database, terminal-control
socket or shell operation. Under the revised operator requirement, browser passwords
or uploaded SSH private keys, passphrases and optional administrator passwords are
forwarded transiently through the bounded setup operation to the owner; the gateway
does not retain them. The owner validates bearer access against the exact
server, fleet and roster revision. The gateway revalidates before returning a
snapshot and during feeds. Incoming Host and Origin must match the configured
canonical origin; forwarding headers cannot establish identity.

The gateway reuses `FleetIntegration`, `FleetSource` and the existing public
reading contracts. Browsers and phones read committed cache observations. These
reads do not initiate duplicate routine collection. Explicit job-history requests
enter the same bounded provider scheduler. GPU detail reads use bounded stored
history. Cache availability does not establish fresh or complete readings.

Updater-enabled installations add a separate Docker-authorized updater behind a
dedicated owner-only socket. The owner forwards only authenticated fixed
status/check/start operations; the gateways keep their existing limited mounts.
The browser's Update panel and restart recovery use a versioned public status
contract with no commands, paths or download URLs. Application readiness checks
match the owner/gateway build identities and validate cached roster data without
requesting fresh upstream measurements. See
[browser updates](MODERN_INSTALL.md#browser-controlled-updates) for the durable
transaction, rollback and one-time enabling migration.

## Pairing and setup

For separately paired HTTPS clients, the terminal creates a five-minute,
single-use connection code. Only its hash is persisted. Pairing creates a random
device bearer whose hash is retained in the
safety ledger. Pair attempts are durably limited. Operator codes come only from
terminal control; an authorized operator can create viewer codes and revoke
devices in browser setup. Browser sessions use a Secure, HttpOnly, SameSite cookie.
The Android adapter keeps its bearer outside bundled browser content.

The explicitly selected `--vpn-web` option adds a private HTTP browser gateway on
the existing LAN/VPN. It does not receive TLS keys or change the HTTPS endpoint
used by Android. Local LAN traffic is unencrypted in this operator-selected mode.
Exact Host/Origin and fleet permissions remain enforced. This private-network
browser address opens directly without pairing or time-limited links. A dedicated
revocable server-side gateway grant authorizes only its configured fleet's current
roster. The browser receives neither that grant's secret nor a cookie. Anyone who
can reach the private address has operator access to that fleet; network access
is this mode's authorization boundary. A protected gateway-only named volume
holds the bearer, and the owner retains only its hash in the durable safety ledger.
Reruns cannot revive a revoked grant. No certificate installation is required for
that HTTP browser address. Native Android pairing remains HTTPS and keeps its
existing device-level access rules.

The dev.8 CLI installs the backend and prints the ordinary URL. It uses the actual
web port on new installs, meaningful colors and spacing, and preserves saved ports
on reruns. Brief prompt explanations identify the reachable PC address, the port
number in the URL, and the next browser step. `/setup` is the browser's **Manage
computers** page. It combines saved PCs, explicit bounded network search, selection
and password or SSH-key sign-in.
Suggestions come only from verified backend host-interface metadata. Search has
progress, cancellation and retry, and does not change VPN configuration. SSH
responses alone are not Nosana identities. Search completion tells the user to
select PCs and choose **Add Selected PCs** at the bottom of the Computers section;
that action advances to sign-in.

The operator's latest requirements explicitly permit computer passwords and SSH
private-key files in the browser, superseding the earlier terminal-only password
and no-browser-key policies. A private-key file is limited to 64 KiB; it may have
a passphrase and an optional computer administrator password for sudo. The owner
validates private-key material and rejects public-only `.pub` files, malformed keys,
wrong passphrases and mixed password/key requests. The browser sends a bounded
same-origin JSON POST, clears the file and secret fields, and stores no secrets
in URLs, logs or local/session storage. The gateway forwards these credentials
transiently to the owner, retaining none and receiving no Docker socket, credential
volume, terminal-control socket or arbitrary shell interface. Only verified
credentials are retained using authenticated encryption in the owner's separate
protected volume; a party controlling that volume and its key can still decrypt
them. The HTTP LAN leg remains unencrypted, including uploaded keys, passphrases
and passwords; the existing VPN protects its remote portion. Encryption at rest
does not encrypt that network leg.

**Set up selected computers** accepts the selected initial SSH identities, checks
access and starts background inspection. Known changed keys remain blocked.
The owner tries ordinary container access first and then fixed sudo read commands
when required, reusing the provided computer password if necessary. An absent
optional host Podman binary is not an error; actual access failures remain visible.
Successful setup enables automatic IP and saves every verified Nosana host found,
including multiple hosts per PC. The visible rewards/GPU option starts checked as
requested; it can be unchecked before submission. Viewing the page does not change
permissions. Existing approvals remain, and revoked monitoring still requires
explicit Restore. No Nosana workload is started, restarted or renamed, and no
rewards are claimed or funds transferred.

Progress and final per-PC results distinguish success, attention and failure. A
prominent **Open Fleet** action appears after completion with an explicit next step;
failed or incomplete checks remain visible. Users can retry failed PCs, reuse saved
credentials with blank secret fields, update sign-in, explicitly remove PCs, or
restore selected paused/removed PCs. Removal
stops monitoring, forgets that PC's credential and removes its nodes while keeping
other PC grants and the safety ledger. Changed membership advances the roster;
private-network gateway access follows its configured fleet, while separately
paired HTTPS clients retain exact-revision authorization. Pauses and revocations
are not silently undone by ordinary reruns. Interrupted work requires a new setup
request; unverified credentials are not retained for automatic retry. Reusing an IP
address alone cannot transfer SSH or monitoring authority.

## Verified local readings

The versioned supplement carries exact PC/node/container bindings, SSH identity,
verification times, PC network observations, exact claimable uptime rewards and
GPU source records. Routine responses contain GPU summaries; explicit host detail
queries return at most seven days and 6,000 samples. Public provider fields retain
their original interfaces. Missing, failed and retained sources keep their meanings.

PC network reads use the already-installed host curl over pinned SSH, without sudo
or container commands. IPv4 is preferred; only connectivity failures may try IPv6.
HTTP refusals and provider waits never trigger fallback. Private addresses come
from interface observations; the SSH ingress and viewing device address are not
substituted as measured PC egress. The independent IP lane and node lanes retain
the existing four-connection ceiling. Known provider waits persist before delivery.

Rewards require the separately approved exact node binding and fixed in-container
GET. The TypeScript helper verifies the running node image/public identity before
using its identity inside that container. Only the normalized numeric result,
public address, timestamp and bounded status leave it. No key or authorization
header reaches GridLens, no wallet material is persisted, and there is no claim or
transfer path. The Nosana authorization itself has broader authority than a read;
this code limits its use, not the credential's inherent permissions. Development
tests use generated fixtures and do not exercise existing node keys.

Compatible Android-installed recorders retain their Android lifecycle owner.
Before reading, the backend verifies labels, version, immutable image, exact
source hash, public host/container/GPU binding, safe runtime/volume configuration
and current network namespace. It does not replace, restart or relabel that
recorder. An incompatible/stopped recorder remains unavailable and requires its
existing owner's repair. GPU observations describe supported conditions during
reported job intervals, with explicit gaps; they do not prove a cause of failure.

When no existing recorder conflicts with the verified node/GPU binding, explicit
full-monitoring approval may create a separate TypeScript recorder in a pinned
Node Docker image and labeled named volume. It samples the supported NVIDIA XML
flags/counters, retains bounded SQLite history, verifies the node's local public
identity, and detects clock jumps before pruning. It uses the exact isolated node
network namespace, dropped capabilities and read-only root; no host OS mounts or
services. Only its own interrupted creation may be resumed automatically. An
existing Android, prior-binding or unowned resource blocks competing creation.
These recorder lifecycle paths have command-runner tests; actual NVIDIA/GPU
recorder lifecycle acceptance is still pending. The separate backend Docker
rehearsal did not touch existing Nosana Podman workloads or their GPU resources.

## Version 1 endpoints

All endpoints enforce the configured canonical Host/Origin checks. Except pairing,
requests require a valid device session or the explicitly enabled private-network
gateway grant. Browser credential POSTs require a matching Origin and bounded
JSON body. Device credentials bind one exact roster revision.

| Endpoint | Contract |
| --- | --- |
| `POST /api/shared/pair` | `{version:1, code, deviceName}` → server/device identity, bearer, role, context and capabilities. |
| `POST /api/shared/login` | Browser pairing; returns public pairing metadata and sets the protected cookie. |
| `GET /api/shared/status` | Server/context, emission time, shared-cache mode, role, capabilities and known provider/budget waits. |
| `GET /api/shared/observations` | Versioned validated associations, network readings and reward/GPU summaries. |
| `POST /api/shared/gpu-history` | One authorized address and bounded `fromAtMs`/`toAtMs`; retains original source times. |
| `GET /api/fleet/hosts.json` | The existing authorized roster and server time. |
| `GET /api/fleet/<resource>.json` | The existing normalized public snapshots; job history permits bounded selected hosts. |
| `GET /api/shared/setup` | Operator-only search/setup state, managed-PC summaries and current per-PC result report; never returns passwords or private keys. |
| `POST /api/shared/setup-action` | Bounded search, cancel and compatible setup intent. |
| `POST /api/shared/setup-configure` | Operator-only selected PCs, username with password or private key/passphrase and optional key-mode administrator password, or saved-sign-in reuse; explicit rewards/GPU value and restore IDs; acknowledges background work. |
| `POST /api/shared/setup-remove` | Operator-only explicit PC removal and credential forgetting, retaining other PCs and durable safety state. |
| `/api/shared/devices`, `/pair-code`, `/revoke` | Operator-only paired-device administration, separate from private-network browser access. |
| `/api/shared/monitoring`, `/monitoring-action` | Operator-only PC approval status, durable pause/revoke, and credential forgetting. |

On Fleet snapshot requests, optional `X-GridLens-Scope` and
`X-GridLens-Roster-Revision` headers must match the authorized context.
Shared responses include their verified context. Android validates TLS CA/hostname, the explicit leaf pin and
paired server identity before consuming data. Its bundled UI and phone-local API
remain in use. Remote rosters/cache have their own namespace; standalone rosters
and SSH grants remain separate. Denial, malformed data, changed identity, VPN loss
and provider pauses never trigger silent direct-provider fallback. Explicit mode
switching preserves known waits. Reading freshness is independent of the visible
Shared cache/Standalone mode.

## Acceptance boundaries

Required source checks are `npm run check`; Android has its own runtime, vendored
browser, native unit/lint/build and disposable-emulator checks. New isolated tests
cover real generated-certificate HTTPS pairing, two clients receiving identical
dated cache data, revocation/revisions, one-selection setup, durable permissions,
provider restart state, bounded history and synthetic 200+ host operation.

Actual isolated backend acceptance passed using Docker 29.7.2 over SSH, with a
full uncached first image build and verified Node 24.14.1/npm 11.11.0. It exercised
read-only UID/GID 1000 runtimes, install/rerun, process restart, verified HTTPS and
pairing, shared dated snapshots, interrupted initial setup/upgrade recovery, and
matched image/cache rollback retaining provider reservations, waits, grants and
revocations. The second image was a label-only child, not another cold runtime
build. Source-copy permissions and the fixture's internal-network ingress were
corrected during preliminary rehearsals; neither required a corresponding
application fix. See [the acceptance guide](MODERN_INSTALL.md#run-isolated-docker-acceptance)
for runner options, remote forwarding and private reports.

The test owner used generated identities and synthetic data with no egress;
existing workloads and VPN configuration were preserved. This does not establish
physical PC reboot behavior, NVIDIA/GPU recorder lifecycle acceptance, live fleet
monitoring or physical VPN/phone acceptance. Published installer and live acceptance
records are version-specific; browser credential and PC-management acceptance
is recorded separately from those earlier rehearsals. No legacy migration or
installed-phone data change occurred.
