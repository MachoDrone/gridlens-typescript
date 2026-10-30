# Modern Docker installation and recovery

The modern backend is separate from the loopback developer preview and the legacy
installer. Its TypeScript terminal coordinator manages a single collection owner
and an unprivileged HTTPS gateway on a chosen PC, which may also run Nosana. This
source revision implements development update **0.1.0-dev.8**. Installation ends
with the dashboard address; computer selection, sign-in and setup results belong
in the browser. Published dev.4 provides direct private-network browser access;
earlier published releases remain immutable.
The source `scripts/modern-start.sh` intentionally refuses to run until the release
builder supplies a tested executable checksum and pinned GitHub release tag.

## Operator flow

### Install, then open the browser

Run the signed release launcher with `--vpn-web` on the chosen backend PC. Docker
must already be available. Choose its assigned private address and the **Web
dashboard port**; Enter accepts the shown recommendation. This is the actual HTTP
port used in the final browser URL. A separate available HTTPS companion port is
chosen automatically. Each prompt briefly explains the choice: the address is
the reachable IP of this PC, and the port is the number after the colon in the
dashboard URL. Existing installations keep their saved addresses and ports.
The optional `--web-port PORT` selects a port explicitly.

The terminal uses green for Ready/success, blue for the URL and actionable
information, amber for work or attention, red for failures, and muted text for
retained settings. Choices and the final result have spacing for readability.
Every color has a text meaning; `NO_COLOR` disables ANSI color without hiding status.
Once the backend is ready, the terminal prints the ordinary dashboard URL and
returns to the shell, with an explicit instruction to open it and choose Manage
computers. Computer credentials and enrollment are not CLI install steps.

Open or bookmark that URL on PCs and phones using your existing private LAN/VPN.
There are no browser connection codes, pairing steps or sign-in expiry in this
mode. `--connect` prints the same address. Anyone who can reach this private
address has operator access to its configured fleet. The VPN protects its remote
portion; the local LAN leg is HTTP and is unencrypted, including browser passwords,
SSH private keys, passphrases and optional administrator-password submissions.
Saving credentials encrypted does not encrypt that network leg.

The private web gateway shares the existing collection owner, cache and permissions;
it does not change VPN settings, expose a public address or duplicate collection.
The HTTPS endpoint and native Android pairing remain separate. A protected
server-side grant gives the web gateway access to its fleet's current roster.
Reruns cannot revive a revoked gateway grant.

### Manage computers in the browser

Open **Hosts** in the left menu. Saved PCs show their host counts and
monitoring status, with **Update sign-in** and **Remove** actions. To find PCs,
open **Search network**, accept or edit the verified network suggestion, then
start the search. The page identifies the backend PC doing the search.
Suggestions come from its actual host interface, never the viewing phone or a
container bridge. Search retains the existing private-IP or IPv4 /23–/32 limit,
512-address bound, eight simultaneous probes and per-probe timeout. Progress,
cancel, retry and partial-IP/name filtering stay on the same page. A completed
search says what to do next: select PCs below, then choose **Add Selected PCs**.
That primary button sits below the Computers list and advances to sign-in.

Enter the computer username and choose **Computer password** or **SSH key**.
Key mode accepts a private-key file up to 64 KiB, an optional key passphrase, and
an optional computer administrator password if sudo requires one. The administrator
password is not the SSH-key passphrase. The owner validates that the uploaded file
contains a private key; public-only `.pub` files, malformed keys, wrong passphrases
and mixed password/key submissions are rejected without revealing their contents.
One sign-in can be applied to the selection; leave its secret fields empty to reuse
saved sign-ins where available. Choose **Set up selected computers**. That action
records new selected SSH identities, checks access and performs the required inspection.
Changed saved SSH identities remain blocked. GridLens first tries ordinary access,
then fixed sudo read commands when required, using the submitted computer password
if needed. With a key, it can use the optional administrator password instead.
It does not require passwordless sudo or ask for a separate terminal
session. Missing optional host Podman is not itself a setup failure.

Successful setup saves verified credentials encrypted in the owner, enables
automatic IP monitoring and saves every verified Nosana host found. The separate
**Also enable rewards and GPU monitoring** option is visible and checked by default;
the user can uncheck it before submitting setup. Opening the page alone never
grants monitoring access. Existing approvals remain, and paused or revoked access
still needs explicit Restore. Inspection does not start, restart or rename Nosana
workloads, claim rewards or transfer funds. The final report shows per-PC success,
failures, attention items and saved-host counts. Failed computers can be retried
without repeating successful setup on the rest. Once setup finishes, a prominent
green **Open Fleet** action and a next-step explanation lead to the saved fleet.
Attention items remain visible; incomplete checks are not presented as success.

