# Modern Docker installation candidate

The modern backend is separate from the loopback developer preview and the legacy
installer. Its TypeScript terminal coordinator manages a single collection owner
and an unprivileged HTTPS gateway on a chosen PC, which may also run Nosana. This
source revision is a local candidate. It passed an isolated Docker installation
rehearsal on an authorized Nosana host; no live fleet was enabled and no modern
release has been published.
The source `scripts/modern-start.sh` intentionally refuses to run until the release
builder supplies a tested executable checksum and pinned GitHub release tag.

## Operator flow

Use the generated **modern-start.sh** from a reviewed release in
`MachoDrone/gridlens-typescript`. The legacy `gridlens-installer` entry point is
unchanged. The release launcher verifies the exact standalone coordinator binary
before running it. The executable includes pinned Node 24.14.1, verifies the
Ed25519-signed runtime manifest and image archive, and requires no host Node or
Python. Linux x64 and arm64 are separate build targets; this candidate has only
been built on Linux x64.

Docker must already be installed and running. The launcher also uses the host's
existing Bash, curl, sha256sum, uname and mktemp. Setup installs no host packages,
services or users. If Docker access requires administrator privileges, sudo prompts
in the terminal; passwordless sudo is not required. Docker creates its ordinary
container networking and named volumes, which are host effects. Setup does not
change VPN interfaces, DNS, sysctls or existing WireGuard configuration.

On first setup, enter the chosen PC's assigned private address and HTTPS port
(default 8789). Use the address reachable through the operator's existing VPN;
GridLens does not infer reachable routes from matching IPs. An occupied port fails
visibly. Choose another available port during first setup; saved ports are retained
on rerun. Select either an existing trusted certificate with that IP in its SAN,
or private-certificate creation. Certificate keys and their passphrases are entered
or selected only in the terminal. TLS identity remains in named volumes.

With a private certificate, export its **public** CA certificate through the
trusted setup channel and install it in each client's trust store before opening
the dashboard. The printed server-certificate SHA-256 value is the separate leaf
pin used for Android pairing, not the CA certificate's fingerprint. Never skip
certificate validation. A changed paired identity requires explicit repair.
The generated leaf certificate lasts one year; renewal and trust
rotation require an explicit identity-preserving certificate workflow and remain
an operational follow-up before a long-lived release.

The terminal creates the initial empty `default` fleet and prints a short-lived
operator connection code. Use it in the HTTPS browser setup. Computer selection,
identity review and monitoring approval remain separate from data-cache reads.

Additional coordinator actions reuse the same installed instance:

```sh
./gridlens-coordinator-linux-x64 --connect
./gridlens-coordinator-linux-x64 --scan 192.168.20.0/24
./gridlens-coordinator-linux-x64 --ssh-sign-in
```

Use only an explicitly chosen network range. Scanning occurs on the backend PC.
Select computers and approve new SSH identities in browser setup, then use
`--ssh-sign-in` in the terminal for a key file/passphrase or computer password.
Computer sudo passwords are also entered in that terminal when needed. Keep the
terminal open while browser approval and inspection complete; after fleet coverage
changes it prints a new operator connection code for the new roster revision.
Only the owner receives credentials, through a private control socket and Docker
stdin. Keys and passwords never become process arguments or gateway inputs.
Remembered credentials stay in the owner's encrypted credential volume.

## Ownership and recovery

Every managed resource has `io.gridlens.product=shared-backend` and the exact
`io.gridlens.instance` label. Names begin `gridlens-modern-INSTANCE-`. Same-name
unowned resources cause setup to stop. The gateway receives no Docker socket,
SSH credential volume, state database, control socket or shell API.

| Resource | Purpose | Ordinary rollback |
| --- | --- | --- |
| `state-SEQUENCE-ID` volume | SQLite observation cache matched to one image | Select the preserved matched pair |
| `ledger` volume | Provider reservations/waits, access, revocations and owner lock | Always retain the current ledger |
| `config` volume | Installer transaction, chosen address/port and identity | Retain |
| `tls` volume | HTTPS leaf certificate/key | Retain |
| `credentials` volume | Owner-only encrypted SSH credential state | Retain |
| `read-ipc` volume | Restricted owner socket available to the gateway | Retain |
| `control-ipc` volume | Terminal-only setup socket | Retain; never mount in gateway |

Both runtime containers run as UID/GID 1000 with a read-only root filesystem,
all capabilities dropped, `no-new-privileges`, a PID limit and bounded temporary
memory. Only the gateway publishes the explicitly selected private IP/port.
The short-lived initialization helper has no network and uses narrow container
capabilities to initialize ownership of these named volumes. No host filesystem
bind mounts, host networking, privileged containers or workload control are used.

Rerun preserves configuration, ports, identity and data. Containers use Docker's
`unless-stopped` restart policy. A later public release with a lower sequence
retains the newer installed runtime and reports that no downgrade occurred.
`--upgrade` stops the single owner, copies its quiescent state into a new named
volume, records the selected image/state pair and starts that pair. The previous
image and state volume remain available. `--rollback` explicitly selects the
previous pair, retaining the live safety ledger, credentials and TLS identity.
Thus restoring observations cannot refill budgets or revive revoked access.
Interrupted application resumes the durably selected pair; incomplete preparation
can be rerun without replacing saved identities. Never manually restore an old
ledger as part of ordinary rollback.

There is no automatic fleet deployment or legacy migration in this candidate.
All label validation occurs before destructive container changes. Existing
WireGuard and unrelated containers remain outside its authority.

## Build and review

Use the repository's pinned Node/npm toolchain. Release signing keys must remain
in protected storage outside source and build output. The build accepts explicit
key paths; it never discovers or imports an existing wallet, SSH or Android key.
Do not reuse the Android signing identity for this release channel.

