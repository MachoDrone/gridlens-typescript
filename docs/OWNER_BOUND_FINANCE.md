# Owner-bound finance and staff monitoring

The protected runtime separates a fleet owner's financial authority from a
dashboard installation. A second installation can have its own password and
wallet settings; those do not authorize the first owner's enrolled sources.

This requires the owner to control the source PCs, their Docker/root privileges,
and the owner hub's credentials volume. Staff receive monitoring access, not
administrator credentials. Unrestricted control of machines holding Nosana keys
can bypass application policy; another password cannot protect against that
administrator.
Previously copied source keys also retain their blockchain authority; installing
GridLens cannot revoke someone else's copy of a wallet key.

## Owner flow

Use the saved trusted HTTPS endpoint and existing Wallet password. A fresh owner
still needs the installer's one-use setup ticket. Browser access or importing a
CA does not create an owner.

**Protect sources** reviews an explicit enrollment of the approved PCs. It
installs labeled GridLens guardian resources through existing approved SSH
access. It creates no host users, services, packages, network configuration or
public ports, changes no Nosana container, and moves no funds. The exact published
runtime archive is signature/hash verified before Docker loads it.

Enrollment imports the spent transfer allowance and prior claim attempts. The
approved batch can finish after Wallet locks; changed configuration, revoked
access or changed bindings stop further work. An interrupted batch requires a
new owner action and inspection of actual remote state. Finance remains disabled
until every currently approved source PC is enrolled.

**Manage hosts** grants this browser five minutes of administration after owner
authorization. Wallet still requires its separate unlock. Base private-network
and HTTPS-handoff sessions remain viewers. Legacy operator grants become viewers
during protection migration. Normal protected installation/rerun supplies a
private one-use HTTPS owner-administration link in the trusted terminal; it
permits Hosts setup without requiring a receiving-wallet configuration first.
Only these explicitly issued owner-device grants follow the fleet as it changes.

**Share monitoring** downloads a five-minute, one-use invitation. On a staff PC,
the normal installer's `--viewer-join FILE` action creates a separate read-only
viewer. The revocable grant covers the fleet, including newly enrolled hosts.
The viewer pins the owner's HTTPS identity, stores its viewer credential only in
its private backend, and has no Docker socket, financial/control IPC, SSH
credentials or source-key mounts. Its browser cannot administer hosts or open
financial endpoints.

## Enforcement and recovery

The owner hub holds a separate Ed25519 authorization identity, not a Nosana key.
Each source PC has a guardian with an immutable owner/PC pin and durable journal
in protected Docker storage. Nosana keys remain in their existing containers.
Guardians accept fixed signed operations bound to source, policy, destination
where applicable, expiry and operation ID. They independently validate the
permitted transaction and execute the existing in-container helper; clients
cannot supply arbitrary commands, endpoints, helpers or signing messages.

The central retained ledger preserves the original **1 NOS total** pilot.
Guardians receive no new per-PC budgets. Reinstallation, another server ID,
password recovery or rollback cannot reset source history. Signed policy updates
can change a destination or rebind recreated containers while retaining every
spent record, including removed sources. Claims still pay only the source host's
own NOS account; there is no reward forwarding or sweep.

Unknown dispatch outcomes are not repeated. A lost claim response can be read
from its guardian operation and checked by the existing strict finalized-receipt
validator. Missing keys, pins or journals require recovery, never automatic
reinitialization.

Changing the receiving wallet saves the new configuration and blocks finance.
Unlock and use **Protect sources** to synchronize the policy through the
resumable batch. A lost response retains the pending synchronization record;
unchanged cached settings never count as successful source confirmation.

Coordinator compatibility support is published before protected runtime state.
Older browser updaters continue to see the compatibility bridge; after that
update, coordinator3 reads the separate protected channel. Both pairs use the
existing signed development-channel format and repository.
The retained financial security floor lives outside observation snapshots.
Supported telemetry-only rollback omits financial sockets and keeps viewer
semantics. Floor-unaware targets are rejected before replacing the running
installation. Protected finance never falls back to legacy SSH signing.

Generated-fixture verification does not establish live source enrollment. Live
migration and financial actions remain explicit owner operations.