**Update sign-in** reuses or changes a PC's credentials. **Remove** explicitly
stops its monitoring, forgets its saved sign-in and removes its hosts from the
fleet while retaining other PCs and the safety ledger. Removed computers are
hidden by default; **Show removed computers** and explicit re-enable selection
allow a deliberate restore. An ordinary rerun never revives paused or revoked
monitoring silently. Discovery alone does not grant SSH access.

The latest operator requirements explicitly permit browser password and SSH-key
entry, superseding the earlier terminal-only password and no-browser-key policies.
The selected credentials use a bounded same-origin POST; file, key, password and
passphrase inputs clear after submission. They are not put in URLs, logs or browser
storage. The gateway transiently forwards them only to the restricted owner
operation and retains no computer credentials. It has no Docker socket, credential
volume, terminal-control socket or arbitrary shell interface. Only the owner
retains verified credentials, using authenticated encryption in its protected volume.

Advanced terminal commands remain for compatibility, but ordinary PC-list updates
and sign-in happen entirely in the browser. `--no-setup` is no longer needed for
the normal install-only flow.

### HTTPS access

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

Run the setup terminal on the chosen backend PC, including through an interactive
SSH login. The candidate lists that PC's assigned RFC1918 IPv4 and IPv6 ULA
addresses as numbered choices. When one conventional LAN/Wi-Fi interface has an
unambiguous eligible address, it marks a recommendation; **Enter accepts that
number**. Multiple plausible LAN choices require an explicit selection. Existing
private VPN interfaces remain available as explicit choices. Detection establishes
a local assignment, not that a phone can reach it through a VPN.

Localhost, link-local and global addresses are excluded. Read-only Docker bridge
metadata excludes Docker-owned names and gateway addresses; known Podman/CNI/veth
interfaces are also excluded. A legitimate host bridge is not excluded merely
because it is named `br0`. Global/public-only and CGNAT address support remain
deferred. If no eligible address exists, setup explains the existing-private-network
or VPN prerequisite; it supplies no localhost or invented-address fallback.

The candidate probes a temporary listener on the selected local IP before offering
a port. It prefers **8789**, then checks the bounded range through **8799**. Enter
accepts the available recommendation, or the operator can choose another port from
1024 through 65535. Invalid or occupied choices prompt again without stopping the
existing service. A probe releases its listener immediately, so another process
can still take the port before Docker binds it; the recovery flow below handles
that race. A healthy saved endpoint retains its port without probing its own
already-bound listener.

For HTTPS, **Private certificate is recommended and Enter selects it**. The other
choice accepts an existing trusted certificate covering the selected IP in its
SAN. Invalid options prompt again. Existing certificate/key files, their match,
dates and selected IP are checked before installation configuration changes.
Certificate keys and passphrases stay in the terminal; saved TLS identity remains
in named volumes.

With a private certificate, **Enter saves the public CA certificate** at the
recommended `~/gridlens-INSTANCE-ca.crt` path; type `skip` explicitly to skip the
export. Leading `~/` expands to the current user's home directory. Repeating an
export to a file containing the same public certificate succeeds without rewriting
it. A different file, symbolic link or oversized file is left unchanged and prompts
for another path. Comparison reads are bounded and require a public-certificate
header; certificate contents and private-key material are never printed.

Transfer that public CA through the trusted setup channel and import it in clients
that do not already trust it. The terminal labels **PUBLIC CA certificate SHA-256**
separately from **Server TLS certificate SHA-256 (Android pin)**. An existing trusted
server certificate needs no new CA import when the clients already trust its
issuer, and its public export remains optional. Never skip certificate validation.
A changed paired identity requires explicit repair.
The generated leaf certificate lasts one year; renewal and trust
rotation require an explicit identity-preserving certificate workflow and remain
an operational follow-up before a long-lived release.

The installer creates the initial empty `default` fleet. Separately paired HTTPS
access retains its short-lived operator connection code; this is independent of
the no-code private-VPN browser address. Computer selection, sign-in and monitoring
approval happen in browser Hosts management and remain separate from cache reads.

Additional coordinator actions reuse the same installed instance:

```sh
./gridlens-coordinator-linux-x64 --connect
./gridlens-coordinator-linux-x64 --scan 192.168.20.0/24
./gridlens-coordinator-linux-x64 --ssh-sign-in
```

These advanced commands remain compatible with the terminal workflow. Use only an
explicitly chosen network range. Normal setup uses the browser manager described
above. After fleet coverage changes, private-VPN browser access keeps its ordinary
address; separately paired HTTPS viewers need authorization for the new roster
revision. Advanced key/password input travels through Docker stdin to the owner's
control socket; browser credentials travel through its restricted read/setup socket.
Neither path puts secret values in process arguments. Verified retained credentials
stay in the owner's encrypted credential volume.

