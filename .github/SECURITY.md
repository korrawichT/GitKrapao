# Security policy

## Supported versions

Only the [latest release](https://github.com/korrawichT/GitKrapao/releases/latest) gets security fixes. Please update before reporting.

## Reporting a vulnerability

Please do **not** open a public issue. Report it privately instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and which version you used.

Only the maintainer can see the report. You will get an answer there, and the fix will be credited to you if you want.

## What counts

GitKrapao runs `git` on repositories you open, so the most important cases are:

- a repository whose own config, hooks or files make GitKrapao run a program without asking (the trust check should list it first)
- text from a repository (commit messages, branch names, file contents) that runs as script or markup in the app
- credentials or tokens shown, logged or stored where they should not be
- a fetch, switch, create, rename, delete or undo that loses commits or uncommitted work without warning

Problems that need someone to already control your machine or your global git config are out of scope.
