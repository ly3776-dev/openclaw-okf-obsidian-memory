# Strict OKF, Ontology, Actions, And Vector Closure

The project separates three layers:

- Obsidian vault: working memory and user-facing Markdown.
- Strict OKF export: portable bundle in `<Vault>/okf-export/`.
- Recall cache: local ontology, action, and vector indexes in `<Vault>/.okf-cache/`.

## Strict OKF

The strict export follows the currently implemented OKF v0.1 constraints used by this project:

- Markdown files with YAML frontmatter.
- Concept files must have non-empty `type`.
- Concept bodies must be non-empty.
- `index.md` and `log.md` are reserved bundle files.
- Obsidian wiki links are normalized to standard Markdown links during export.
- Local resource paths are normalized to relative paths or `file:///` URIs.

Commands:

```powershell
node ./src/cli.js okf-validate --vault ./examples/vault
node ./src/cli.js okf-export --vault ./examples/vault
```

OpenClaw tools:

- `okf_obsidian_okf_validate`
- `okf_obsidian_okf_export`

## Ontology Validation

The ontology graph follows a Palantir-inspired shape: object types, properties, link types, and action types are explicit schema elements. The validator checks:

- expected object types: `Concept`, `Source`, `Tag`, `Entity`
- expected link types and endpoint type pairs
- expected action types and target object types
- object references, duplicate ids, evidence arrays, and confidence ranges

Commands:

```powershell
node ./src/cli.js ontology-validate --vault ./examples/vault
npm run ontology:validate
```

OpenClaw tool:

- `okf_obsidian_ontology_validate`

## Ontology Action Queue

Daily synthesis turns ontology actions into a stable lifecycle queue:

```text
<Vault>/.okf-cache/ontology-actions.json
<Vault>/syntheses/ontology-actions.md
```

The queue preserves human state across runs and supports:

- statuses: `proposed`, `accepted`, `in_progress`, `done`, `dismissed`, `archived`
- priorities: `high`, `medium`, `low`
- stale action handling when an old suggestion no longer appears in the current graph
- validation for stable ids, status, priority, target references, confidence, and timestamps

Commands:

```powershell
node ./src/cli.js action-validate --vault ./examples/vault
npm run actions:validate
```

OpenClaw tool:

- `okf_obsidian_actions_validate`

## Vector Recall

The vector index is stored at:

```text
<Vault>/.okf-cache/vector-index.json
```

Current provider:

```text
local-hashed-token-embedding
```

This is dependency-free and portable. It improves phrase-level and fuzzy recall, while keeping OKF Markdown and ontology JSON as the source of truth.

For production recall, configure any OpenAI-compatible embedding endpoint:

```powershell
$env:OKF_EMBEDDING_BASE_URL="http://your-openai-compatible-gateway/"
$env:OKF_EMBEDDING_API_KEY="sk-..."
$env:OKF_EMBEDDING_MODEL="your-embedding-model"
```

Use a model that actually exposes the OpenAI-compatible `/v1/embeddings` endpoint. If the provider rejects the embedding model, the index builder falls back to `local-hashed-token-embedding` and records the reason in `.okf-cache/vector-index.json`.

The public recall shape does not change when switching providers.
