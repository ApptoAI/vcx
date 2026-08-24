# vcx

`vcx` gives the Vercel CLI named accounts on one device. Save a personal token,
a work token, and any other accounts once; switch the active profile instead of
logging in and out.

V1 intentionally stores credentials in plaintext. On macOS and Linux the data
directory is restricted to `0700` and the credential file to `0600`. Anyone or
anything that can read files as your operating-system user can still read the
tokens.

## Install

Node.js 20 or newer and the Vercel CLI are required.

```sh
npm install --global vercel
npm install
npm run build
npm install --global .
```

Once the package is published, the last three lines can be replaced with
`npm install --global vcx-cli`.

## Quick start

Use Vercel's normal browser/device login flow and give the resulting account a
local name:

```sh
vcx login personal
vcx login work
vcx list
vcx use work
vcx deploy --prod
```

Or save a token created in the Vercel dashboard. The hidden prompt is preferred
because it keeps the token out of shell history:

```sh
vcx add work
```

For a pipeline or password-manager integration, pipe the token:

```sh
printf '%s' "$MY_VERCEL_TOKEN" | vcx add work --token-stdin
```

`--token <token>` is also supported, but the value may remain in shell history.

## Commands

| Command | Purpose |
| --- | --- |
| `vcx login <name>` | Run Vercel's login flow and save the resulting token |
| `vcx add <name>` | Save and verify an existing token |
| `vcx use <name>` | Make a profile the default |
| `vcx list [--json]` | List profiles without revealing tokens |
| `vcx current [--json]` | Show the selected profile |
| `vcx remove <name>` | Delete a profile after confirmation |
| `vcx path` | Print the plaintext credential-file path |
| `vcx exec -p <name> -- <args>` | Use one profile without changing the default |
| `vcx <args>` | Pass a command to Vercel using the active profile |

Adding the first profile makes it active. Later additions leave the current
selection alone unless `--activate` is passed. Replacing an existing profile
requires `--force`; non-interactive removal does too.

Examples:

```sh
# Active account
vcx env pull
vcx logs my-deployment.vercel.app --follow

# One command under a different account
vcx exec --profile personal -- deploy

# Environment-based one-shot selection
VCX_PROFILE=personal vcx whoami
```

`list`, `login`, and the other vcx management names take precedence over Vercel
commands with the same names. Use the explicit form for a collision, for
example `vcx exec -- list` to run `vercel list`.

## How authentication works

For ordinary commands, vcx reads the selected token and sets `VERCEL_TOKEN`
only in the child Vercel process. The token is not appended to process arguments
and vcx does not modify Vercel's own global login. Vercel documents both
[`--token` authentication](https://vercel.com/docs/cli/global-options#token) and
the [`VERCEL_TOKEN` environment variable](https://github.com/vercel/vercel/blob/main/packages/cli/src/index.ts).

`vcx login <name>` runs `vercel login` against a temporary isolated global
configuration, imports its token after a successful login, and removes that
temporary directory.

Vercel project links remain in each project's `.vercel/project.json`; switching
an account does not rewrite that file. If a project belongs to another account
or team, run `vcx link` under the desired profile or pass Vercel's `--scope`
option.

## Credential storage

The V1 schema lives in one `credentials.json` file:

- Linux: `${XDG_CONFIG_HOME:-~/.config}/vcx/credentials.json`
- macOS: `~/Library/Application Support/vcx/credentials.json`
- Windows: `%LOCALAPPDATA%\vcx\credentials.json`

Run `vcx path` for the exact path. `VCX_CONFIG_DIR` overrides the directory,
which is useful for portable installs and tests.

The file contains the tokens in readable JSON. Do not commit it, sync it to an
untrusted drive, or include it in support bundles. Prefer scoped/revocable
Vercel tokens and rotate a token if the file is exposed. Windows access is
governed by the current user's ACL; Unix modes do not apply there.

## Development

```sh
npm run typecheck
npm test
npm pack --dry-run
```

Tests use an isolated fake Vercel executable. They do not contact Vercel or read
your real credentials.
