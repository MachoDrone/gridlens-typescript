# Guided local HTTPS setup

**Secure** in the Fleet sidebar opens the optional device setup guide. Its lock
icon remains visible with the sidebar collapsed, without increasing the sidebar
width. It is also reachable from Manage computers and the installer output.
The normal installer finishes with the dashboard URL; users complete the secure
connection in the app without extra terminal commands or copied sign-in codes.

The advanced `--secure-browser` installer action remains available to refresh the
public setup information for the existing installation and prints its guide,
public-certificate fingerprint and a one-use HTTPS operator sign-in link/code.
That code expires after five minutes; rerun the same action after completing
system trust if it expires. It does not regenerate certificates or install trust
on the viewing device.

The dashboard stays on the operator's own LAN/VPN PC. No domain, cloud address
service, public forwarding, DNS change or host package is required. Ordinary HTTP
Fleet access, existing HTTPS pairing and native Android pins remain available.
The public developer preview and portable snapshot gateway do not gain this
installed-backend capability.

## User journey

1. Confirm that first setup is on the owner's trusted private network. The guide
   detects the device/browser; its **Change** disclosure is only needed when that
   suggestion is wrong. The four device choices are Windows, macOS, Linux and
   Android. Samsung is covered under Android's optional help.
2. Download the existing **public CA certificate** directly to the viewing device.
   A recognizable filename avoids moving the file from another computer. A
   provided certificate is not automatically described as publicly trusted; a
   browser that already trusts its issuer can try the HTTPS check without import.
3. Follow one short OS/browser-specific instruction at a time. Android requires
   its **CA certificate** Settings flow, not a Wi-Fi/client certificate. Windows,
   macOS and Linux use the appropriate system or browser certificate manager.
   The OS may require a device PIN or administrator approval; GridLens never
   collects it. Next/Back buttons do not install trust.
4. Choose **I've imported it — Open GridLens** after the final import instruction.
   This obtains a short-lived handoff from the current private-network gateway and
   opens the actual saved HTTPS address. The HTTPS page checks its secure context
   and expected installation/certificate identity, reuses valid browser access or
   redeems the handoff, then returns directly to Fleet. There is no extra checkbox,
   code form or Ready-page action in this normal completion path. A failed TLS
   connection stays a failure; do not bypass a browser certificate warning.
5. **Already imported? Open GridLens** skips only the download/import instructions,
   not the HTTPS and access checks. The handoff is issued after the certificate steps so
   their duration does not consume its five-minute lifetime. If it expires, return
   to the saved ordinary dashboard and choose Secure again; no CLI is needed.
   HTTPS-only installations without the private-network entry point retain the
   existing terminal pairing fallback. Certificate trust itself grants no access.
   The browser's optional **Install GridLens** action remains separate.

Opening an HTTPS bookmark/PWA without a valid session resumes this guide instead
of stranding a normal private-network installation on the old connection-code
form. **Finish connecting** returns to the saved ordinary dashboard's resume card;
its explicit **Open GridLens** action requests a fresh handoff without asking the
user to import the certificate again. Terminal-code links remain supported and
retain explicit invalid/expired-code errors.

Initial HTTP delivery is **not independently authenticated** against an active
attacker on that network. A checksum or fingerprint displayed by the same HTTP
page does not change that. Use the fingerprint from the trusted installer or an
already trusted device when independent verification is available. Do not start
first enrollment on an untrusted network. The guide requests no Wallet password
and performs no claims, signing or transfers.

## Recommended first test

The GridLens backend must contain this update before the button appears.
Reinstalling a laptop or Android home-screen app does not update that backend.

1. After the backend is updated, open the usual dashboard URL in a laptop browser
   and reload it. Look for **Secure** in the left sidebar.
2. Complete the guide. The result should be Fleet at the saved HTTPS address,
   without a certificate warning and without another terminal command.
3. Repeat from Android on the same trusted network or existing VPN. Report the
   first instruction that does not match the device, or the exact error shown.
