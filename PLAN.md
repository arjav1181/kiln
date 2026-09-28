# Kiln — a Lovable-grade product shell for terminal coding agents

> Codename `kiln` (name TBD). Single npm package, single command, empty dir in → working app out.
> **Any stack.** No fixed framework.
>
> M0 (the de-risking spike) is complete — 6/6 probes pass. See `FINDINGS.md`.

---

## 1. Thesis

Claude Code, Codex, and opencode are excellent **coders**. They are not **products**. Everything
that makes Lovable feel like Lovable is the shell around the coder: a live preview, eyes on the
screen, checkpoints, a click-to-edit surface, git, publishing.

So: **do not rebuild the agent loop. Borrow the best one, and own the shell.**

`@anthropic-ai/claude-agent-sdk` (v0.3.283) is Claude Code's *own* harness exposed as a typed,
in-process API. That means we get the real loop — its context management, compaction, tool
discipline, subagents, model routing — while owning:

- the **tools** (in-process MCP server, `source: 'sdk'`, zero subprocess)
- the **permission gate** (`canUseTool` → our own UI)
- the **clarifying questions** (`AskUserQuestion` is a first-class built-in tool)
- the **verbosity** (30 hook events, `includePartialMessages`, `MessageDisplay`)
- the **history** (git) and the **rollback** (`resumeSessionAt` = "revert to this message")

This is the "native feel" the brief asked for, without the trap of shelling out and parsing stdout.

### Stack-agnostic by construction

The native agents are language-agnostic, and so is this. Critically, **most of the product is
already stack-agnostic** — git checkpoints, rollback, the capture loop, GitHub sync, and publish
care nothing about the framework. Only *provenance* is language-bound, and that becomes a
**tiered, pluggable adapter** rather than a blocker. See §4.

---

## 2. Verified substrate (checked 2026-09-28, not assumed)

| Fact | Source |
|---|---|
| `canUseTool(toolName, input, {signal, suggestions, blockedPath})` — own the permission gate | `sdk.d.ts:213, 1586` |
| `permissionPromptToolName` — route permission prompts through *our* MCP tool | `sdk.d.ts:2008` |
| `permissionPrompts: 'host' \| 'none'` | `sdk.d.ts:2013` |
| `createSdkMcpServer({name, tools})` — in-process tools, no transport | `sdk.d.ts:608` |
| `AskUserQuestion` built-in tool (Input/Output typed) | `sdk-tools.d.ts:1102, 3749` |
| `resumeSessionAt: uuid` — resume from a specific prompt = chat rollback | `sdk.d.ts:2098` |
| `forkSession`, `resume`, `interrupt`, `includePartialMessages` | `sdk.d.ts:1706, 2084, 1790, 1859` |
| 30 hooks incl. `PreToolUse`/`PostToolUse`/`PermissionRequest`/`PreCompact`/`SubagentStart` | `sdk.d.ts:956` |
| Cost + thinking-token telemetry per turn (`costUSD`) | `sdk.d.ts:1451` |
| `ApiKeySource` includes `'oauth'` → **users can use their Claude subscription**, not just an API key | `sdk.d.ts:131` |
| `EffortLevel: low…max` | `sdk.d.ts:688` |
| `claude 2.1.251` supports `--input-format stream-json` (bidirectional), `--include-partial-messages`, `--include-hook-events`, `--mcp-config`, `--strict-mcp-config` | `claude --help` |
| ⚠️ `--permission-prompt-tool` **does not exist** in 2.1.251 — superseded by the SDK's `permissionPromptToolName` / `canUseTool` | `claude --help` |
| `opencode serve` (headless HTTP), `opencode acp` (**Agent Client Protocol**), `--session`, `--fork`, `export/import`, plugins, MCP | `opencode --help` 1.18.33 |
| `codex` not installed in this env — validate the adapter later, not a v1 blocker | `command -v codex` |

**Strategic read:** ACP is a vendor-neutral agent protocol. opencode implements it, and
`@zed-industries/claude-code-acp` exists. So *one* ACP client adapter can eventually cover
Codex/Gemini/others. Build the adapter interface now; ship the Claude SDK backend first.

---

## 3. Architecture

