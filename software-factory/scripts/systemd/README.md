# Factory self-deploy units (G4)

Automates the surgical sync of the running factory tree to `origin/main`
so merged loop-2 self-improvements reach the live ticks/manager without a
human running `git checkout origin/main -- factory/...` by hand.

Install (user services, same as the tick/manager units):

    cp scripts/systemd/factory-self-deploy.{service,timer} ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now factory-self-deploy.timer

Verify:

    systemctl --user list-timers factory-self-deploy.timer
    journalctl --user -u factory-self-deploy.service -n 50

The script (`scripts/deploy-factory-from-main.sh`) is idempotent, import-gated,
and NEVER deploys `factory/manager/**` or `bench/**` (forbidden self-edit —
operator PR only; a diff there is reported via a `FACTORY_SELF_DEPLOY_ALERT:`
line and skipped). Run `deploy-factory-from-main.sh --dry-run` to preview.
