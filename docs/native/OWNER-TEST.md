# Owner test: the last two boxes (Exit E, Exit 8)

About 30 minutes, on the work laptop. Everything runs on the new system: the PA as the compiled
jarvisd on SQLite, termhub's front on `jarvisd front`, terminals in ptyd, the factory natively.
Open termhub at http://127.0.0.1:7000/ (or its tailnet address); the top bar switches between
**Ask** (talk to Jarvis), **Plan** (the board), **Build** (factory jobs), **Run** (terminals),
**Meter** and **Map**.

Tick a step when it does what it says. Anything else: note what you saw and the time; the
lead agent turns it into an 8.4 item.

## Before you start (the lead checks these, you only look)

- [ ] The PA and termhub on both stacks serve `main`'s commit (`/api/version` on each).
- [ ] Map: every workflow's verdict is `pass` (whats-on, research, deepseek-pr, teams-ask,
  review-fix).

## 1. What's on (whats-on, Exit 8)

On **Ask**, press to talk and say "What's on today?".

- [ ] The answer starts speaking in under a second after you stop.
- [ ] It names only today's events, with their times; on a day with nothing left it says so.
- [ ] Meter shows no Claude spend for it (it is answered locally).

## 2. The golden path by voice (Exit E)

On **Ask**, say: "Start a factory job for dev-tools: add a `pa version` verb that prints the
served commit." Approve when Jarvis asks.

- [ ] Jarvis confirms within about a second of your yes, and names the card and the job.
- [ ] **Plan**: the card appears and moves to dispatched; open it: it links to the job.
- [ ] **Build**: the job shows its stages as they change (no refresh needed), with cost.
- [ ] **Run**: the steps' sessions appear; open the running one and watch the agent work.
- [ ] From the card, follow card -> job -> step -> session -> PR, and back from the PR.
- [ ] A draft PR opens on xvanov/dev-tools and its CI goes green (about 8-12 min in all).
- [ ] Close the PR unmerged (or ask Jarvis to); the card closes.

## 3. Research (Exit 8)

On **Ask**, say: "Research how termhub's Windows update handles a dirty working tree."

- [ ] A research job starts (Build) and its session shows in Run.
- [ ] Within a few minutes a report arrives (the card or Build links it): it answers the
  question, and its file:line citations hold when you open two of them.
- [ ] No PR is opened, and Meter shows $0 billed (it runs on the subscription).

## 4. DeepSeek PR (Exit 8)

On **Ask**, say: "With DeepSeek, start a factory job for dev-tools: <a small change>."

- [ ] The job runs its dev step on the API runtime and you can watch it in Run like a Claude
  session.
- [ ] A ready PR opens with green CI, nothing is merged, and the job's cost stays under $2.

## 5. A Teams ask (teams-ask, Exit 8)

Between 08:00 and 19:00 (outside those hours the toast waits for the digest), with Teams
running. In a PowerShell window:

```powershell
cd C:\repos\dev-tools\personal-assistant
node bin\pa.js e2e teams-ask --test-chat 48:notes
```

It prints one test phrase. Type it, exactly and as one message, into your chat with yourself.

- [ ] Within seconds the run reports the message stored, then distilled into a card.
- [ ] The card is on **Plan**, names you as the person asking, carries the due date the phrase
  implies, and its link opens the message in Teams.
- [ ] A notification pops up for the new ask.
- [ ] The run drops the test card at the end (delete the message in Teams if you like).

## 6. Terminals survive (the new system)

- [ ] In **Run**, start something long in a terminal (e.g. a `ping -t` loop). Ask the lead to
  restart sessiond: the terminal is still there afterwards, with its output.

When 1-5 pass, the lead ticks Exit E and Exit 8.