```
npx kiln my-app
  │
  ├─ bin/CLI ── parse args, create/resolve project, allocate port, open browser
  │
  └─ daemon ── one Node process, HTTP + WebSocket
       │
       ├─ session/ ── normalized event bus
       │     message.delta · thinking · tool.start · tool.result · permission.request
       │     question.ask · cost · checkpoint · error
       │     backends:  claude-sdk (v1) | acp (v1.1) | opencode (v2)
       │
       ├─ tools/ ── in-process MCP server, name "kiln"
       │     capture_screenshot   read_console      inspect_element
       │     ask_user             preview_state     db.* (v4)
       │
       ├─ permission/ ── canUseTool → rich UI prompt, per-tool allowlist,
       │                   "always allow", auto-approve reads, audit log
       │
       ├─ project/ ── git as history: refs/heads/kiln/<app>
       │     checkpoint = { promptUuid, ts, cost, files[], diffStat }
       │     rollback  = resume(session, resumeSessionAt) + git reset
       │
       ├─ runtime/ ── STACK-AGNOSTIC dev server manager (§4.1)
       │              detect · spawn · discover port · await readiness · PROXY
       │
       ├─ proxy/ ── the instrumentation trick (§4.2)
       │     daemon proxies the dev server and injects our client on the fly,
       │     so the preview is same-origin and needs no project modification
       │
       ├─ provenance/ ── tiered, pluggable (§4.3). T0 works on ANY stack.
       │
       ├─ capture/ ── CDP client: screenshot · console · page errors ·
       │              network failures · a11y snapshot
       │
       ├─ github/ ── gh + git: connect · commit per turn · push · PR
       │
       └─ ui/ ── React + Vite, bundled as static assets inside the package
             chat + thinking + tool timeline + cost
             live preview iframe (same-origin, injected client)
             visual editor overlay
             version timeline / restore
             permission + question modals
```

### `.kiln/` layout (in the project)

```
.kiln/
  config.json         dev command override, backend, model, ports
  checkpoints/*.json  one per turn
  artifacts/<uuid>/   screenshot.png, console.json, network.json
  provenance/         content-hashed id → source index snapshots (T1+ only)
```

Git: `refs/heads/kiln/<app>` is the working branch. The user's `main` is untouched until they
connect a repo or publish.

---

## 4. Stack-agnostic strategy — the load-bearing design

Three separate concerns, three different levels of stack-binding. Conflating them is the mistake.

### 4.1 Universal: the dev-server contract

Any project that can serve HTTP fits this contract, regardless of language:

1. **Dev command** — autodetect from a marker table, or user override in `.kiln/config.json`.
   Autodetect priority: `package.json` scripts.dev/start (npm/bun/pnpm/yarn) · `deno.json` tasks ·
   `manage.py` · `composer.json` (artisan/symfony) · `mix.exs` (phx.server) · `Cargo.toml` ·
   `go.mod` · `requirements.txt`/`pyproject.toml` (fastapi/flask/django/uvicorn) ·
   `docker-compose.yml` · plain static directory with an `index.html` → just serve the files.
   **Unknown stack is fine:** the user types the command. That is the escape hatch that makes
   "any stack" true rather than aspirational.
2. **Port discovery** — (a) parse stdout for a `localhost:PORT` URL (most dev servers announce
   themselves) → (b) a `kiln.config` manifest → (c) probe a small candidate list → (d) ask in the UI.
3. **Readiness** — poll the candidate URL until it answers. Never `sleep()`. This is where projects
   lose a day if done badly; it is not optional to do well.
4. **Proxy** — daemon serves the preview on its own origin and reverse-proxies to the real port.

**Honest v1 boundary:** the *preview* requires a stack that serves HTTP. A Rails app, Django,
FastAPI, Go, Rust, a Vite SPA, a static site, Rails-on-whatever — all fine. A CLI, a library, or a
native mobile app still gets the full chat/git/GitHub/checkpoint experience, just with no live
preview. Say this plainly in the docs rather than pretending.

### 4.2 Universal: instrument by proxying, not by modifying the project

The daemon proxies the dev server's responses and, on HTML, injects our overlay client into
`<head>` on the fly. Consequences:

- the preview is **same-origin** → the client can call the daemon directly, no CORS, no
  postMessage handshake, no `csp`/`X-Frame-Options` fights
- we **never modify the generated project** to instrument it → works on Laravel, Rails, Django,
  a Go server, anything, and the project keeps working after the user leaves Kiln
- re-injection is free on every reload, so it survives HMR, full restarts, and server-side
  template re-renders

This is what makes T0 provenance possible on any stack, and it is why the design is honest about
"any stack" rather than aspirational.

### 4.3 Tiered provenance

| Tier | Mechanism | Stacks | Cost | Ships |
|---|---|---|---|---|
| **T0** | Click → capture DOM subtree + a11y node + page HTML + candidate file list → the **agent** locates the source. No compiler involvement. | **everything** | low | **M1** |
| **T1** | Vite/webpack plugin parses the source, injects a stable id per host element, records `id → (file, line, attr expression)` in a content-hashed index | JSX/TSX: React, Next, Vue, Svelte, Solid, Astro | medium | **M2** |
| **T2** | Per-language source adapters (Blade, Twig, ERB, Django/Jinja, Go html/template, Rails ERB…) | one family at a time | low each, never-ending | M3+ |

T0 is imprecise but genuinely useful and **unblocks "any stack" from day one** — the agent is
good at finding `id="submit-btn"` in a `.erb` file; it just costs a couple of tool calls instead of
one lookup. T1 is an *upgrade* for the JSX family, not a prerequisite. T2 is a maintenance treadmill
we accept, and the adapter interface is the actual IP.

Instrument the hit rate of T0 (did the agent edit the right file?) so T2 investment is data-driven
rather than a vibe.