## Browser-controlled updates

The update-enabled installation offers **Update** below Hosts in the existing
narrow sidebar. The collapsed rail keeps the same icon. A slow green pulse means
a verified newer development release is available; reduced motion uses steady
green. The panel separates the installed version, latest verified release and
last successful check. Failed checks retain previously verified information with
their error, rather than claiming the installation is current.

**Update now** is the one explicit installation action. It downloads and verifies
the release, then replaces this installation's collection owner and configured
HTTPS/private-web gateways together. It does not update Nosana software, restart
Nosana workloads or update other GridLens installations. Routine operation needs
no terminal commands. Closing the panel or browser does not cancel accepted work;
reopening reads the existing durable operation. Duplicate submissions are
idempotent, and one installation admits only one active transaction.

Progress shows actual download bytes and percentage, followed by named stages
and elapsed time. During gateway replacement, the already loaded page shows
Reconnecting and retries the same URL. There is no estimated countdown or
success inferred from elapsed time. Readiness requires matching installed build
identities, working owner communication and valid cached Fleet reads. The browser
reloads once per completed operation, then verifies its build and renders an
authorized roster and initial snapshot before returning to Fleet. An empty fleet
or dated/unknown host values remain usable. Browser disconnection, tab closure and
revoked user access do not cause server rollback.

The updater retains the previous matched image/state and gateway configuration.
Failed application readiness triggers automatic recovery with the original
failure preserved. A recovered previous version is reported as a failed update
with successful restoration, never a successful installation. A browser-only
loading problem offers Retry loading Fleet without resubmitting installation.

The owner exposes bounded, same-origin `/api/shared/updates` status plus
`/api/shared/updates/check` and `/api/shared/updates/start` actions. Viewers can read
status; mutations require an operator and exact Origin. The browser selects only
a verified candidate ID and supplies an idempotency key. It cannot select a URL,
image, filesystem path or command. Private-network mode retains its existing
network-access authorization boundary.

One labeled updater container owns the Docker connection and communicates with
the owner through a separate named-volume socket. The gateways retain their
restricted owner connection and receive no Docker access. The updater has no
published port, uses a read-only root filesystem, and stores its journal and
staged archives in an owned named volume. Its temporary replacement helper has
the same bounded installation role. Docker socket access is significant host
authority; code restricts mutations to validated resources for this installation.
It adds no host packages, services, VPN configuration or general shell endpoint.

The signed `modern-development` channel points to immutable modern release
artifacts. The shared worker checks every 15 minutes with jitter, coalesces manual
checks with a 60-second minimum interval, and retains retry deadlines across
restart. Platform, release sequence, worker compatibility, Ed25519 signatures,
archive size and SHA-256 must verify before replacement. A lower channel sequence
or changed identity at an already accepted sequence is rejected. Browsers poll
the local status only, once per minute while visible and every two seconds during
active checks/updates; hidden pages stop polling while accepted server work continues.

Existing releases have neither an updater endpoint nor Docker authority in the
owner/gateway, so they cannot enable this feature through their old web page.
The first rollout requires a maintainer-handled enabling migration on the
verified existing installation. This is separate from the subsequent browser
update journey and from source publication. Preserve existing addresses,
identities, credentials, fleet access and safety ledger during migration; never
use an old browser's SSH setup path as an updater bootstrap.

Updater support is advertised by the verified image's
`io.gridlens.updater-protocol=1` label. A rollback selects the actual saved image
for the owner, gateways and updater. Rolling back to pre-updater code removes its
updater integration and stops only the validated updater container, retaining the
journal and named volumes. An older public release reports the newer installed
version and existing dashboard URL without replacing or reconfiguring its services.
The installer streams runtime archives into an exclusive temporary file and
verifies the signed size and checksum before loading them into Docker.

Signed releases can include both the OCI manifest digest and its verified image
configuration digest. The installer resolves the exact signed identity exposed
by the target Docker store before starting any helper. Classic `overlay2` stores
and the containerd image store use different IDs for the same exported image;
installation does not require changing Docker's storage backend. Installed
configuration and recovery records retain the actual local Docker ID, while
update journals also preserve the original signed release. Mutable image tags
are not an identity fallback.

The maintenance helper reports an existing installation lock only for an actual
SQLite busy/locked result. Image lookup, Docker permission, filesystem and other
startup errors retain their bounded diagnostic instead of being mislabeled as
another installation. A downloaded image and an empty configuration volume do
not establish that GridLens has been installed.

Automated interface/browser tests and real Docker acceptance are separate checks.
Use isolated fixture installations for signed update, restart, rollback and
worker replacement testing; never use live fleet state as test data. Publication
and physical enabling are reported separately from implementation.

