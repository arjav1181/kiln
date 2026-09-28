# kiln

A Lovable-grade product shell for terminal coding agents. Single npm package, single
command, empty directory in and a working app out — on whatever stack the project uses.

This repo is at **M0**: the de-risking spike. The architecture and phasing live in
`PLAN.md`; what was actually verified, and what broke, is in `FINDINGS.md`.

## Layout

```
src/sdk/         session over @anthropic-ai/claude-agent-sdk, normalised event bus,
                 in-process MCP tools, host-owned permission gate
src/runtime/     stack-agnostic dev-server detection, port discovery, readiness
src/proxy/       reverse proxy that injects the Kiln client and forwards HMR
src/capture/     CDP browser: navigation, evaluation, console capture
src/provenance/  transform-time element ids for exact click-to-edit
src/probe/       the spike, as runnable checks
test/fixtures/   real projects: Vite, Go, JSX
```

## Probes

```
npm run probe              # all six, ~7 min, ~$1.50 of model spend
npm run probe resume t0    # a subset
npm run typecheck
```

The model probes need credentials. `KILN_PROBE_MODEL` overrides the model id; without
it the probes use whatever the SDK defaults to.

| Probe | Checks |
|---|---|
| `session` | bidirectional session, streamed events, client-minted prompt uuids |
| `tools` | in-process MCP tools, permission gate, `ask_user` round trip |
| `resume` | **gate** — `resumeSessionAt` forks the conversation, files stay put |
| `runtime` | **gate** — detection, port discovery, injection on Node *and* Go |
| `t0` | **gate** — a click locates the source, with no file list or hints |
| `t1` | transform-time ids survive edits, rewrites, and HMR |

Probes stage their fixtures and poll for expected state, so they are order-independent
and leave the repository clean.
