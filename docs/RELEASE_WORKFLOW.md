# Maintained development release workflow

The maintainer tool publishes an approved GridLens development candidate. It does
not install the live app or submit a financial operation. Approval of the plan
covers its stated publication after required checks pass; material scope,
destination or risk changes require fresh direction.

Use pinned Node/npm and existing Docker, GitHub CLI authentication and SSH access.
No host packages, service configuration, new user-managed API keys or registry are
introduced. Signing identities remain protected outside source and output bundles.

## Plan and execute

Keep a JSON configuration outside the checkout. It names the clean source commit,
release identity, existing release key paths, notes and isolated fixture profile.
For example, replace every illustrative path/commit/address before use:

```json
{
  "sourceDirectory": "/path/to/clean/gridlens-checkout",
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "version": "0.1.0-dev.24",
  "sequence": 24,
  "platform": "linux-x64",
  "repository": "MachoDrone/gridlens-typescript",
  "publicKeyPath": "/protected/modern-release-public.pem",
  "signingKeyPath": "/protected/modern-release-signing.pem",
  "notesPath": "/private/release-notes.txt",
  "previousTag": "modern-v0.1.0-dev.23",
  "enableWallet": true,
  "treasuryProtocol": 2,
  "verification": {
    "base": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "full": false
  },
  "build": { "cold": false },
  "fixture": {
    "sshTarget": "operator@192.168.50.10",
    "address": "192.168.50.10",
    "webPorts": [23947, 23949],
    "requireColdDownload": false
  }
}
```

The fixture address must belong to the explicitly approved fixture host. It must
not select a live/default instance or its ports. Each web port reserves its next
port for HTTPS. Docker destination identity is bound to the plan; changing the
Docker endpoint/context does not redirect a saved run's cleanup or recovery.

Owner-bound rollout first publishes coordinator3 in a compatibility runtime
(`treasuryProtocol:1`, minimum coordinator2). Only afterward publish the protected
runtime (`treasuryProtocol:2`, minimum coordinator3). The retained financial floor
prevents unsafe rollback. Changing this build capability requires image-bound
guardian/updater/installer acceptance even when the source commit is unchanged;
unchanged source-check evidence can still be reused.

The existing `modern-development` release retains the legacy channel filenames
for the compatibility bridge. Coordinator3 reads the separate
`modern-channel-v3-PLATFORM.json/.sig` pair; it falls back only when both new files
are absent. Protected publication preserves the legacy pair and verifies the
bridge's immutable prerequisites throughout promotion. Declared predecessor
identity and signed source proof remain mandatory even when a sequence is
skipped after an immutable but unpromoted failed release.

```sh
npm run release -- plan --config /private/release-config.json --output /private/release-plan.json
npm run release -- publish --plan /private/release-plan.json --run /private/release-run
npm run release -- status --run /private/release-run
npm run release -- resume --run /private/release-run
```

`plan` reads and describes the proposed identity. `publish --plan ... --run ...`
initializes and runs the approved process end to end. Optional `prepare` performs
checks/build/signing/isolated acceptance without publishing. A prepare-only run
requires explicit `publish` to acquire publication authority; `resume` retains
its existing authority. `abort` requests a stop before further mutations while
preserving in-flight results; `cleanup` reconciles only this run's owned fixtures.
Neither command unpublishes releases or rewinds branches/channels.

## Gates and recovery

The journal records source and verification identities, immutable artifact hashes,
stage results, mutation intent and observed outcomes. It contains no signing-key
bytes, tokens, cookies or generated owner passwords. State is private, atomically
written outside Git and locked to one writer.

The normal order is checks, build/image proof, signed bundle, local acceptance,
atomic source publication, draft/assets, public downloads, public installer
acceptance and channel promotion. Both branches must advance in one atomic push;
immutable releases and higher channels cannot be overwritten. A request accepted
with a lost response is reconciled from actual remote identities before any retry.

Resume revalidates evidence rather than trusting a saved `passed` flag. Completed
matching artifacts/checks are reused; changed inputs invalidate affected evidence.
Partial/conflicting assets, unknown remote state and changed source/destination
stop mutation. Read failures have bounded retries and retain their real cause.
Upload files have verified exact bytes and explicit lengths; stdin uploads are
not used. Channel replacement uses captured old asset IDs and no clobber, then
verifies canonical signed bytes against current API identities.

The existing channel protocol has separate JSON/signature assets. A failed
replacement can briefly leave an incomplete pair; clients fail closed. The
journal permits safe repair, not a promise of atomic two-file publication.

## Payload and component rules

The runtime artifact retains its `.tar` name and v1 manifest while its signed
bytes are gzip-compressed. Validate the raw OCI root, configuration, layer hashes,
ordered rootfs diff IDs and independent daemon image identity before signing.
Bound both compressed and expanded data. Cached Docker dependency layers are
allowed; `--cold` remains available for an explicit uncached producer check.

A coordinator can be reused only when its signed component descriptor and full
input fingerprint match the source/dependency closure, build tooling, Node binary,
platform and public trust anchor. The launcher pins the component's immutable
release tag and executable hash separately from the application's runtime tag.
The publisher verifies the referenced component anonymously before exposing the
new launcher. A matching public component avoids rebuilding and uploading its
binary/signature. New and reused inventories are explicit (13 and 11 assets),
including licenses; never upload an output directory by wildcard.

## Acceptance and measurements

Use only generated empty fixtures on the approved Docker/SSH host. The maintained
public harness runs the unchanged public launcher, selects the declared private
address through a bounded terminal, and fails on unexpected prompts. It checks
fresh setup, configured predecessor upgrade, old-installer retention, actual
image/config/HTTPS state and scoped cleanup. Generated owner credentials stay in
memory; an interrupted broker requires a new fixture generation.

Report whether production images were preloaded. Separately exercise cold gzip
loading through the actual older worker with a uniquely owned fixture image;
remove only that fixture image before the test, never a shared/live image. Preserve
financial history/allowances, TLS identities, grants and original failure reasons.

Every run reports stage elapsed/wait time, completed bytes and reused work. Compare
cold initial releases with eligible app-only releases. Compression reduces
transfer size, not the expanded installed image. No claimed savings substitute
for the measured reports or the required verification evidence.