4. Once secure Fleet access works, use the browser's offered Install action if
   desired. Keep an older HTTP shortcut during testing; replace it with the HTTPS
   shortcut afterward if needed.

An explicitly labeled demo is only for reviewing screens. Do not install a
demo's generated certificate or treat a mock browser test as device trust proof.
Human-facing review previews provide static instructions/screenshots only;
they must not serve downloadable CA files or enroll browsers. Check the actual
backend version before sending an operator through certificate installation.

## Platform guidance and limits

| Platform | Guide coverage |
| --- | --- |
| Windows | Chrome, Edge and Firefox; OS trust and browser-specific fallback. |
| macOS | Safari, Chrome, Edge and Firefox; Keychain and browser trust guidance. |
| Linux | Chrome/Chromium/Edge and Firefox certificate managers; no assumed distro-wide propagation. |
| Android | Android Settings CA installation and browser HTTPS check; Samsung/One UI differences are in optional help, not a separate device choice. |

Detection selects instructions only; it is not security evidence. Settings names,
browser versions and device-management policies differ. A restricted device may
require its administrator or may not permit user CA trust. Unsupported cases must
be reported rather than declared successful. The guide cannot enumerate a
device's trust store or prove import just because a user pressed Next. Browser
TLS validation, secure context, saved server identity and backend authorization
are checked separately; removing a self-reported checkbox is not a claim that the
application can inspect the operating system's trust store.

For Linux Chrome/Chromium the first instruction is **Manage certificates**:
“Open this browser’s Settings and search for ‘Manage certificates’. Open that result.”
The current manager then uses **Local certificates → Installed by you → Trusted
certificates → Import**. Older Authorities-tab wording is confined to optional
help. The normal steps do not contain package-installation or implementation notes.

