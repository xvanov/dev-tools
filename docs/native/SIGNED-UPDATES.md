# Signed self-update

Plan item 7.4. Before `personal-assistant/src/supervisor/deploy.js` rolls to commits it pulled, it
checks that every one of them carries a good SSH signature from a key you trust. A machine that
deploys by `git pull` would otherwise run whatever lands on `main`.

## What it does today

- `deploy.js --pull` runs `git fetch`, checks the signatures of `HEAD..@{u}`, and only then
  `git merge --ff-only`: an unsigned commit is never checked out by the deploy.
- When termhub's updater already pulled (`deploy.js --from <commit>`), the same check runs on
  `<commit>..HEAD`. The checkout has moved, so the most it can do is refuse to roll: exit code 1,
  nothing rolled, the previous generation keeps serving.
- A commit passes only with git's `%G?` status `G`: a good signature from a key listed in the
  trusted-signers file. Not signed, a bad or expired signature, and a valid signature from a key not
  on the list all refuse.

## Enforcement is off until you create the trusted-signers file

Until then the check **warns instead of blocking**: it names the commits that are not signed and
says that signatures are not enforced. The deploy goes on. This is deliberate. A commit cannot
switch enforcement on (it would be unverified itself), and commits made by agents on a machine
without signing set up would block every deploy. The file is the switch, and you create it by hand
on the machine that deploys.

The file lives **outside the repo** (`<PA data dir>/allowed_signers`: `%LOCALAPPDATA%\personal-assistant\`
on Windows, `~/.local/share/personal-assistant/` on Linux; `PA_ALLOWED_SIGNERS` overrides), so a
commit cannot add the key that signs it. `deploy.js --require-signed`, or `PA_REQUIRE_SIGNED=1`,
refuses even when the file is missing.

## Turn it on

1. On the machine that **makes** commits, a key used only for signing:

   ```
   ssh-keygen -t ed25519 -f ~/.ssh/dev-tools-signing -C "you@example.com"
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/dev-tools-signing.pub
   git config --global commit.gpgsign true
   ```

   (Windows: `$env:USERPROFILE\.ssh\dev-tools-signing`; the OpenSSH client ships with Windows.) Add
   the `.pub` to GitHub as a **Signing key** (Settings, SSH and GPG keys) to get the Verified badge.
   Agents that commit on that machine inherit it; a signing key with a passphrase needs an agent
   (`ssh-agent`) running, or commits will prompt.

2. On every machine that **deploys**, the trusted-signers file, one line per key, in
   `ssh-keygen`'s `allowed_signers` format:

   ```
   you@example.com namespaces="git" ssh-ed25519 AAAA...the public key...
   ```

   The email must match the commit's committer email. `ssh-keygen` must be on PATH (it is, with
   OpenSSH on Windows and on any Linux with `openssh-client`).

3. Commits made before step 1 are not signed. The check covers only the commits a deploy pulls
   (`from..HEAD`), so create the file on the deploying machine only after it is already at a
   commit you trust; every later pull must then be signed. To switch enforcement off again, delete
   the file.

Check it: `git -c gpg.ssh.allowedSignersFile=<file> log -3 --format='%h %G? %s'` shows `G` for a
trusted commit.

## Not covered

- It trusts the signing key, not the branch: a signed commit from a trusted key on any branch the
  clone follows is accepted.
- The termhub updater's own `git pull` (for termhub itself) is not checked here; this guards what
  `deploy.js` rolls.
- Release artifacts (the native build, Track Z/Exit 7) get their own signatures when they exist.