```sh
npm run build:coordinator -- \
  --output /private/new-coordinator-output \
  --public-key /protected/modern-release-public.pem \
  --signing-key /protected/modern-release-signing.pem \
  --release-tag modern-v0.1.0

npm run build:modern -- \
  --output /private/new-runtime-release \
  --version 0.1.0 --sequence 1 --tag modern-v0.1.0 \
  --public-key /protected/modern-release-public.pem \
  --signing-key /protected/modern-release-signing.pem
```

`build:modern` builds an uncached Docker image, exports it, writes its signed
manifest and includes the signed standalone coordinator plus generated launcher.
It publishes nothing. The launcher pins the binary SHA-256; the binary embeds the
release verification public key. Detached binary signatures and a coordinator
manifest accompany it. New release sequences must increase monotonically; the
same sequence must never name different content. The runtime image digest covers
its exact installed dependencies and source. Docker build context is explicitly
allowlisted and excludes rosters, history, credentials, backups and evidence.

The SEA build uses Node's documented preparation blob and postject injection
process, with pinned esbuild/postject development dependencies. See
[Node single executable applications](https://nodejs.org/api/single-executable-applications.html).
The generated executable disables NODE_OPTIONS extension and is smoke-tested
outside the checkout with no Node executable available in PATH.

## Verification status

The isolated TypeScript installer tests exercise signature and checksum rejection,
private-address validation, resource ownership, first install/rerun, process
restart, upgrade/rollback pairing, interrupted upgrade recovery, preservation of
the safety ledger and retention of newer installations. They use a command runner
fixture and **do not establish Docker acceptance**. A signed Linux x64 coordinator
was built and run using a dedicated durable modern release identity in protected
local storage. Its private key remains outside source and artifacts; neither the
Android nor legacy signing identity was reused. The candidate includes a detached
signature, public verification metadata, licenses and checksum-pinned launcher,
without source files or build intermediates. The first release must review this
new trust anchor before publication; preparing the signed candidate does not
establish a published channel or authorize deployment. Earlier disposable-key
smoke tests remain separate from this durable signing identity.

Actual container acceptance passed against **Docker 29.7.2 over SSH** on an
authorized Nosana host. The first runtime image received a full uncached build;
the image's **Node 24.14.1 and npm 11.11.0** versions were checked. The second
image was a label-only child used to exercise image/state replacement, not a
second cold runtime build.

The rehearsal checked UID/GID 1000, read-only runtime roots, mount/port isolation,
installation, rerun, container process restart, certificate-verified HTTPS,
browser/phone pairing and identical dated cache reads. It also checked durable
request reservations, provider waits, monitoring grants and revocations through
matched image/cache rollback, plus recovery after injected interruptions during
initial setup and upgrade. Only generated identities and synthetic cache records
were used. Fixture cleanup targeted its unique labels; existing workloads and
VPN configuration remained outside the test's scope.

Two preliminary runs exposed test-harness assumptions. A private context copy
had changed source-directory permissions to 0700, preventing the unprivileged
runtime from reading its application; rebuilding with the original source modes
corrected that. An internal-only fixture network did not make the published
gateway port reachable with Docker 29.7.2. The fixture now keeps the owner solely
on that internal network and attaches only the gateway to a second labeled ingress
network. These were harness corrections, not corresponding application fixes.

No physical PC reboot, live fleet enablement or NVIDIA/GPU recorder lifecycle
test was performed. Existing Nosana Podman workloads were left alone. The exact
published launcher and physical VPN/phone acceptance remain pending.

### Run isolated Docker acceptance

From the checkout with the pinned development toolchain and an existing Docker
daemon, choose an unused loopback port and a new private report path:

```sh
npm run test:shared-docker -- \
  --port 18443 \
  --report /private/new-shared-docker-acceptance.json
```

The runner creates a unique labeled fixture, builds the first image uncached,
seeds synthetic cache data while the runtime is stopped, and performs the checks
above. The collection owner has no network egress and the fixture retains explicit
scheduler waits. It does not scan a network, read operator wallets or collect
real hosts. Reports remain private and outside Git. Stopping and starting the
fixture containers does not establish physical reboot behavior.

| Option | Behavior |
| --- | --- |
| `--instance` | Optional new `fixture-` name followed by 12 lowercase hexadecimal characters. Omit it for a random name; existing fixture resources are rejected. |
| `--port` | Explicit unused loopback port from 1024 through 65535; default 18443. |
| `--prebuilt-image` | Reuse a verified `sha256:` image ID with matching GridLens labels and an existing tag. Record its full uncached build separately. |
| `--prebuilt-version` | Optional expected version label for the prebuilt image; otherwise the verified image label supplies it. |
| `--report` | Write a new private JSON report outside the checkout, including the first failure and cleanup results. Existing report files are rejected. |

The Docker CLI may use an existing SSH context or `DOCKER_HOST` connection. Its
build context and image-export files remain on the development machine; signing
keys stay there too. The runner does not configure SSH or forwarding. For a remote
daemon, arrange an owned temporary forward to the fixture's canonical loopback
origin, using the same unused port locally and remotely, before HTTPS checks.
Do not change an occupied port or existing service to accommodate the rehearsal.
Preserve source file/directory modes in a private build-context copy; keep its
outer storage directory private. Cleanup verifies fixture ownership and preserves
the original failure if cleanup also fails; it never runs a global Docker prune.

Follow the repository's reviewed-publication gate and atomic two-branch push.
Publishing source, publishing signed runtime downloads, live installation and
physical-phone acceptance are distinct steps.
