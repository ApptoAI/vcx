# vcx

vercel cli has one global login. switching accounts means `vercel logout`,
`vercel login`, pick the team again, and now the other project deploys to the
wrong place. i got tired of it.

vcx gives every account its own vercel config dir and runs the real `vercel`
against whichever one you picked. plain `vercel` follows along.

```sh
vcx profile login work
vcx profile login personal
vcx profile use work
vercel whoami   # work account
```

tokens sit on disk as plain files. nothing is encrypted. read
[where the credentials live](#where-the-credentials-live) before running this
on a shared box.

## install

one line. installs bun if you don't have it, then vercel cli, then vcx.

```sh
curl -fsSL https://raw.githubusercontent.com/ApptoAI/vcx/main/install.sh | sh
```

everything lands in `~/.vcx` with its own lockfile, and `vcx` gets linked into
bun's bin dir. bun's global package list stays untouched. bun 1.4.0 keeps
appending duplicate entries to that list on repeat installs, and once it's
messed up nothing installs globally anymore, so the script stays out of it.
run the same line again to upgrade.

`VCX_REF` picks a tag, branch, or commit. `VCX_INSTALL_DIR` moves the
directory. you still need node 20 or newer, vercel cli runs on it.

got bun already and want it the normal way:

```sh
bun install --global vercel
bun install --global 'github:ApptoAI/vcx#v0.3.2'
```

use the `github:` form, not a tarball url. bun 1.4.0 installs from a tarball
fine and then exits with `unsafe name` anyway.

from a clone:

```sh
git clone https://github.com/ApptoAI/vcx.git
cd vcx
bun install
bun install --global .
```

## add accounts

```sh
vcx profile login personal
vcx profile login work
vcx profile list
```

`login` opens vercel's normal browser login and saves the result under the
name you gave it. the first profile becomes active. switch with `use`.

```sh
vcx profile use work
vcx whoami
vercel whoami   # same account. vcx points vercel's global config at the active profile
```

already have a token? `vcx profile add work` asks for it with a hidden prompt.
from a password manager:

```sh
printf '%s' "$MY_VERCEL_TOKEN" | vcx profile add work --token-stdin
```

`--token <value>` works too but lands in shell history. `add` checks the token
with `vercel whoami` before saving. `--no-verify` skips that if you're offline.

## commands

| command | what it does |
| --- | --- |
| `vcx profile login <name>` | vercel login flow into a new profile |
| `vcx profile add <name>` | save an existing token |
| `vcx profile use <name>` | switch the active profile |
| `vcx profile list` | list profiles, no credentials printed |
| `vcx profile current` | print the active profile |
| `vcx profile remove <name>` | delete a profile (asks first) |
| `vcx profile path` | print the vcx data dir |
| `vcx exec -p <name> -- <args>` | run one command under another profile |
| `vcx <args>` | run vercel under the active profile |

one-off with a different account:

```sh
vcx exec --profile personal -- deploy
VCX_PROFILE=personal vcx whoami   # same thing
```

profile stuff lives under `vcx profile` so vercel keeps its own names.
`vcx list`, `vcx login`, `vcx logout`, `vcx rm` go straight to vercel under
the active profile.

`--token` and `--global-config` are blocked because they'd bypass the profile.
call `vercel` directly if you need them.

## how it works

each profile is a full vercel global config dir. vcx starts vercel with

```text
--global-config <vcx data dir>/profiles/<name>
```

vercel reads and writes its own `auth.json` and `config.json` in there, so
login, logout, and team selection stay inside the profile. tokens never go into
child args or `VERCEL_TOKEN`. an inherited `VERCEL_TOKEN` gets dropped before
vercel starts, so a stray shell var can't hijack the account.

plain `vercel` follows the active profile too. on every switch vcx replaces
vercel's default global config dir with a link to the profile:

```text
linux    ~/.local/share/com.vercel.cli
macos    ~/Library/Application Support/com.vercel.cli
windows  %APPDATA%\xdg.data\com.vercel.cli   (a junction)
```

`XDG_DATA_HOME` moves it, `VCX_VERCEL_GLOBAL_DIR` overrides it. if a real dir
is already there, vcx renames it to `<dir>.before-vcx` on the first switch and
never touches it again. removing the active profile removes the link.
`vcx logout` and `vercel logout` both log out the active profile.

project links (`.vercel/project.json`) are per project, not per profile. if a
project points at the wrong team, run `vcx link` under the right profile.
`--scope` passes through.

one vercel cli 59 thing. `vercel whoami` inside a linked project resolves the
team from that project, and an account that's not in the team gets
`Not authorized`. that's vercel, not vcx. run it from `~` for the plain answer.

## where the credentials live

`vcx profile path` prints it. with `XDG_CONFIG_HOME` set it's
`$XDG_CONFIG_HOME/vcx` everywhere. otherwise:

```text
linux    ~/.config/vcx
macos    ~/Library/Application Support/vcx
windows  %LOCALAPPDATA%\vcx
```

```text
vcx/
  profiles.json
  profiles/
    personal/
      auth.json
      config.json   vercel creates this when it needs it
    work/
      auth.json
      config.json
```

dirs are `0700` and credential files `0600` on linux and macos. windows
inherits from local app data.

plaintext means anything running as your user can read these. keep the dir out
of git, cloud sync, logs, and support bundles. if it leaks, rotate the token.

`VCX_CONFIG_DIR` moves the whole thing. 0.2 migrated the old
`credentials.json` store on first run and deleted it.

## work on vcx

```sh
bun install
bun run test
bun run typecheck
```

tests run against a fake vercel binary in temp dirs. they never touch your
real login. ci covers linux, macos, and windows on node 20, 22, and 24, real
github installs on bun 1.4.0, latest, and canary, and `install.sh` on linux
and macos.
