# AI Release State

Use this file to recover project context before AI-assisted development.
Before development, sync, or release, read this file first, then inspect
`git status`, `git log`, and the real diff between dev and main.

## Branch Roles

dev:
- Development and test branch.
- Repository: `kadidalax/cf-monitor-test`.
- Use it for demo deployment and feature validation.

main:
- Production release branch.
- Repository: `kadidalax/cf-vps-monitor`.
- Only receive features already validated in dev.

## Current Baseline

- main has synced the production-ready dev feature set.
- The expected branch-specific differences are repository URLs, install script sources, and one-click deploy links.

## Before Releasing To main

- Compare dev/main while ignoring line-ending-only differences.
- Classify files as: sync, manual merge only, or do not sync.
- Keep main repository links pointed at `kadidalax/cf-vps-monitor`.
- Keep dev repository links pointed at `kadidalax/cf-monitor-test`.
- Do not sync temporary previews, local-only scripts, or demo Worker-only configuration into main.

## Recommended AI Prompt

Before release:

```text
Prepare to sync dev into main.
Read AI_RELEASE_STATE.md, git status, git log, and the real dev/main diff.
Ignore line-ending-only differences.
Classify files as sync, manual merge only, or do not sync.
Preserve branch-specific repository links.
Give me the sync plan first. Do not edit yet.
```

After approval:

```text
Apply the approved sync plan to main.
Preserve main production repository links and exclude dev-only content.
Verify, then commit and push main.
```

## Release Checks

```bash
rg "cf-monitor-test|kadidalax/cf-monitor-test" README.md agent frontend/src worker/src scripts
git diff --check
npm run build
npm test
npm --prefix worker run lint
```
