# Changelog

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
