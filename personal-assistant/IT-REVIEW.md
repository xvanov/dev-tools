# For IT review

A one-page answer to "what is this, and what is it allowed to do". Written to be pasted into a
ticket or an email.

---

## What is being asked for

A **Microsoft Entra app registration**, single tenant, with four **delegated** Microsoft Graph
permissions:

| Permission | Grants | Admin consent required |
|---|---|---|
| `Mail.Read` | read the signed-in user's own mail | No |
| `Calendars.Read` | read the signed-in user's own calendar | No |
| `Chat.Read` | read the signed-in user's own 1:1 and group chats | No |
| `User.Read` | read the signed-in user's own profile | No |

No application permissions. No `.All` scopes. No write access. No send.

## What it is

A personal productivity tool that reads the requester's own mail, calendar, Teams chats and
GitLab activity, extracts the commitments buried in them ("who asked me for what, by when"), and
uses that context to brief AI coding sessions the requester runs on their own workstation. It
replaces the manual step of re-typing context into a coding tool a dozen times a day.

It is a single-user tool on a single managed workstation. It is not a service, it has no
server component, it has no service account, and no other person's data passes through it.

## Cost

**The app registration is free.** Entra app registrations carry no licence cost on any tier,
including Free. There is no per-app or per-token charge for delegated user sign-in. Nothing
about this consumes an Azure subscription, a Power Platform licence, or a Workload Identities
entitlement (that billing applies to service principals authenticating as themselves, which this
does not do).

Costs that exist are outside the tenant and paid personally by the requester: an Anthropic API
key for the text-extraction step, and nothing else. The database is Postgres on the workstation.

## Scope — how it is provably limited to one user

**Delegated permissions cannot reach another user's data.** A delegated token authorises the app
to act *as the signed-in user*, and Graph enforces that at the API: every call the tool makes is
against `/me`. `Mail.Read` delegated is not `Mail.Read.All`; there is no code path, and no API
surface, by which it could enumerate or read another mailbox. If the requester cannot see
something in Outlook, neither can this.

Three further controls, all available to you and none requiring anything from the requester:

1. **Single tenant.** Only accounts in this directory can sign in to the app at all.
2. **Assignment required.** In *Enterprise applications → (this app) → Properties*, set
   **Assignment required = Yes** and assign only the requester. Nobody else in the tenant can
   obtain a token for it, even knowing the client ID. This is the control that turns "scoped to
   one user by convention" into "scoped to one user by configuration".
3. **Public client, no secret.** The registration has no client secret and no certificate.
   There is no credential that could be stolen and replayed to obtain data without an
   interactive sign-in by the requester.

## Your existing controls all still apply

- **Conditional Access** applies to the sign-in — device compliance, MFA, location, session
  lifetime. Nothing here bypasses it.
- **Sign-in logs** record every token issuance, attributed to the user and the named app. It is
  visible in the same reports as any other app.
- **Revocation is one click.** *Enterprise applications → (this app) → Permissions → Revoke*, or
  delete the service principal, or set *Enabled for users to sign in = No*. Access stops
  immediately at the next token refresh, and within an hour on the existing token.
- **Offboarding is automatic.** If the account is disabled, the refresh token stops working.
  There is no standing credential to remember to clean up.
- **Mailbox auditing** continues to record access where your licensing includes it.

## Where the data goes

**Stays on the workstation:** everything captured — mail, calendar entries, chat messages,
GitLab items — is stored in a Postgres database on the requester's managed laptop. It binds to
loopback only, is not reachable from the network or the tailnet, and is on a BitLocker-encrypted
volume. There is no cloud index, no third-party sync, and no server anyone else can reach.

**Leaves the workstation:** the extraction step sends the text of a captured item to a large
language model to identify commitments. **This is the part of the design that deserves your
scrutiny, and it is the only egress.** Three options, and the requester can be directed to any
of them:

| Option | Where message text goes | Notes |
|---|---|---|
| Anthropic API *(current default)* | Anthropic's API | Not used for model training. Retention terms vary by model and agreement — worth confirming against your data-processing requirements. |
| **Claude on Microsoft Foundry** | Your own Azure tenant | Billed through Microsoft Marketplace, under your existing Microsoft data-processing agreement. **Recommended if the egress is the blocker** — the text never leaves the Microsoft boundary you already accept. |
| Azure OpenAI in your tenant | Your own Azure tenant | Same boundary argument; the tool already supports an Azure endpoint for search embeddings. |

Ask for whichever of these you are comfortable with; the change is configuration, not
architecture.

## What it will not do

- **It never sends anything.** Drafting a reply and sending it are separate acts; sending is a
  command a human types, at an interactive confirmation prompt, and no automated path, scheduled
  task or AI agent can reach it. The default token does not even carry `Mail.Send` or
  `ChatMessage.Send` — read scopes only.
- **It does not read team channels.** `ChannelMessage.Read.All` requires admin consent and is
  deliberately not requested. Only the requester's own 1:1 and group chats.
- **It does not touch Teams meeting recordings or transcripts through Graph.** Those need
  application permissions and an Application Access Policy; not requested, not used.
- **It does not act on other people's behalf, ever.** No service principal, no app-only token,
  no impersonation.

## Two things worth raising yourselves

Stated here rather than left to be discovered:

1. **A searchable local copy of mail and chat is a new data surface on an endpoint.** It is
   encrypted at rest and loopback-only, raw message bodies age out after 180 days by default,
   and the retention window is configurable. But if your DLP or insider-risk posture has a view
   on local caches of mailbox content, this is that.

2. **The tool can record meeting audio locally**, for the requester's own meetings, using the
   workstation's microphone and speaker output. This uses no Microsoft API and is outside
   anything Entra controls — it is a policy question, not a permissions one. Recording of
   colleagues may be subject to state law and to company policy, and the practical answer is
   that the requester tells participants they record. Flag it if your policy has a position;
   the feature can be disabled outright with one setting.

## Summary for the approver

Read-only, delegated, single-tenant, one named user, no secret, no send, revocable in one click,
free. The one substantive question is whether message text may be processed by an external LLM,
and there is a supported configuration that keeps it inside your own Azure tenant if the answer
is no.
