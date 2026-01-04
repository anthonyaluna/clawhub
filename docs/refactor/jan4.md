# Refactor — 2026-01-04

- ~~Publish-ready workspace deps:~~
  - ~~Make `@clawdhub/schema` publishable + switch consumers from `workspace:*` to semver.~~
- ~~Shared pure helpers:~~
  - ~~De-dupe text-file rules (extensions + content-types) between CLI + Convex.~~
- ~~Shared HTTP contracts:~~
  - ~~Centralize API route paths + request/response schemas in `@clawdhub/schema`.~~
- ~~CLI upload ergonomics:~~
  - ~~Add `ignore` (respect `.gitignore` / `.clawdhubignore` during file collection).~~
  - ~~Add `mime` (better `contentType` on upload).~~
- ~~Dependency hygiene:~~
  - ~~Remove unused deps: `@radix-ui/react-slot`, `web-vitals`, `@tanstack/react-router-ssr-query` (keep `lucide-react`, used).~~
- CI:
  - Add GitHub Actions workflow: install, lint, test, coverage, build.
