# `test/mobile` — driving the UI on a phone-shaped browser

Every mobile bug termhub has had was reported as prose and fixed by guessing:
*"scrolling is weird"*, *"the input bar disappears"*, *"I can't copy anything"*. A guess costs a
round-trip to a real phone to disprove, and a phone has no console. This harness exists so the
numbers come from somewhere closer than that.

```bash
# Playwright is NOT a termhub dependency — the tool ships to phones and Windows
# boxes and has no business carrying a browser download. Install it anywhere:
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm install playwright

cd termhub
TERMHUB_PLAYWRIGHT=/tmp/pw/node_modules/playwright node test/mobile/probe.js
node test/mobile/probe.js --agent=claude      # measure a live Claude Code session
node test/mobile/probe.js --agent=opencode
node test/mobile/probe.js --browser=webkit --headed --keep
```

The probe changes nothing and asserts nothing — it's the counterpart to `watchdog/watchdog.sh
--probe`: a diagnosis you read. It boots a throwaway termhub on ports **7180/7190** with its own
data dir, so it can never touch the real deployment's `sessions.json` or the live terminals on
this machine.

## What it can see

- **Layout geometry** — what is off-screen and by how much. `screen bottom vs keybar top` is the
  number behind "I can't get to the bottom".
- **Scroll state** — `viewportY`, `scrollTop`, buffer length, before and after a real synthesised
  one-finger drag. Answers "did that gesture scroll anything at all".
- **Which renderer is live**, and therefore whether there is any text in the DOM to select.
- **What the running agent actually emitted** — alternate-screen and mouse-tracking modes, which
  is what decides how a drag has to be handled (see below).
- **Whether an affordance is reachable** — present in the DOM *and* inside the viewport. A key
  parked off the right-hand edge of a scrolling group may as well not exist, and that is exactly
  what was wrong with `⌨`.

## What it cannot see — where a real device is still the only authority

- **The iOS soft keyboard.** Chromium has no on-screen keyboard, so `visualViewport` never shrinks
  on its own. `simulateKeyboard()` stages the *geometry* by redefining `visualViewport.height` and
  firing the events iOS fires. That reproduces what the layout does, never what Safari does.
- **`env(safe-area-*)`** insets — Playwright doesn't emulate the notch or the home indicator.
- **Safari's clipboard permission prompt**, which iOS raises on every single read.
- **`-webkit-overflow-scrolling: touch` momentum**, and how far the canvas repaint lags behind a
  compositor-driven fling. This is the one that matters most: it's the suspected mechanism behind
  "the top half stays static", and it is precisely what neither Chromium nor a Linux WebKit
  reproduces faithfully.

**Treat a pass here as "the structural bug is gone", never as "verified on iOS."**

## WebKit

Chromium is the default because it's already downloaded on most machines. WebKit is the engine iOS
actually runs and is worth the one extra system package when a rendering question is in play:

```bash
sudo apt-get install libavif16
npx playwright install webkit
node test/mobile/probe.js --browser=webkit
```

Linux WebKit is still not iOS Safari — no soft keyboard, different compositor — but it shares the
engine core, so CSS and selection behaviour land much closer.

## The three scroll regimes (why this matters)

Measured with `probe.js`, not assumed. What an agent emits decides how a drag has to be handled,
and the three cases need three different answers:

| | alternate screen | mouse tracking | a drag must |
|---|---|---|---|
| **Claude Code** | no — normal buffer | **none** (explicitly disables 1000/1002/1003/1006) | scroll xterm's own scrollback |
| **opencode** | **yes** (`?1049h`) | `?1003h` + `?1006h` | be forwarded as SGR wheel events |
| plain shell | no | none | scroll xterm's own scrollback |

The surprise is Claude Code: it looks like a full-screen TUI and isn't one. It never grabs the
mouse, so the wheel-forwarding path termhub built for full-screen apps was never active in a Claude
session — which is why "scrolling is broken in Claude" and "scrolling is fine in vim" were true at
the same time.

## `window.__termhub`

The page exposes `{state, voice, rec, openTerminal, refitActive, appWantsMouse, isMobile}` at the
end of `web/app.js`. The harness drives the real UI through that rather than through selectors that
break for reasons unrelated to the thing being measured, and it's the only way to ask the page
questions — *"how many rows does xterm think it has?"* — that no amount of screenshotting answers.

`app.js` is a classic script, so its `function` declarations land on `window` but its `const state`
does **not**. Reaching for `window.state` yields `undefined` and any wait on it times out saying
nothing useful; go through `window.__termhub`.