Source references: [Android CA installation restrictions](https://developer.android.com/reference/android/security/KeyChain#createInstallIntent()),
[Chrome connection and certificate controls](https://support.google.com/chrome/answer/95617),
[Firefox CA handling](https://support.mozilla.org/en-US/kb/setting-certificate-authorities-firefox),
[Chromium Linux certificate management](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/docs/linux/cert_management.md).

## Data and authority

The terminal coordinator publishes a versioned public record to the existing
durable safety ledger after checking the selected installation and its actual
endpoints. Only fixed public certificate files are exported. The gateway receives
neither the CA key nor a new private configuration mount. Certificate data is
bounded and parsed as public X.509 material; the leaf fingerprint and address
must match the saved configuration. HTTPS serving also checks its actual leaf
against the published record.

The short-lived public-export helper runs with no network, a read-only root and
only the two owned config/TLS volumes mounted read-only. It adds `DAC_READ_SEARCH`
to traverse their different owner-only directory permissions while reading its
fixed public certificate paths. It changes no volume permissions and exposes no
private-key read operation. Runtime gateways gain no capability or mount.

The guide serves `/secure-setup`, `/secure-setup/status.json` and the fixed
`/secure-setup/ca.crt` download on the configured gateways. These routes expose no
fleet readings, credentials, pairing codes or owner privileges. They preserve
exact Host/Origin checks and no-store responses. Browser input cannot select
paths, certificates or arbitrary redirect destinations. Nonsecret wizard progress
does not restore authorization or establish trust after reload.
The guide binds its certificate download to the reviewed SHA-256 ETag with
`If-Match`. A changed publication returns 412 with no certificate bytes, and the
browser does not save an error body or a certificate under the old identity.

The separate `POST /secure-setup/connect-code` route is available only through
the configured private HTTP gateway and its server-held grant, with an exact
Origin and bounded body. `POST /secure-setup/connect` redeems that one-use handoff
only over the actual matching HTTPS gateway and sets a Secure, HttpOnly,
SameSite cookie. The handoff travels briefly in a URL fragment, is immediately
removed from history, and is held only in page memory. Session bearers are never
returned in JSON. An ambiguous redemption response is followed by an access check,
not blind repeated enrollment.

Tickets and browser-session hashes live in a separate durable ledger namespace,
not in the legacy independent-device records. Tickets bind the current roster
and certificate/origin identity. Redeemed browsers follow their active parent
gateway's current fleet and are checked against its revocation on every request.
They inherit its operational access, not financial ownership, and cannot create
independent pairings or administer devices. A terminal-paired operator can revoke
them individually. Older code cannot recognize these derived session tokens;
rollback does not turn them into unrestricted independent devices.

The selected image advertises `io.gridlens.browser-security-protocol=1`.
Older images without that capability keep their existing installer/rollback
behavior. Public setup state is retained separately from rollbackable observation
snapshots; installer/update reconciliation refreshes it for the selected runtime.

Existing CA and leaf identities are reused. Expiration, a changed address or a
mismatch requires repair; the guide never rotates a key or CA to conceal the
problem. Automatic leaf renewal and native pin rotation remain separate work:
renewing a certificate changes its fingerprint even if its key stays unchanged.

## Verification and follow-on work

Automated coverage uses generated certificates, injected metadata, isolated
loopback servers and browser fixtures. Test certificate/key separation, malformed
or stale publications, nonadjacent ports, IPv6, invalid identities and dates,
guide cancellation/reload, OS/browser selection, pairing separation, and HTTP
and update regressions. The final source check is `npm run check`; installed
runtime changes also require applicable isolated Docker acceptance.

Prior milestone verification on October 31, 2026 (before the November 1 UX changes):

| Check | Result |
| --- | --- |
| Final pinned-toolchain `npm run check` | Strict typecheck/build, 1,038 Node tests and 413 Chromium browser tests passed after the sidebar and browser-handoff update. |
| Dedicated guided-setup journeys | Chromium wizard/sidebar cases passed within the full suite; Firefox 25 passed with two unsupported mobile-emulation cases skipped; WebKit 27 passed in isolated Docker. |
| Generated-certificate TLS integration | Public CA/leaf validation, served-leaf mismatch rejection, conditional-download identity and separate browser authorization passed. |
| Corrected source image and actual updater | Uncached build, browser-triggered upgrade, worker replacement and injected-failure rollback passed. Public CA, leaf identity, endpoints, server identity and the derived HTTPS session were preserved. The real TLS handoff required no terminal code, rejected replay and stopped authorizing after its parent grant was revoked; fixture cleanup passed. |
| Actual client certificate import | Not established. An isolated Linux Chromium experiment reached the certificate manager and correctly rejected the untrusted CA, but its native import picker could not be completed by the headless test tool. |

No host trust store was changed. The Docker fixtures used generated identities,
empty fleets, bounded resources and explicit cleanup; no live installation was
updated. These results do not establish physical Android, Windows or macOS trust
approval, native client pin rotation, or a published release.

Browser mocks and emulation do not establish OS certificate installation. Record
real platform/browser versions and physical Android walkthroughs separately.
Windows/macOS and physical phone trust verification are not established by the
Linux development environment. Do not advertise every device/browser as verified.

November 1 candidate verification, based on the current public release source
and preserving its Docker image-identity/lock corrections:

- Final pinned-toolchain `npm run check`: 1,050 Node tests and 434 Chromium
  browser tests passed, including the simplified guide and signed-out HTTPS entry.
- Dedicated guide journeys: Firefox 31 passed with two unsupported mobile
  emulation cases skipped; WebKit 33 passed in isolated Docker.
- The uncached candidate image passed the actual browser-triggered worker
  upgrade, worker replacement and injected-failure rollback. Public certificate
  identities, endpoints and derived browser access were preserved; revoking the
  parent grant denied the derived session. Fixture cleanup passed.
- No source publication or live backend update is established by these checks.
  Physical OS trust approval remains distinct from browser/transport tests.

This milestone does not add a Wallet screen or authorize financial operations.
The subsequent Wallet feature retains one owner, password-protected entry, CLI
recovery, a single receiving wallet and separate/combined Rewards and NOS
collection. Staked NOS remains untouched. Live financial enablement requires
its own transaction, payout-recipient and authorization acceptance.
