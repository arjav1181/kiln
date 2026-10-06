# kiln

A Lovable-grade product shell for terminal coding agents. Single npm package, single
command, empty directory in and a working app out — on whatever stack the project uses.

```bash
npx @aj1181/kiln my-app
```

This is **M1**: a working vertical slice. The architecture and phasing live in `PLAN.md`;
M0's de-risking results are in `FINDINGS.md`, and what the product does today is in
`M1.md`.

## Layout

```
src/cli.ts         the single command
src/daemon/        session, dev server, preview proxy, history, HTTP + SSE
src/sdk/           session over the Claude agent SDK, events, tools, permissions
src/runtime/       stack-agnostic detection, port discovery, readiness, dependency install
src/proxy/         reverse proxy that injects the Kiln client and forwards HMR
src/capture/       CDP browser: navigation, evaluation, console, element inspection
src/provenance/    transform-time element ids for exact click-to-edit
src/injection/     the screenshot rationing policy
src/project/       git checkpoints and restore
ui/                React UI, built to ui/dist
test/fixtures/     real projects: Vite, Go, JSX
```

## Install

```bash
npx @aj1181/kiln my-app
```

Or globally: `npm i -g @aj1181/kiln && kiln my-app`.

## Probes

```
npm run probe              # all nine, ~15 min, ~$2 of model spend
npm run probe scaffold t0  # a subset
npm run typecheck
npm run build:ui
```

The model probes need credentials. `KILN_MODEL` chooses the model; without it they use
whatever the SDK defaults to.

| Probe | Checks |
|---|---|
| `session` | bidirectional session, streamed events, client-minted prompt uuids |
| `tools` | in-process MCP tools, permission gate, `ask_user` round trip |
| `resume` | **gate** — `resumeSessionAt` forks the conversation, files stay put |
| `runtime` | **gate** — detection, port discovery, injection on Node *and* Go |
| `t0` | **gate** — a click locates the source, with no file list or hints |
| `t1` | transform-time ids survive edits, rewrites, and HMR |
| `e2e` | daemon, preview, a real turn, a checkpoint, and a restore |
| `scaffold` | **empty directory → running preview, with no user action** |
| `image` | **the model reads a token out of a real screenshot** |

Probes stage their fixtures and poll for expected state, so they are order-independent
and leave the repository clean.

