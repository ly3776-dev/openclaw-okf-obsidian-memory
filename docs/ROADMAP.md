# OKF Obsidian Memory Roadmap

Updated: 2026-06-24

## Current Baseline

- OpenClaw skill/plugin exposes 14 tools: ingest, daily, recall, SQLite index rebuild, Douyin, doctor, strict OKF validate/export, ontology validate, action validate/list/update/execute, and Obsidian Canvas/Base view export.
- Multimodal extraction covers text, images/PDF via PaddleOCR PP-OCRv6, audio/video via FunASR with faster-whisper fallback, and project-local Douyin download.
- Obsidian companion plugin runs manual and scheduled daily synthesis.
- Obsidian-native views are generated as `syntheses/ontology.canvas`, `syntheses/ontology-actions.base`, and action-note properties.
- Strict OKF validate/export is implemented.
- Palantir-inspired ontology graph is generated during daily synthesis.
- BGE-M3 OpenAI-compatible embedding endpoint can be used by both this project and OpenClaw memory search.
- SQLite/FTS cache accelerates large-vault recall while vector retrieval remains the semantic layer.
- OpenClaw Active Memory closed-loop verification exists through `npm run verify:openclaw`.

## P0: Release And Verification Foundation

- `npm run setup:check`: local install/runtime preflight without writing secrets.
- `npm run verify:all`: full verification wrapper for tests, plugin checks, secret scanning, OKF validate/export, embedding health, recall quality, and OpenClaw active-memory closed loop.
- `npm run verify:obsidian-cli`: optional Obsidian CLI gate, compatible with official Obsidian skills/CLI workflows.
- Keep all verification scripts repeatable on a fresh machine after `npm install` and Python dependency installation.
- Document one-command and staged verification paths.

## P1: Bilingual User Interfaces

- Obsidian settings page supports `中文` and `English`.
- Obsidian notices and errors follow the selected language.
- Obsidian command palette entries stay bilingual so both Chinese and English users can find commands.
- OpenClaw-visible tool labels and descriptions are bilingual while tool names and parameter keys remain stable.
- CLI human-facing help and unknown-command errors are bilingual.
- `npm run ui:bilingual`: regression gate for Obsidian, OpenClaw, and CLI visible bilingual text.

## P2: Memory Quality

- Prefer OpenAI-compatible BGE-M3 embeddings when configured; keep local hashed-token vectors as offline fallback.
- Keep hybrid recall: lexical, SQLite/FTS, ontology, and vector signals are fused rather than replacing one another.
- `npm run recall:quality`: quality gate for Chinese semantic recall, fuzzy spoken-language recall, and Douyin/Amazon operational examples.
- Track recall evidence quality: lexical, ontology, vector, and fused ranking signals in the quality gate output.
- Regression fixtures cover ambiguous content, Tavily-style enrichment, Chinese semantic recall, Douyin/Amazon operational recall, OCR choice, ontology actions, and OpenClaw Active Memory.

## P3: Ontology And OKF Deepening

- Strengthen ontology object/link/action typing using the Palantir Foundry ontology pattern.
- `npm run ontology:validate`: schema gate for object types, link types, action types, references, target types, and confidence values.
- `npm run actions:validate`: lifecycle gate for ontology maintenance actions, including proposed/accepted/in-progress/done/dismissed/archived states.
- `node ./src/cli.js action-list`, `action-update`, and `action-execute`: lifecycle helpers for accepting, starting, completing, dismissing, archiving, and safely executing ontology actions.
- `node ./src/cli.js obsidian-views`: exports ontology Canvas and Bases views for Obsidian-native review.
- Semantic action execution creates entity notes for promote-entity actions and review artifacts for merge, enrich, and review workflows.
- Maintain strict OKF export compatibility and update the validator when the OKF spec changes.
- Add migration scripts when a future OKF schema version requires note changes.

## P4: Packaging, Security, And Operations

- `npm run release:package`: package the OpenClaw plugin, Obsidian companion plugin, docs, tests, and helpers for another machine.
- `npm run release:check`: verify the release manifest, hashes, forbidden paths, zip extraction, and secret scan.
- `npm run security:check`: secret hygiene gate so API keys, Tavily keys, and OpenClaw gateway tokens do not enter distributable files.
- Portable setup and unattended services cover Windows and Linux.
- `docs/RELEASE_CHECKLIST.md`: lightweight release checklist covering install, extraction, Obsidian GUI, action execution, OpenClaw memory, and Active Memory verification.
