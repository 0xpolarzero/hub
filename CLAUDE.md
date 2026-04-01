# CLAUDE.md

This repository contains an Electrobun desktop app scaffolded from the official
`electrobun init svelte` template.

## Tooling
- Package manager: bun
- Runtime/development: Electrobun
- Frontend: Svelte + TypeScript + Vite

## Scripts
- `bun run start` — build and run the app in development mode
- `bun run dev` — watch mode for Electrobun dev
- `bun run dev:hmr` — Vite HMR + Electrobun launcher

## Notes
- This is an Electrobun project, not an Electron app.

## Reference code for tools
- `docs/references/` contains git submodules for libraries and frameworks we use in this repository as reference code for LLM-assisted development.
- `docs/references/pi-mono` — Reference for logic related to interacting with LLM agents in our app.
- `docs/references/rivet` — Reference for Rivet Agent OS (isolated VM agent orchestration, multi-agent workflows, host tools, persistent state).

## Dependency policy
- `docs/references/` is reference-only; production imports must come from installed `node_modules` packages (i.e. "as node_modules").

## Type safety rules
- **No `as any` casts.** Never use `as any` in production code or tests. If a type is unknown, narrow it with type guards, type predicates, or proper discriminated-union checks. If a third-party API forces a loose type, wrap the cast in a single helper function rather than scattering `as any` across the codebase.
- **Avoid `as never` and other type-escape casts.** Prefer proper generic types, type parameters, or wrapper functions over `as never`, `as unknown as T`, or similar escape hatches. Only use them when the type system genuinely cannot express the constraint, and isolate them to a single location.
