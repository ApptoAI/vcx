# vcx

Vercel CLI remembers one login at a time. That gets annoying when personal and
work projects live on the same computer.

`vcx` keeps a named list of Vercel tokens. Pick an active profile, then use
`vcx` where you would normally use `vercel`.

```sh
vcx use work
vcx deploy --prod
```

This first release stores tokens as plain JSON. You can inspect the file with a
text editor, and so can any other program running as your user. Read
[where the tokens live](#where-the-tokens-live) before using it on a shared
machine.

## Install

You need Node.js 20 or newer and the Vercel CLI.

`vcx` is not on npm yet. Install it from this repository:

```sh
git clone https://github.com/akrupa-appto/vcx.git
cd vcx
npm install
npm run build
npm install --global .
```

Install Vercel too if you do not already have it:

```sh
npm install --global vercel
```

## Start using it

Run Vercel's regular browser login and give the account a local name.

```sh
vcx login personal
vcx login work
vcx list
vcx use work
vcx whoami
```

Already have a token? `vcx add work` opens a hidden prompt. A password manager
can pipe the token to standard input.

```sh
printf '%s' "$MY_VERCEL_TOKEN" | vcx add work --token-stdin
```

There is also a `--token` option. It puts the value in your shell history, so I
would avoid it outside throwaway test accounts.

## Commands

| Command | What it does |
| --- | --- |
| `vcx login <name>` | Opens Vercel login and saves the token under a name |
| `vcx add <name>` | Saves and checks an existing token |
| `vcx use <name>` | Changes the active profile |
| `vcx list` | Lists profiles without printing tokens |
| `vcx current` | Prints the selected profile |
| `vcx remove <name>` | Deletes a profile after confirmation |
| `vcx path` | Prints the credential file path |
| `vcx exec -p <name> -- <args>` | Uses another profile for one command |
| `vcx <args>` | Runs Vercel with the active profile |

The first profile becomes active. Adding another profile does not switch to it
unless you pass `--activate`.

Use a different account for one command without changing the active profile:

```sh
vcx exec --profile personal -- deploy
```

You can do the same thing with an environment variable:

```sh
VCX_PROFILE=personal vcx whoami
```

Some vcx commands have the same names as Vercel commands. `vcx list` lists vcx
profiles. To run `vercel list`, use the explicit form.

```sh
vcx exec -- list
```

## How a command reaches Vercel

`vcx` reads the selected token and puts it in `VERCEL_TOKEN` for the child
Vercel process. Saved tokens do not appear in the child process arguments. Your
normal Vercel login stays untouched.

Vercel supports the [`VERCEL_TOKEN` environment variable](https://github.com/vercel/vercel/blob/main/packages/cli/src/index.ts)
and documents [token authentication](https://vercel.com/docs/cli/global-options#token).

`vcx login <name>` gives Vercel a temporary config directory. After login, vcx
copies the token into its own credential file and deletes the temporary files.

Account switching does not touch project links. Vercel stores them in
`.vercel/project.json` inside each project. Run `vcx link` under the right
profile if a project points at the wrong account or team. Vercel's `--scope`
option also works through vcx.

## Where the tokens live

Run `vcx path` to print the path on your machine. The defaults are:

```text
Linux   ${XDG_CONFIG_HOME:-~/.config}/vcx/credentials.json
macOS   ~/Library/Application Support/vcx/credentials.json
Windows %LOCALAPPDATA%\vcx\credentials.json
```

On Linux and macOS, vcx sets the directory mode to `0700` and the file mode to
`0600`. Windows uses the access rules inherited from your local app data
directory.

Plaintext means any program running as your user can read these tokens. File
permissions do not change that. Keep the file out of Git, cloud sync, logs, and
support bundles. Rotate the token in Vercel if the file leaks.

Set `VCX_CONFIG_DIR` if you want the file somewhere else.

## Work on vcx

```sh
npm run typecheck
npm test
npm pack --dry-run
```

The tests use a fake Vercel executable and a temporary credential directory.
They never read your Vercel login.
