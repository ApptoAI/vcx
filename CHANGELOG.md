# Changelog

## Unreleased

- Verify new profiles from the profile directory instead of the current
  directory. Vercel CLI 59 resolves the team from a linked project in the
  working directory, so adding an account outside that team failed with
  `Not authorized`.
- `install.sh` installs into `~/.vcx` with a fresh manifest instead of
  `bun install --global`. Bun 1.4.0 fails with `refusing to install dependency
  with unsafe name` on some machines when the global manifest carries entries
  from earlier installs, and the new path does not depend on that state.

## 0.3.0 - 2026-09-02

- Link Vercel's global config directory to the active profile, so a plain
  `vercel` command uses the same account as `vcx`. The old directory is moved
  to `<dir>.before-vcx`, never deleted. `VCX_VERCEL_GLOBAL_DIR` overrides the
  directory.
- Add `install.sh` for a one-line curl install through Bun.
- Switch development and installs from npm to Bun.

## 0.2.1 - 2026-08-24

- Use Bun's `github:` dependency form. It avoids the false `unsafe name`
  failure that Bun 1.4.0 returns for remote tarballs.
- Test the GitHub install with Bun 1.4.0, latest stable, and latest canary in CI.

## 0.2.0 - 2026-08-24

- Give every profile its own Vercel global-config directory.
- Move profile management under `vcx profile` so Vercel commands keep their names.
- Run npm command shims on Windows through `cross-spawn`.
- Add locking, signal forwarding, legacy-store migration, and safer prompts.
- Add CI for Node.js 20, 22, and 24 on Linux, macOS, and Windows.
- Ship compiled files so GitHub installs do not need TypeScript.

## 0.1.0 - 2026-08-24

- Add named plaintext token profiles and Vercel command forwarding.
