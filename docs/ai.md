# The AI assistant

The assistant answers questions about the cluster with the cluster's actual state
in front of it. It lives in a separate service, `zer0space-ai`, and this
dashboard is the only door into it.

## Why it is a separate service

Three reasons, in order of how much they mattered:

1. **This dashboard cannot scale, and the assistant should.** The dashboard is
   pinned to `replicas: 1` because its session store holds per-user vault keys in
   process memory. The AI service holds nothing, so it runs `replicas: 2` and
   more when somebody needs it.
2. **A streaming answer occupies a worker for as long as the model keeps
   talking.** In a single-replica dashboard, two people chatting would make the
   rest of the UI feel broken.
3. **Blast radius.** The AI service has no Docker socket, no `/data` mount, no
   session store and no write path into any table this repo owns.

## Request path

```
browser
  │  session cookie, CSRF token
  ▼
dashboard  /api/ai/*            src/ai.py
  │  1. _require_session (or _require_admin)
  │  2. builds the cluster snapshot from metrics.py
  │  3. forwards with the shared token + identity headers
  ▼
zer0space-ai  /api/*
  ▼
Anthropic | OpenAI | Gemini | Ollama
```

`POST /api/ai/chat` answers `text/event-stream` and the dashboard relays it
untouched, so both sides speak one protocol.

## The trust boundary

The AI service **does not authenticate users**. It checks a shared token and
trusts three headers this dashboard sets from the server-side session:

```
x-zer0space-ai-token    the shared secret
x-zer0space-user-id     from session["user_id"]
x-zer0space-user-name   from session["username"]
x-zer0space-user-role   from session["role"]
```

The identity comes from the session, never from anything the browser sent, which
is what makes it safe for the AI service to treat those headers as authoritative.

**This holds only while the AI service is unreachable from anywhere but here.**
It publishes no ports and sits on `dashboard_net`. Giving it a published port or
a tunnel route does not merely expose a service: it makes the identity headers
attacker-supplied, and anyone can then claim to be an admin. If it ever needs to
be reachable from elsewhere, it needs to verify sessions itself.

## Configuration lives in the database

`AI_SERVICE_URL` is the only AI setting in the environment, and it is an address,
not a preference. Everything else (provider, model, API keys, system prompt,
history window, context toggles) is a row in PostgreSQL that an admin edits under
**Settings → AI**.

That is the point of the design: switching from Claude to a local Ollama model is
a dropdown, not an edit to `docker-compose.yml` followed by a stack redeploy.

**Do not add an `AI_MODEL` or `ANTHROPIC_API_KEY` variable.** If a setting is
product configuration, it belongs in the document.

### The two shared secrets

`ai_service_token` and `ai_enc_key` both resolve as: Swarm secret file, then
environment variable, then a row in `settings`, then generated and stored.

The database fallback is why a first deploy needs no setup: both services read
the same row and therefore agree. Creating real Swarm secrets is still better,
because then the values never land in the database. Both are commented out in
`docker-compose.yml` by default, because a Swarm stack fails to deploy if it
references an external secret that does not exist.

A value that arrived from a secret or an env var is **never written back**. A
stale auto-generated row would otherwise clobber the real, restart-surviving
value on the next boot, and for `ai_enc_key` that means every stored provider key
silently stops decrypting.

## The cluster snapshot

`_ai_context_bundle()` in `main.py` builds it: the status tiles, Swarm state,
per-host metrics, backup status and the service catalogue. Same data as
`/api/overview`, plus the catalogue.

It is built **server-side and not accepted from the browser**. The client already
has most of it on screen, so taking it from the request would be cheaper, but it
would also mean the model's view of the cluster is whatever the client claimed.

Every part is best effort: a failed poll means one section of the prompt says "no
data", which is far better than the chat box refusing to answer because Glances
timed out on one host.

**This costs latency.** `metrics.collect()` polls every host, so the first token
of an answer arrives a beat later than it otherwise would. That was the accepted
trade for the assistant and the tiles never disagreeing.

## Account deletion

`DELETE /api/users/{id}` calls `ai.purge_user()` after its transaction commits.

The AI service's `ai_conversations` table deliberately has **no foreign key** to
`users(id)`. One would look tidier and would turn `DELETE FROM users` into a
constraint violation raised by a table this repo has never heard of, so deleting
an account would start failing for reasons invisible from this codebase.

The call is best effort: the account is already gone by then, and failing the
whole request because a chat service is down would be the wrong trade. Anything
missed is swept up by the AI service's retention prune.

## Turning it off

Blank `AI_SERVICE_URL`. The chat panel and the AI settings tab are not rendered
at all (`ai_enabled` in the template), `ai.js` is not loaded, and `/api/ai/*`
answers 503. The AI-category service tiles are unaffected.

## Frontend notes

`static/js/ai.js` defines `window.ZS_AI` and is loaded only when the gateway is
wired. `app.js` calls into it in three places: `openView()` when the AI view
opens, `openSettings()` when the AI settings tab opens, and `render()` on
`languagechange:zs`.

Two conventions from the rest of the frontend apply and are easy to miss:

- Everything reaching `innerHTML` goes through `ZS_UI.esc()`. Chat content is
  model output and conversation titles are user input. `format()` escapes the
  whole string **first** and only then turns three markdown patterns back into
  markup, so no amount of HTML in an answer can escape into the page.
- Markup built in JS carries no `data-i18n` attributes, so `applyI18n()` cannot
  reach it. `ZS_AI.render()` redraws those parts on a language switch.

The stream is read with `fetch` plus a `ReadableStream` rather than
`EventSource`, because `EventSource` can only issue GET requests and cannot send
the CSRF header.

## What the assistant cannot do

Every tool it has is read-only and answers from the snapshot it was given. It
cannot restart a service, edit a tile, read the vault or reach the Docker socket.
The vault is never included in a prompt in any configuration.

With a cloud provider configured, the enabled context sections do leave the
network: hostnames, addresses, metrics, backup status and the service catalogue.
The toggles are individually switchable for exactly that reason, and the Local
LLM provider exists so none of it has to.
