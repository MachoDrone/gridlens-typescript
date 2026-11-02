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
   suggestion is wrong. The five device choices are Windows, macOS, Linux,
   Android and **iPhone / iPad**. Samsung is covered under Android's optional help.
   Explicit iPhone/iPad/iPod identifiers take precedence over their “Mac OS X”
   text. `MacIntel` with more than one touch point suggests a desktop-mode iPad;
   this editable hint is not proof of the device or any security property.
2. Download the existing **public CA certificate** directly to the viewing device.
   Windows, macOS, Linux and Android receive the `.crt` file. If the browser asks, choose **Keep** for this requested GridLens certificate.
   If its popup has closed, open the browser menu → **Downloads**. Wait for the
   completed `.crt` file named by the guide before **File saved — Next**;
   `Unconfirmed*.crdownload` is temporary and cannot be imported. Do not rename
   temporary files. A recognizable filename avoids moving the file from another computer. A
   iPhone/iPad instead uses a certificate-only `.mobileconfig` profile through a
   real Safari URL, described below. It is not the desktop fetch/Blob download.
   A provided certificate is not automatically described as publicly trusted; a
   browser that already trusts its issuer can try the HTTPS check without import.
3. Follow one short OS/browser-specific instruction at a time. Android requires
   its **CA certificate** Settings flow, not a Wi-Fi/client certificate. Windows,
   macOS and Linux use the appropriate system or browser certificate manager.
   Before opening Android Settings, the guide explains the possible **Your data
   won’t be private** warning and that this CA trust extends beyond GridLens.
   **Install anyway** accepts that trust; **Don’t install** cancels it.
   iPhone/iPad users install the downloaded profile in Settings, then separately
   enable the root under **General → About → Certificate Trust Settings**.
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
6. After secure Fleet access works, deleting downloaded GridLens `.crt` files,
   saved `.mobileconfig` files and duplicate copies is optional cleanup. Keep the
   installed certificate/profile in device/browser settings; removing that trust
   would restore certificate warnings. Deleting a downloaded file does not remove
   the installed profile or certificate.
   The public file remains on the GridLens backend and can be downloaded again
   from **Secure**, then imported again if device trust was removed or for a new
   device. An already connected HTTPS browser has **Download certificate again**
   on the secure-ready screen; that download does not repeat import or connection
   setup. It retains the same public-certificate identity check and never reports
   browser saving as confirmed. Losing a downloaded copy requires no CA
   regeneration. The guide does not delete files or inspect the device's
   certificate store. Installations using a supplied certificate without a CA
   download do not offer this recovery action.

Opening an HTTPS bookmark/PWA without a valid session resumes this guide instead
of stranding a normal private-network installation on the old connection-code
form. **Finish connecting** returns to the saved ordinary dashboard's resume card;
its explicit **Open GridLens** action requests a fresh handoff without asking the
user to import the certificate again. Terminal-code links remain supported and
retain explicit invalid/expired-code errors.

Once `/connect` confirms access, viewers and operators with a valid nonempty
current authorized roster open Fleet directly. Empty operator fleets retain
first-time setup, including results that appear when their roster fills later;
background polling does not take users away from those results. A missing or
malformed current roster cannot infer that the
fleet is configured from an old setup report. Deliberately opening **Hosts** or
`/setup` still opens computer management. For an existing fleet, that page puts
**View Fleet** first and describes computer selection as an optional management
action. It does not require users to select their saved computers again.
The web-app manifest still starts at `/`; these changes do not rewrite a saved
browser shortcut or redirect every restored management window. Physical installed
app relaunch remains a separate check.

The generated private CA has no name constraints. Its trust is broader than the
GridLens address, even though the served leaf certificate identifies that address.
Its signing key stays in the backend's protected persistent configuration volume;
the browser receives only the public certificate. Installing it does not itself
share browsing data or start interception. Someone controlling the signing key
and intercepting traffic could impersonate other sites in clients that accept
that CA. Android apps may instead use other trust settings or certificate pins.
The guide explains this choice without dismissing Android's warning or changing
the existing CA, saved identities or trust settings.

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
| iPhone / iPad | Safari profile download, Settings profile installation, separate full trust switch, then HTTPS/access checks in the intended browser. Safari, Chrome, Edge and Firefox are selectable instructions. |

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

