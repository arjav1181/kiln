# M0 findings

The de-risking spike. Every claim in `PLAN.md` that could have sunk the project was
tested against a live agent, a real dev server, and a real browser.

Run with `npm run probe`. Six probes, ~7 minutes, roughly $1.50 of model spend.

```
PASS  session                  53.2s
PASS  tools-and-permissions   111.6s
PASS  resume                  174.0s
PASS  runtime-proxy              5.2s
PASS  t0-inspect              128.8s
PASS  provenance                5.9s
```

## Gates

| Gate | Question | Result |
|---|---|---|
| M0.5 | Does `resumeSessionAt` fork the conversation? | **PASS** |
| M0.7 | Does proxy instrumentation work on a non-Node stack? | **PASS** |
| M0.9 | Can the agent locate source from a click, on any stack? | **PASS** (1/1, Go) |

### M0.5 — rollback composes cleanly

With `one.txt` and `two.txt` on disk, resuming at turn 1's prompt uuid made the agent
report `one.txt` as the most recent request: turn 2 was gone from the conversation.
The files were untouched.

```
turn 3 (resumed)  A) one.txt   B) one.txt two.txt
files after resume  ["one.txt","two.txt"]
```

So rollback is genuinely two independent halves, and both are owned by us:
`resumeSessionAt` forks the *conversation*, a git reset restores the *files*.

### M0.7 — "any stack" is now evidence

Client injection into `<head>`, verified through the proxy:

```
node  <head><script src=".../client.js" defer></script> <script type="module" s
go    <head><script src=".../client.js" defer></script> <meta charset="utf-8">
```

Two ecosystems, one contract, and the project is never modified on disk.

### M0.9 — T0 works on the hardest stack

Given only what a click yields — tag, attributes, accessible name, DOM path, rect —
the agent named `main.go:18` exactly. No file list, no source hints, on Go.

`n=1` is a demo, not a rate. The T2 roadmap should be set from a wider sample measured
in M1, not from this.

## Defects found and fixed

Each of these was a real bug, found by a probe rather than by reasoning.

1. **The SDK withholds `init` until the first input arrives.** `send()` originally
   awaited readiness and deadlocked. Never gate a send on session readiness in
   streaming-input mode.
2. **Our own tools route through the permission gate.** They surface as
   `mcp__kiln__preview_state`. The daemon must auto-allow the `mcp__kiln__` namespace
   or the user is prompted for every screenshot.
3. **WebSocket upgrade was silently malformed.** `rawHeaders` is a flat
   `[name, value, ...]` array; joining it with `\r\n` put names and values on separate
   lines. HMR was completely dead through the proxy and the failure was invisible —
   the page rendered, the module re-transformed on request, and only the live update
   was missing. **This is the defect that would have made the product feel broken
   while every test still passed.**
4. **Provenance must run before `vite:esbuild`.** Otherwise JSX is already
   `React.createElement(...)` and there is nothing to parse. `enforce: 'pre'`.
5. **Position-only element ids collide after a rewrite.** A different element landing
   on the same line and column produced the same id, silently re-pointing a user's
   selection at it. Ids now fold in tag and attributes.
6. **Dev-server port discovery is harder than it looks.** Three separate problems:
   ANSI colour codes land *inside* the announced URL; Go announces a bare
   `127.0.0.1:5277` with no scheme; and the first implementation read the announced
   port before the process had printed anything. Guessed ports are now only tried
   after a grace period, so the preview cannot latch onto an unrelated service on 3000.
7. **Dev servers spawn children.** Killing `npm` left `vite` holding the port.
   Spawn detached and signal the process group.
8. **Upgraded sockets need error handlers and close tracking.** An abrupt browser
   teardown produced an unhandled `ECONNRESET` that killed the process, and
   `close()` left sockets holding the port.
9. **Non-atomic index writes.** A reader polling `provenance.json` caught a
   half-written file. Write to a temp file and rename.

## What this changes in the plan

- **M0.6 is now genuinely green.** HMR survives the proxy, and the preview is
  same-origin, so the overlay client needs no postMessage handshake or CORS handling.
- **T0 is not a fallback.** It located the source exactly on Go. T1 remains a
  precision upgrade for the JSX family, not a prerequisite.
- **The permission policy needs a namespace rule.** Auto-allow `mcp__kiln__`, prompt
  for everything else, and surface `title`/`description`/`canRemember` in the UI.
- **The provenance index needs a real channel.** The plugin runs in the dev-server
  child process, so the daemon cannot read it in memory. A file works for M0; the
  product should use a unix socket so the daemon is not polling the filesystem.

## Not verified

- **Image injection.** `preview_screenshot` returns an MCP image block, but no probe
  confirmed the model receives it as an image. Standard MCP, low risk, still unproven.
- **T0 hit rate as a rate.** One sample, one stack.
- **Backend parity.** Only the Claude SDK backend exists. ACP and opencode adapters
  are untested; codex was not installed in this environment.
- **Only the default model was routable here.** Explicit model ids were rejected by
  the configured provider, so probes ran on it at roughly $0.07–0.20 per trivial turn.
  The `model` option is wired and env-overridable via `KILN_PROBE_MODEL`.
- **Multi-user and long-session behaviour.** Every probe was a short, single-operator
  run.
