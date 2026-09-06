# owl-flutter-loader — agent notes

This repository is the shared Flutter-web adapter: a wrapper over Flutter's supported `_flutter.loader` lifecycle plus embedded multi-view attach/detach, so one engine can back several views in a persistent shell.

- Never execute the default `flutter_bootstrap.js` to 'warm the loader': it starts the application. Preparation is fetch-only; `initializeEngine`/`runApp` belong to activation.
- Renderer and JS-fallback selection stay with Flutter's own machinery; this adapter must not eagerly download every renderer variant.
- Multi-view means several views of ONE running application; it is not a way to host independently compiled Flutter apps in one engine.
- Never React/JSX and never a webview. TypeScript, Rust and Dart are modularized (nothing
  lives only in `main.*`); favor pure functions, explicit inputs and outputs, immutability,
  typed errors, exhaustive matching, and effects pushed to the edges.
- No third-party runtime dependencies in this org. The loading layer is the first thing a
  page runs; it must not drag a dependency tree in front of itself.
- Contracts are TypeSpec + JSON Schema peers checked by ORESoftware/ores-contracts; the
  shared vocabulary comes from `ores-wasm-loaders/owl-interfaces` through zed-pkg.
- Preparation and activation are different operations and must stay that way: preparation
  never executes application code, authenticates, subscribes, or writes.
- Resolve git conflicts semantically (reconcile both sides; never just pick one); never
  rebase, stash, or reset. `main` is production, `dev` is integration.

<!-- BEGIN ores-agents-pointer: managed by ORESoftware/my-ai; edit there, not here -->
## Canonical agent instructions

Before doing anything else in this repository, also read:

    .ores/agents/AGENTS.md

That path is a symlink to `~/codes/oresoftware/my-ai/AGENTS.md`, whose canonical copy is
<https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md>. The symlink is deliberately not
committed (it names an absolute path only valid on a machine with that checkout), so `.ores/`
is git-ignored. If it is missing on your machine:

    mkdir -p .ores/agents
    ln -sfn "$HOME/codes/oresoftware/my-ai/AGENTS.md" .ores/agents/AGENTS.md

A missing `.ores/agents/AGENTS.md` is a setup gap on the reader's machine, never a reason to
skip the canonical instructions: fetch them from the URL above instead.
<!-- END ores-agents-pointer -->
