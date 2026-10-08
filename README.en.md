# DSH Tuanjie Cowork Connect


中文 | [English](./README.md)


Bring the models bundled with the **Tuanjie Cowork** desktop app (Codely — GLM-5.3, DeepSeek-V4.1-Flash and friends) straight into DeepSeek Harness, ready to use in the DSH chat window with zero configuration.


## Features


- **Zero configuration.** The plugin reuses the sign-in already present in the Tuanjie Cowork desktop app. The only prerequisite: that app is installed and signed in.


- **Live model roster.** After install, a **Tuanjie Cowork** group appears in DSH's model picker. The roster is fetched from the gateway on every startup, so new upstream models appear without a plugin update; a failed fetch falls back to the built-in list and the group never disappears.

| Model ID | Backing model | Images |
|---|---|---|
| `codely-core` | GLM-5.3 | ✅ |
| `codely-flash` | DeepSeek-V4.1-Flash | ✅ |
| `codely-basic` | DeepSeek-V4.1-Flash | ✅ |
| `codely-air` | DeepSeek-V4.1-Flash | ✅ |
| `codely-vl` | Vision | ❌ (text only) |


- **Full capability coverage**, verified live: streaming, reasoning content, tool calls, image input.


- **Reasoning efforts** `low` / `high` / `max`, verified against every model on this route. Unverified spellings are deliberately not offered.


- **Model visibility.** In the card's model tab, untick a model to hide it from DSH's model picker; tick it to bring it back. Preferences are saved per account, and hiding affects the picker only — a session already using a hidden model keeps working, and models the upstream adds later start visible.


- **Self-healing.** A 401/403 from the gateway mints a fresh key and replays the request once. The credential file is rescanned every 30 seconds, so signing back in through the app recovers within 30 seconds — no DSH restart needed.


- **Account detection.** `dsh-tuanjie-connect status` reports the signed-in account, email, token expiry, **remaining quota** and model-key health; `doctor` prints secret-free diagnostics (paths, token expiry, key state). Both accept `--json`, and neither ever emits a token — they are redacted automatically.

```console
$ dsh-tuanjie-connect status
Tuanjie Cowork Connect: signed in as WuuShan
Email: 805490972@qq.com
Access token expires 2027-10-08T03:34:26.000Z (364 days; refresh is automatic)
Remaining quota: 9948 points
Model key: ready
Credential file: C:\Users\Administrator\.codely-cli\oauth_creds.json
```

  Signed-out, rejected-token and exhausted-quota each get their own explicit state and hint instead of failing silently.


- **Cost reports as zero**: quota is subscription-based and no per-token price is knowable.


## Install


