# Shipping a scanner release

How a new build of the Android scanner reaches the handhelds in the stores, without
anybody plugging in a USB cable.

The short version: **build → hash → upload → record → point beta → watch → point
stable.** Rolling back is one dropdown.

---

## ⚠️ Before the first release: two prerequisites

### 1. The hosting certificate is EXPIRED

APKs are served from:

```
https://scaleprogrammers.com/projectdata/PPS_RETAIL_HH_UPDATE/
```

The folder exists and the server serves files from it correctly. **But the site's
TLS certificate expired on 25 July 2022.**

Android will refuse to download over an expired certificate — there is no "continue
anyway" in a download, and the app deliberately does not disable certificate
validation (the one thing you must never weaken is the channel that installs
executable code). **Until the certificate is renewed, self-update cannot work in
production**, no matter what is recorded in the admin panel.

Renewing it changes nothing else: same domain, same folder, same FTP upload. It is a
hosting-panel action on the GoDaddy account that serves `scaleprogrammers.com`
(`107.180.117.116`, Apache).

The admin panel will tell you if this is still outstanding — recording a release
probes the URL and reports:

> *The host's HTTPS certificate has EXPIRED. Android will refuse this download —
> renew the certificate before publishing here.*

That warning does **not** block saving the release. It is advice, not a gate.

### 2. The signing key

Every build must be signed with **`keystore1.jks`, alias `key1`**. A build signed
with anything else cannot install over what is on the devices, and the update chain
breaks permanently for every scanner in the field. See the ⚠️ box in the scanner
repo's `README.md`.

---

## The routine

### 1. Build

In the scanner repo, with `keystore.properties` in place:

```bash
./gradlew assembleRelease
```

Or Android Studio → **Build → Generate Signed App Bundle / APK → APK → release**.

### 2. Get the values the form wants

```bash
powershell -File scripts/hash.ps1
```

It prints the version code, version name, the **filename to upload as**, the size,
and the SHA-256 — and warns loudly if the APK came out unsigned.

Upload under the name it gives you (`pps-retail-hh-{versionName}-{versionCode}.apk`).
Hand-typed names drift from what is inside the file: the first release shipped as
`PPS_RETAIL_1.0.0.apk` while actually containing version 1.1.0, and once the name
lies nobody can tell which file on the server is which build.

### 3. Upload

By FTP, to the folder above. Nothing in this system uploads for you, and no FTP
credential exists anywhere in either repository — that is deliberate.

Old APKs **stay**. They are what makes rollback instant.

### 4. Record the release

Admin host → **Platform → Scanner releases → Record release**. The URL field is
prefilled with the folder; add the filename. Paste the version code, version name and
SHA-256 exactly as the script printed them.

The hash is the security boundary of the whole feature: the device refuses to install
anything whose bytes do not match it. A wrong hash means every device rejects the
download — safely, but nobody updates until it is corrected.

### 5. Point beta at it

**Platform → Channels → beta → Offers**. Devices in beta companies are offered the
build within six hours, or immediately if someone taps *Check for updates*.

### 6. Watch

**Platform → Devices**. Each company lists its scanners, what each is running, and
when it last reported. A gun still marked *behind* a day later did not take the
update — that is the signal to look before promoting.

### 7. Promote to stable

Same dropdown, `stable` row. Every company on stable is offered it from then on.

---

## Rolling back

**Point the channel at the previous release.** That is the entire procedure.

Devices already on the bad build are then *ahead* of what the channel offers, so they
are told they are up to date rather than being walked backwards — Android refuses to
install an older version code over a newer one anyway. To actually pull them back you
must uninstall and reinstall on the affected devices, which is the real reason to
stage through beta first.

---

## Forcing an upgrade

**Channels → minimum supported.** Below that version, the app shows a full-screen
"no longer supported" message and nothing else works, including login.

Use it sparingly — it stops a store working — and only when running the old build is
worse than not running at all: a data-corrupting bug, or a server change the old
client cannot speak to.

The panel refuses to point a channel at a release older than its own minimum, which
would tell devices to update straight into the blocking screen.

---

## Who gets what

Each company has one channel (**Platform → Companies → Scanner channel**). New
companies default to `stable`.

Changing it writes an audit event on **that company's** trail (entity `COMPANY`,
field `release_channel`), because what software a tenant's staff run is their
business too, even though only the platform can change it.

---

## What the device does

- Checks on launch, throttled to once per six hours, plus on demand from the update
  icon on the home screen.
- The check is **public** — it works before login, because an app broken badly enough
  to fail login is the one that most needs updating.
- A failed check is **silent**. The automatic one, anyway: a manual check always
  answers, including "could not reach the server".
- Downloads over HTTPS to app-private storage, verifies the SHA-256, and only then
  opens the installer. A mismatch deletes the file and reports it.
- The user confirms the install; nothing installs silently. First time, Android also
  asks for "install unknown apps" permission, and the app walks them to that setting
  and resumes without re-downloading.
- On the next launch the downloaded APK is deleted.

## What it reports

Every API call carries `X-App-Version` and `X-Device-Id`. On authenticated requests
the server records them against the company (deduplicated to one row per device, at
most one write per device per five minutes). That is what fills the Devices view.

The device id is a UUID generated on first run and stored in the app's own DataStore.
It identifies an install, not a person and not a handset.
