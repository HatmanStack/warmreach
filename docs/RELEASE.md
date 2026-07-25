# Desktop Client Releases

How the WarmReach Agent gets built, signed, and put in front of users.

## The pipeline

Pushing a `CHANGELOG.md` change to `main` triggers `release.yml`, which:

1. reads the newest released version from `CHANGELOG.md` and creates the tag,
2. creates the GitHub release on this repo,
3. fans the release out to the public `HatmanStack/warmreach` repo
   (`release-sync.yml`),
4. calls `electron-release.yml`, which builds every desktop platform in
   parallel and uploads the installers to the **community** release.

electron-updater is configured (`client/electron-builder.yml` → `publish`) to
fetch from `HatmanStack/warmreach`, which is why artifacts go there rather than
here.

## Platforms and their update manifests

| Platform | Runner           | Artifacts                      | Update manifest    |
| -------- | ---------------- | ------------------------------ | ------------------ |
| Linux    | `ubuntu-latest`  | `*.AppImage`                   | `latest-linux.yml` |
| macOS    | `macos-latest`   | `*.dmg` (x64 + arm64), `*.zip` | `latest-mac.yml`   |
| Windows  | `windows-latest` | `WarmReach-Agent-Setup-*.exe`  | `latest.yml`       |

The manifest is not optional. electron-updater discovers new versions by
reading it, so an installer uploaded without its manifest is invisible to
every existing install. The upload step fails loudly if a platform's glob
matches nothing, rather than publishing a release that silently lacks a build.

macOS auto-update needs the `zip`, not the `dmg` — the dmg is only for the
first manual install. Both are built and uploaded.

## Code signing

Signing is driven entirely by whether the secrets are set. With none
configured every platform still builds, just unsigned, so the pipeline is
useful before certificates are purchased. Adding the secrets later turns
signing on with no workflow change.

> **Unsigned macOS and Windows builds are not fit to hand to customers.**
> Gatekeeper refuses an unsigned or unnotarized app on macOS; SmartScreen shows
> a scary "unrecognised app" interstitial on Windows that most users will not
> click through. Unsigned builds are for testing the pipeline only. The
> workflow emits a `::warning::` for each unsigned platform.

### macOS — Apple Developer ID

Requires membership of the [Apple Developer Program](https://developer.apple.com/programs/)
(currently 99 USD/year). Enrolment involves identity verification and can take
**a few days**, longer for an organization (which also needs a D-U-N-S number).

1. In the Developer portal create a **Developer ID Application** certificate.
2. Export it from Keychain Access as a `.p12` with a password.
3. Base64 it: `base64 -i cert.p12 | pbcopy`.
4. Create an app-specific password at <https://appleid.apple.com> for
   notarization.

Repo secrets:

| Secret                        | Value                                           |
| ----------------------------- | ----------------------------------------------- |
| `APPLE_CSC_LINK`              | base64 of the `.p12`                            |
| `APPLE_CSC_KEY_PASSWORD`      | the `.p12` export password                      |
| `APPLE_ID`                    | the Apple ID email                              |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password, not the account password |
| `APPLE_TEAM_ID`               | 10-character team ID from the Developer portal  |

Notarization (`mac.notarize: true`) uploads the signed app to Apple and waits
for a verdict, so mac builds take noticeably longer than the others. A signed
app that is _not_ notarized still fails Gatekeeper, so both halves are needed.

### Windows — code-signing certificate

⚠️ **Order this early.** An OV certificate takes days; an **EV certificate
takes 1–3 weeks** of calendar time for organizational vetting, and it is the
one that clears SmartScreen reputation immediately. This is the longest lead
time in the whole launch, and it is pure waiting — start it before you need it.

Issuers include DigiCert, Sectigo, and SSL.com. Modern EV certificates ship on
a hardware token or via a cloud signing service, which does **not** fit the
`CSC_LINK` base64-a-`.pfx` model — cloud signing (Azure Trusted Signing,
DigiCert KeyLocker, SSL.com eSigner) needs a different electron-builder
configuration. Decide which you are buying before wiring the secrets.

For a file-based certificate:

| Secret                 | Value                |
| ---------------------- | -------------------- |
| `WIN_CSC_LINK`         | base64 of the `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | the `.pfx` password  |

## Making the download buttons appear

The web app's download prompt is data-driven: it renders a real button for any
platform whose URL is set and "(coming soon)" for the rest. Nothing in the
frontend needs changing when a platform starts shipping.

The URLs come from the `client-downloads` Lambda, which reads the
`ClientDownloadMacUrl` / `ClientDownloadWinUrl` / `ClientDownloadLinuxUrl` SAM
parameters. `scripts/deploy/deploy-sam.js` prompts for all three, so:

1. run a release and confirm the artifacts landed on the community release,
2. re-run `npm run deploy` and paste the release asset URLs,
3. the buttons appear — no frontend rebuild required.

`https://` URLs are returned as-is; `s3://bucket/key` values get a 5-minute
presigned URL minted per request. Plain `http://` is rejected.

## Backfilling a past tag

`electron-release.yml` has a `workflow_dispatch` trigger taking a tag, so
artifacts can be rebuilt for an existing release without cutting a new one.

## Testing a build locally

```bash
cd client
npm run build:ts
npx electron-builder --linux --publish never
npx electron-builder --win --publish never
```

macOS needs the unsigned flags, because `mac.notarize` is `true` in
`electron-builder.yml` for release builds. Without them a local build tries to
notarize, and fails on the missing Apple credentials:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac --publish never --config.mac.notarize=false
```

That is exactly what CI runs for the unsigned path, so a local build matches it.

Each platform must be built on its own OS. Note that CI deliberately does
_not_ use the `electron:build` npm script: its cleanup step calls POSIX `find`,
which resolves to Windows' unrelated `find.exe` on `windows-latest`.