Windows uses **Current User → Next** and the explicit **Trusted Root
Certification Authorities → OK → Next → Finish** selection. The guide does not
require the Local Machine store. Mac imports into the **login** keychain through
File → Import Items, keeps that destination and chooses Open, then changes only
**Secure Sockets Layer (SSL)** trust. It does not require the System keychain or
setting every certificate policy to Always Trust.

Firefox desktop guidance accommodates **Manage Certificates** and **View
Certificates**, with a manual **Authorities → Import** fallback. Mozilla states
that current Firefox on Windows, macOS and Android normally uses third-party
operating-system roots; versions, the chosen store and policy can affect that.
Firefox for Android is not sent to a desktop certificate manager or hidden debug
settings. If it still rejects the installed CA, verify installation and consult
the applicable Firefox version/device policy or Mozilla support.

### iPhone and iPad profile handoff

Use Safari for the documented profile-download handoff. Another browser can
continue serving the GridLens dashboard after its own HTTPS and authorization
checks, but installing trust in Safari does not copy a GridLens session to that
browser. Apple permits alternative browser engines and certificate policies in
some regions, so identical behavior across all browser versions is not assumed.

The profile is named **GridLens &lt;instance&gt; CA (&lt;fingerprint prefix&gt;)** and contains exactly one
certificate payload, **GridLens &lt;instance&gt; root certificate (&lt;fingerprint prefix&gt;)**. The certificate
itself is unchanged; its normal name in Certificate Trust Settings is
**GridLens Private Trust**. Profile display labels do not rename its subject.
The fingerprint prefix helps distinguish installations that share an instance
name; it does not authenticate an initial HTTP download independently. Trust the
certificate inside the profile just reviewed, not every certificate with the
same common name.

1. Follow the real profile link in Safari and allow the download if asked. Wait
   for **Profile Downloaded**, then open Settings and select that item. The
   downloaded profile can also be found under General → VPN & Device Management.
2. Review the expected GridLens CA profile, choose Install and follow Settings'
   confirmation. Enter an existing device passcode only in Settings if requested.
   **Not Signed** can appear because the profile is unsigned. That label is not
   dismissed as harmless: proceed only for the expected certificate from the
   operator's own or trusted GridLens computer, after reviewing its contents.
3. After installation, open Settings → General → About → Certificate Trust
   Settings. Enable full trust for the root just installed and accept the system
   confirmation only after accepting the broad CA trust described above.
4. Return to the intended browser's GridLens guide and choose Open GridLens. If
   Safari was used only for installation, return to the original browser and use
   **Already imported? Open GridLens**. This browser gets its own access check and
   handoff only when requested; profile installation itself supplies no session.

A pending profile expires after eight minutes and only one can await installation.
If a previously downloaded profile expired, download it again in Safari. If
Safari never reports Profile Downloaded, stop there and report its message; a file
in Files alone is not proof that Settings received an installable profile. If the
GridLens root is absent from Certificate Trust Settings, finish profile
installation first. Device-management policy or Stolen Device Protection may
block installation. The guide does not turn those protections off or instruct
users to create a new passcode. It adds no Apple-account, device-management
enrollment, VPN, proxy, client-identity or device-control settings.

The current `.crt` fetch/Blob path has not been established as an iPhone/iPad
profile-import mechanism. Apple supports raw certificate formats too, so this is
not a claim that `.mobileconfig` is universally required. The separate profile
route uses Apple's documented certificate payload and Safari handoff rather than
assuming a downloaded PEM file can be opened from Files to install trust.
The profile is delivered over the same initial private HTTP trust boundary;
its format or a name shown on that page does not independently authenticate it.
Apple's current manual-profile article does not specify a universal HTTP/HTTPS
transport rule. It is not evidence that every current Safari/device policy accepts
this exact private-HTTP handoff. Physical **HTTP URL → Profile Downloaded → Settings
installation** remains unverified; neither the profile schema nor browser mocks
prove those operating-system steps. Apple's archived authenticated OTA/SCEP
enrollment guidance requires secure server access and is not used as proof that
this standalone manual HTTP flow works.