---

## 5. The visual loop (the feature that justifies the product)

1. User prompts. We snapshot → git checkpoint.
2. `query()` streams events to the UI (thinking, tool calls, diffs, cost).
3. Agent edits files → the dev server reloads → our proxy injects the client → preview updates.
4. On turn end (or on failure), the daemon captures screenshot + console + network errors and
   files them as turn artifacts.
5. Next turn, we inject an image block + a text block of new errors as user-message context.
6. Agent fixes. Repeat.

### Injection policy — the #1 quality risk

Never screenshot blindly every turn. It floods context, costs tokens, and *degrades* output.
Inject only when it would change what the agent does:

- always on: tool failure, test/build failure, or a turn that ended after edits with no visual check
- on demand: user clicks "show agent", visual-editor edit, `@screenshot`, agent asks to see it
- suppressed when: the screenshot hash matches the previous one (nothing changed on screen)
- downscaled, budgeted; a rolling window of the last N artifacts only

This policy must be an explicit, tested module — not an emergent behavior.

---

## 6. Phasing

### M0 — De-risk spike. **DONE — 6/6 pass.**

Three gates, all green: `resumeSessionAt` forks the conversation (files stay put, so git
owns file rollback); proxy instrumentation works on both Vite and Go; and T0 located
`main.go:18` exactly from a click on a Go page. Nine real defects were found along the
way, including a malformed WebSocket handshake that left HMR silently dead while every
other test still passed. Full detail in `FINDINGS.md`.

What M0 bought us, beyond confidence:

- HMR survives the proxy, and the preview is same-origin — the overlay client needs no
  postMessage handshake and no CORS handling.
- T0 is a working provenance tier on day one, not a fallback.
- The permission policy needs an explicit `mcp__kiln__` auto-allow rule.

### M1 — "blind agent gets eyes" (the MVP that justifies the product)
CLI + daemon · session layer (claude-sdk backend only) · git checkpoints + rollback ·
stack-agnostic runtime manager + readiness + proxy · preview iframe · capture + injection policy ·
**T0 click-to-inspect** · UI: chat, streaming, tool timeline, cost, version timeline, permission
modal. Ship: `npx kiln my-app` → prompt → working preview in under 60s, any stack.

### M2 — Exact click-to-edit (T1, JSX family)
Provenance plugin + overlay + `inspect_element` + visual editor panel. Property edits become
structured instructions ("`Button.tsx:42` → `variant: 'destructive'`"), not vague prose.

### M3 — Ship it
GitHub connect · commit per turn · push · PR via `gh` · publish adapters (static / Docker /
Fly / Vercel) · T2 provenance adapters, ordered by demand.

### M4 — Lovable parity
Local Postgres + auth emulator, schema editor, seed data, RLS · knowledge/context documents ·
Figma import · mobile toggle · deploy analytics · templates & fork · voice input.

---

## 7. Risks, ranked

M0 retired or reshaped several of these. The remainder, in order.

1. **Context flood from the visual loop.** See §5. Unchanged by M0, still the biggest
   quality risk. Mitigation is policy, not more cleverness.
2. **T0 provenance hit rate.** Now *measured* at 1/1 on the hardest stack rather than
   guessed. Still n=1. Instrument it properly in M1 and let the number set the T2
   roadmap.
3. **Dev-server discovery across ecosystems.** M0 hit three distinct failure modes
   (colour codes inside URLs, scheme-less announcements, a read-before-announce race).
   More will appear. The escape hatch — the user types the command — is what keeps this
   from being bottomless, so build the override UI early, not as a fallback.
4. **SDK surface drift.** `@anthropic-ai/claude-agent-sdk` is `0.3.x`, pre-1.0. Pinned
   exactly, and the adapter layer keeps the blast radius to one file. **Do not collapse
   that layer.**
5. **The provenance index channel.** The plugin runs in the dev-server child process, so
   the daemon cannot read the index in memory. M0 used a file with atomic writes; M1
   should use a unix socket so the daemon is not polling the filesystem.
6. **Backend parity.** Claude SDK ≫ ACP ≫ opencode ≫ codex. Ship *one* backend
   excellently; expose the rest as best-effort. Never advertise parity you don't have.
7. **"Any stack" scope creep.** T2 is an infinite treadmill. The discipline that saves
   us: T0 for everything, T1 for the JSX family, T2 languages only against demand.
8. **Unverified: image injection.** No probe confirmed the model receives an MCP image
   block as an image. Standard MCP, but the visual loop depends on it and it is
   untested. Verify early in M1.

---

## 8. Open decisions

- **Name.** TBD, as agreed.
- **Auth path.** The SDK reads OAuth, so subscription users work. Also support plain API keys.
  Decide which is the default prompt on first run.
- **Provenance plugin distribution.** T1 must ship as a real devDependency written into the
  generated project at init — or the project breaks the moment the user leaves Kiln. T0 and the
  proxy instrumentation need nothing in the project at all.