Prerequisite: the Tuanjie Cowork desktop app is installed and signed in (that account's quota is what gets used).


Open **Plugins** in the DSH sidebar → **Add plugin**, and paste this repository address:


```
https://github.com/WuuShan/dsh-tuanjie-connect
```


Or from the command line (when `dsh` is on PATH):


```sh
dsh plugin --profile desktop add git+https://github.com/WuuShan/dsh-tuanjie-connect.git
```


Then **restart DSH** and pick a model from the new group.


**Version compatibility (important).** Peer dependencies are checked at install; a mismatched bundle is silently skipped (stderr prints `skipping profile bundle`).


| Plugin version | Requires DSH core | Desktop app |
|---|---|---|
| **0.1.0 (current)** | **`0.2.0-rc.2`** | Desktop build with the `0.2.0-rc.2` core |


### Manual install (no GitHub access)


```powershell
# 1. Place this repository inside the profile
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tuanjie-connect"
New-Item -ItemType Directory -Force -Path "$dst\lib","$dst\test" | Out-Null
Copy-Item .\lib\*.js $dst\lib\
Copy-Item .\package.json, .\cordis.patch.yml, .\LICENSE, .\README* $dst\

# 2. Edit $env:USERPROFILE\.dsh\profiles\desktop\package.json and append
#    "dsh-tuanjie-connect" to the dsh.profile.bundles array
# 3. Restart DSH
```


## Updating


The Plugins page has **no upgrade button** (by design: it neither lists registry versions nor offers upgrades), so updating is a command-line step. The dependency is pinned to an exact commit, and re-running `add` re-resolves it to the latest one:


```sh
dsh plugin --profile desktop add git+https://github.com/WuuShan/dsh-tuanjie-connect.git
```


`Packages: +1` means a new revision was fetched; `Already up to date` means you are current. Then **restart DSH**.


When `dsh` is not on PATH, use the launcher the app ships (Windows):

```powershell
& "E:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add git+https://github.com/WuuShan/dsh-tuanjie-connect.git
```


Check which commit is installed:

```sh
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\pnpm-lock.yaml" -Pattern 'codeload.github.com/WuuShan'
```


See [CHANGELOG.md](./CHANGELOG.md) for version history.


## Command line


```sh
dsh plugin --profile desktop exec dsh-tuanjie-connect status     # account, quota, key state
dsh plugin --profile desktop exec dsh-tuanjie-connect doctor     # diagnostics (paths, expiry, key)
```

Both accept `--json`. They also run directly:

```sh
node lib/bin.js status
```


## Verify your install


```sh
git clone https://github.com/WuuShan/dsh-tuanjie-connect
cd dsh-tuanjie-connect
node test/protocol.test.mjs   # 34 checks: credentials, signing, roster, shim, streaming, tools, images
node test/account.test.mjs    # 31 checks: account, quota, redaction, status route
```


Both run against the real endpoints using your own sign-in. All green means the install works.


> This sends a few real requests and may consume quota.


## How it works


The Tuanjie Cowork model gateway (`codely-litellm.tuanjie.cn`) **does not accept a bare bearer** — an `x-api-key` alone is refused (401, “please upgrade to the latest Codely”). Every request must also carry an `X-Codely-Signature` HMAC:


```
signingKey = HMAC-SHA256( HMAC-SHA256(pepper, "codely-signing-v1"), sk-… )
signature  = "v1." + unixSeconds + "." + base64url( HMAC-SHA256(signingKey, "v1\n" + path + "\n" + unixSeconds) )
```


The `sk-…` value is a LiteLLM virtual key minted with the app's `access_token` via `GET /api/api-token/cli-api-key?teamId=<orgId>`; `pepper` is a constant compiled into the desktop client. The signature covers the request **path**, so it is recomputed per request and cannot be cached.


Because pi-ai's `streamSimple` path does not accept a custom `fetch` while the signature must be injected per request, the plugin runs a loopback endpoint bound to `127.0.0.1`: pi-ai speaks plain OpenAI to it, and it signs and forwards upstream. The upstream key never leaves the plugin process — pi-ai only ever holds a per-run random bearer. Reasoning arrives as OpenAI-style `reasoning_content`, which pi-ai parses natively on this transport.


Account detection uses two control-plane endpoints: `/auth/external/me` (identity) and `/api/user/usage/summary` (remaining quota and per-pool detail). The same loopback endpoint also serves a `/status` route for local consumers such as the settings card — it requires the same bearer and carries no secret.


### Configuration


Two optional fields (defaults match the app's own locations):


| Field | Default |
|---|---|
| `authFile` | `~/.codely-cli/oauth_creds.json` |
| `orgFile` | `~/.codely-cli/org.json` |
| `visibilityFile` | `~/.dsh/tuanjie-visibility.json` |


Environment variables: `DSH_TUANJIE_AUTH_FILE` / `DSH_TUANJIE_ORG_FILE` / `DSH_TUANJIE_VISIBILITY_FILE` (path overrides), `DSH_TUANJIE_POLL_MS` (credential scan interval, default 30000).


## Known limitations


- **Depends on the app's sign-in.** Signing out of the app empties the group; the plugin ships no sign-in flow of its own.
- **Depends on unpublished internal interfaces.** `api-token/cli-api-key`, `/auth/refresh` and the signing scheme were reverse-engineered; upstream changes can break the plugin until realigned as described above.
- **`refresh_token` may be stale** (it was on the machine this was developed on). When the access token then expires, sign in through the app once; the plugin recovers within 30 seconds.
- **`codely-vl` is text-only**: the gateway's `is_vlm` flag does not mark it.
- The minted `sk-` key is cached back into `~/.codely-cli/oauth_creds.json` — the same file and field the Codely CLI itself uses.


## Credits


The protocol layer (`lib/codely.js`: credential chain, request signing, model roster, loopback endpoint) was recovered by reverse-engineering the Tuanjie Cowork client binary and live gateway traffic. The DSH seam (`lib/index.js`) follows the structure of [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) by corrinehu (MIT) — including the loopback-shim architecture, `PiAiAdapter` assembly and `ctx.llm.registerAdapter` registration; see the notes in that file and in [LICENSE](./LICENSE).


## License


[MIT](./LICENSE)
