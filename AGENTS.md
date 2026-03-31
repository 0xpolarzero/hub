# AGENTS

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

## Dependency policy
- `docs/references/` is reference-only; production imports must come from installed `node_modules` packages (i.e. "as node_modules").
