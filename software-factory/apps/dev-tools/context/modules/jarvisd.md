# jarvisd — Jarvis Core (TypeScript on Bun)

## What it does

Jarvis daemon — the Bun-based runtime that replaces Node.js for the PA worker
and termhub front. TypeScript compiled and run via Bun. Boots the PA worker;
modules move to strict TypeScript one at a time. Runs the same termhub front
code as `bun ../jarvisd/src/main.ts front`.

## Language / Runtime

TypeScript on Bun (pinned version 1.4.4). Key dependencies: `typescript`, `bun`,
`@types/bun`.

## Platforms

Windows and Linux.

## Test command

```
cd jarvisd && npm test
```

Runs: `tsc -p .` (strict typecheck), `node scripts/parity.js` (PA test files
under Bun unchanged), `bun src/main.ts --check` (compiled executable smoke),
`node ../personal-assistant/test/supervisorBun.test.js`.

## Install / Deploy

- Built as part of the whole-stack install via `scripts/build.js --only jarvisd`
- The root `install.ps1` installs the pinned Bun and builds jarvisd
- CI runs the full test suite and verifies the compiled executable