Primary sources reviewed **November 1, 2026**:
[Apple profile installation](https://support.apple.com/en-us/102400) (published April 14, 2026),
[Apple manual SSL/TLS trust](https://support.apple.com/en-us/102390),
[Apple root-certificate payload](https://developer.apple.com/documentation/devicemanagement/certificateroot),
[Apple certificate management](https://support.apple.com/guide/deployment/depb5eff8914/web),
[Apple certificate import on Mac](https://support.apple.com/guide/keychain-access/kyca2431/mac),
[Apple certificate trust controls on Mac](https://support.apple.com/guide/keychain-access/kyca11871/mac),
[Apple alternative browser engines](https://developer.apple.com/support/alternative-browser-engines/).
The older [Apple manual-profile distribution guide](https://support.apple.com/guide/profile-manager/distribute-profiles-manually-pmdbd71ebc9/5.11/mac/11.3)
supports Safari/`.mobileconfig` recognition, not its obsolete Settings menu names;
the current profile-installation article supplies the steps above.

Other platform primary references, reviewed on the same date:
[Android CA installation restrictions](https://developer.android.com/reference/android/security/KeyChain#createInstallIntent()),
[Chrome connection and certificate controls](https://support.google.com/chrome/answer/95617),
[Chromium local trust-store integration](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md#how-does-the-chrome-certificate-verifier-integrate-with-platform-trust-stores-for-local-trust-decisions),
[Firefox CA handling](https://support.mozilla.org/en-US/kb/setting-certificate-authorities-firefox),
[Microsoft Current User versus Local Machine stores](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/local-machine-and-current-user-certificate-stores),
[Microsoft certificate import](https://learn.microsoft.com/en-us/skype-sdk/sdn/articles/installing-the-trusted-root-certificate),
[Chromium Linux certificate management](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/docs/linux/cert_management.md).
The older Microsoft enterprise article supplies wizard terminology; its later
Local Machine administration instructions are not part of this per-user guide.

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

Apple's separate fixed route is
`GET /secure-setup/apple-ca/<CA-SHA256>.mobileconfig`. A real browser navigation
lets Safari handle the profile; the fingerprint in the path binds it to the
checked certificate without relying on a custom header during navigation.
The profile contains only one `com.apple.security.root` payload with the existing
public CA encoded as DER inside plist data. It contains no private key or other
configuration payload. It does not issue browser authorization or automatically
enable OS trust. The profile adds no removal restriction; existing device policies
still apply to the device's ordinary controls.
The profile route supports the saved self-signed root generated by GridLens. An
intermediate-only CA or a supplied server certificate does not become an Apple
root profile; that route gives a setup message without certificate bytes. Existing
`.crt` exports keep their prior behavior. A changed fingerprint is rejected before
delivery, and profile errors provide a same-origin link back to Secure.

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

The operator subsequently authorized Apple instructions and required all platform
instructions to be checked against primary sources. This supersedes the earlier
Apple deferral. The revised iPhone/iPad flow, profile format and desktop guidance
require final automated acceptance for this candidate; the earlier results below
do not establish that acceptance. The operator does not own Apple test devices.
No physical iPhone/iPad/Mac profile import or full-trust approval has been verified.
Browser emulation and generated-profile tests cannot establish those OS actions.
Do not ask the operator to obtain Apple devices or describe the walkthroughs as
physically verified without separate evidence.

November 1 operator-reported physical Brave/Chrome download observation: the
browser required **Keep** approval for the requested certificate. Repeated
download attempts left `Unconfirmed*.crdownload` files that were not available
as completed certificates in the import picker. The guide previously omitted
this approval step; it now explains where to find the pending download and to
wait for the completed `.crt` before proceeding. This evidence establishes a
download-approval blocker, not a completed certificate import or trusted HTTPS
walkthrough. GridLens cannot detect browser approval, file saving or OS import.
The download format, filename generation and browser protections are unchanged;
the pre-download notice is hidden when no CA download is offered.

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

Secure setup does not establish Wallet ownership or authorize financial operations.
The separate [Wallet pilot candidate](WALLET_PILOT.md) adds one owner,
password-protected entry, CLI recovery and a single receiving wallet. Its first
milestone is one reviewed 1 NOS transfer; reward claims and combined collection
remain later work. Staked NOS stays untouched. Wallet requires the current saved
HTTPS connection and independent owner authorization. Live enablement and receipt
verification remain separate from certificate setup.
