# vcx

Vercel CLI keeps one global login. `vcx` gives each account its own Vercel
config directory, then runs the real `vercel` command against the profile you
picked.

```sh
vcx profile use work
vcx deploy --prod
```

Personal login, work login, separate team state. No more signing in and out to
change accounts.

This release stores Vercel credentials as plain files. It does not encrypt them.
Read [where the credentials live](#where-the-credentials-live) before using vcx
on a shared machine.

## Install

You need Node.js 20 or newer and Vercel CLI.

```sh
npm install --global vercel
npm install --global https://github.com/akrupa-appto/vcx/archive/refs/tags/v0.2.0.tar.gz
```

To work from a clone instead:

```sh
git clone https://github.com/akrupa-appto/vcx.git
cd vcx
npm install
npm install --global .
```

## Add accounts

Run Vercel's login flow and give the account a local name.

```sh
vcx profile login personal
vcx profile login work
vcx profile list
```

The first profile becomes active. Switch whenever you need to.

```sh
vcx profile use work
vcx whoami
```

Already have a token? `vcx profile add work` opens a hidden prompt. A password
manager can pipe the token to standard input.

```sh
printf '%s' "$MY_VERCEL_TOKEN" | vcx profile add work --token-stdin
```

`--token <value>` also works, but it leaves the token in shell history. The
default `add` command checks the account with `vercel whoami`. Pass
`--no-verify` when storing a token offline.

## Commands

| Command | What it does |
| --- | --- |
| `vcx profile login <name>` | Opens Vercel login for a new profile |
| `vcx profile add <name>` | Saves an existing token |
| `vcx profile use <name>` | Changes the active profile |
| `vcx profile list` | Lists profiles without printing credentials |
| `vcx profile current` | Prints the selected profile |
| `vcx profile remove <name>` | Deletes a profile after confirmation |
| `vcx profile path` | Prints the vcx data directory |
| `vcx exec -p <name> -- <args>` | Uses another profile for one command |
| `vcx <args>` | Runs Vercel with the active profile |

Use another account once without changing the default.

```sh
vcx exec --profile personal -- deploy
```

An environment variable does the same job.

```sh
VCX_PROFILE=personal vcx whoami
```

Profile commands have their own namespace. That leaves Vercel's command names
alone. `vcx list`, `vcx login`, `vcx logout`, and `vcx rm` all go to Vercel
under the selected profile.

vcx blocks Vercel's `--token` and `--global-config` options because either one
would bypass the selected profile. Run `vercel` directly when you need those
options.

## How account isolation works

Each profile is a complete Vercel global-config directory. vcx adds this option
when it starts Vercel:

```text
--global-config <vcx data directory>/profiles/<name>
```

Vercel reads and updates its own `auth.json` and `config.json` in that directory.
vcx does not put saved tokens in child process arguments or `VERCEL_TOKEN`. It
also removes an inherited `VERCEL_TOKEN` before starting Vercel, so a shell
variable cannot override the selected account.

This setup keeps login, logout, team selection, and later Vercel config changes
inside one profile. `vcx logout` logs out the active profile, not Vercel's normal
global login.

Project links still live in `.vercel/project.json` inside each project. Run
`vcx link` under the right profile if a project points to the wrong account or
team. Vercel's `--scope` option passes through normally.

## Where the credentials live

Run `vcx profile path` to print the directory on your machine. If
`XDG_CONFIG_HOME` is set, vcx uses `$XDG_CONFIG_HOME/vcx` on every platform.
Otherwise the defaults are:

```text
Linux   ~/.config/vcx
macOS   ~/Library/Application Support/vcx
Windows %LOCALAPPDATA%\vcx
```

The layout looks like this:

```text
vcx/
  profiles.json
  profiles/
    personal/
      auth.json
      config.json   created by Vercel when needed
    work/
      auth.json
      config.json
```

On Linux and macOS, vcx writes directories with mode `0700` and credential files
with mode `0600`. Windows uses the access rules inherited from the local app data
directory.

Plaintext means any program running as your user can read these files. Keep the
directory out of Git, cloud sync, logs, and support bundles. Rotate a Vercel
token if the directory leaks.

Version 0.2 migrates the old `credentials.json` store on first use. It writes
each token to the matching profile directory, replaces the old registry with
`profiles.json`, then deletes the old token file.

Set `VCX_CONFIG_DIR` to use another location.

## Work on vcx

```sh
npm ci
npm test
npm run typecheck
npm pack --dry-run
```

The test suite uses a fake Vercel executable and temporary profile directories.
It never reads your real Vercel login. GitHub Actions runs the suite on Linux,
macOS, and Windows with Node.js 20, 22, and 24.