The 2026-10-29 candidate passed strict typechecking, 1,019 isolated Node tests and
371 browser tests. The exact source image passed an uncached Docker build and a
real browser-triggered update with signed fixture releases: cold archive loading,
owner/both-gateway replacement, updater self-replacement, automatic return to
Fleet, and automatic rollback after an intentionally broken owner startup.
Those fixture resources were removed without cleanup errors. Release downloads
used an explicitly isolated signed transport fixture; this does not establish
publication or a live rollout. Build RUN containers were verified at 2 GiB RAM
with no additional swap allowance and one CPU; Docker daemon and image-transfer
work remain outside those limits.

The exact generated launchers also passed ordinary first setup, explicit
`--upgrade`, and both ordinary/upgrade invocations of an older release against
the newer installation. These checks used signed disposable releases through a
process-scoped HTTPS proxy and temporary trust certificate; no public release
was published for the test. Both configured gateways and the authorized empty
roster returned successfully, identities/addresses remained stable, and older
release attempts retained the existing container identities. Test resources,
proxy, tunnel and disposable keys were cleaned up. This verifies the generated
entrypoint with fixture transport, not a published download or physical enablement
of an operator's installation.

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
| `read-ipc` volume | Restricted reads and bounded browser setup operations | Retain |
| `control-ipc` volume | Terminal-only setup socket | Retain; never mount in gateway |
| `vpn-auth` volume | Private-network gateway grant, mounted read-only by that gateway | Retain; revocation remains in the current ledger |
| `updates-ipc` volume | Restricted owner-to-updater socket | Retain; never mount in a gateway |
| `update-state` volume | Durable update journal, recovery intent and bounded staged archives | Retain across application and updater replacement |

The collection owner and gateways run as UID/GID 1000 with a read-only root filesystem,
all capabilities dropped, `no-new-privileges`, a PID limit and bounded temporary
memory. Only gateways publish the explicitly selected private IP/ports.
The short-lived initialization helper has no network and uses narrow container
capabilities to initialize ownership of these named volumes. The updater runs as
UID 0/GID 1000 with the same root-filesystem/capability restrictions; its sole
host bind mount is the fixed Docker socket. Its replacement helper also receives
that socket. No host networking, privileged container mode or Nosana workload
control is added. The collection owner and gateways receive no host bind mounts.

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

### Recover an incomplete dashboard endpoint

The candidate checks the gateway's actual running state, attachment to the exact
owned Docker network, and effective published IP/port. A configured port declaration
alone is not proof of a working endpoint. A running container left detached after
a failed Docker port allocation is repairable; a healthy endpoint is left alone.

If a broken endpoint's saved port is free, rerun repairs the same endpoint. If the
port is occupied, the terminal asks for an explicit free replacement while retaining
the address, TLS certificate, server identity, credentials and data. It removes or
recreates only the verified owned gateway for this repair; an already-running
collection owner is retained. Unowned resources, invalid saved configuration and
unexpected runtime isolation, mounts or configured publication settings stop recovery for
review instead of being adopted or silently rewritten.

Before replacing a gateway for a new port, the coordinator records a `pendingPort`
intent. The previous saved port/origin remains until the replacement's effective
endpoint verifies; then the target becomes the saved endpoint. An interrupted
rerun resumes that intent. If the pending target itself loses a port race, the
terminal can ask for another explicit free target. An already-recorded image/state
upgrade transaction resumes before endpoint selection. Repeating setup never
regenerates saved identities or refills the safety ledger's budgets.

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
The release producer currently requires a single-platform OCI Docker export;
the builder verifies its manifest, configuration and every layer blob before
signing both image identities. This producer requirement does not restrict the
classic or containerd store used by an installation receiving that release.
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
without source files or build intermediates. The modern signing identity is
separate from Android and legacy signing. Preparing a later candidate does not
authorize replacing an immutable release or deploying it. Earlier disposable-key
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

The published development installer subsequently reproduced a real failure:
Docker rejected an occupied port with exit 125, and a later rerun could leave the
gateway running without an effective network endpoint. Targeted candidate tests
and a Docker reproduction now verify gateway-only repair, preserved owner process,
server/TLS identity and volumes, successful HTTPS, and another healthy rerun.

An operator-requested repair of an existing installation was also completed on
the explicitly selected replacement port. Five protected volume checkpoints were
verified first. The new GridLens owner/gateway were briefly stopped for that
checkpoint; the owner was restarted before endpoint repair and retained through
the repair itself. Existing Nosana Podman workloads and legacy GridLens resources
were unchanged. This repair did not enable new fleet monitoring. The endpoint
recovery changes were included in later development releases.

No physical PC reboot or NVIDIA/GPU recorder lifecycle test was performed.
Physical VPN/phone acceptance and exact published setup/upgrade entry points
remain separate checks; release notes record the checks performed for each update.

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
