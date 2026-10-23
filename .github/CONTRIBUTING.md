# Contributing to GitKrapao

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/korrawichT/GitKrapao/issues/new/choose) and pick a template. For a bug, the Output drawer at the bottom of the window shows the git commands GitKrapao ran and what git printed; that usually explains what happened.

Security problems go through private reporting instead, see [SECURITY.md](SECURITY.md).

## Making a change

1. Set up the tools listed under **Development** in the [README](../README.md#development) (Git, Node.js, pnpm, Rust, the Visual Studio C++ workload).
2. Branch from `develop`, and open the pull request into `develop`. `main` only gets releases.
3. Read [CLAUDE.md](../CLAUDE.md) before changing code. It records the design rules and why they exist, for example how the graph lays out rows and why fetch never deletes local refs.
4. Test against the sample repository from `pnpm run mock`, never against a real work repository.
5. Before you open the pull request, run:

   ```bash
   pnpm run typecheck
   pnpm run test:ui
   pnpm run check:bindings
   cd src-tauri && cargo test --lib
   ```

   Add tests for what you changed: a cargo test with a temporary repository for anything that runs git, and a suite in `tests/ui/` for the UI.

## Conventions

- Keep using pnpm.
- TypeScript is `strict`: no `any` outside parse boundaries, no `@ts-ignore`.
- A Rust struct sent to the UI is typed in `src/bindings/` by ts-rs. Commit the regenerated files.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) in English: `type(scope): description`, for example `feat(toolbar): add a create branch button` or `fix(tabs): keep the tab list inside the window`. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`.
- Keep user-facing text short and plain English.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](../LICENSE) of this project.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
