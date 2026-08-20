# OKF Ontology Design

This project borrows the modeling shape of Palantir Foundry Ontology: represent the working world as object types, properties, links, actions, and functions rather than as unstructured notes only.

## Source Ideas

Palantir's public Foundry Ontology documentation describes the Ontology as a semantic layer where source data is represented as objects with properties and links. Their core concepts also define link types as reusable schemas between two object types, properties as object characteristics, and action types as transactional changes to ontology objects, properties, or links.

Docs:

- https://www.palantir.com/docs/foundry/ontology/overview
- https://www.palantir.com/docs/foundry/ontology/core-concepts

## Mapping In This Project

The Obsidian vault is treated as an operational knowledge system:

- `Concept`: one OKF note or durable idea.
- `Source`: the original text, media, URL, file, or inline capture.
- `Tag`: a normalized topic marker.
- `Entity`: a repeated person, product, platform, metric, workflow, or domain term.

Current link types:

- `derived_from`: Concept -> Source.
- `has_tag`: Concept -> Tag.
- `mentions`: Concept -> Entity.
- `similar_to`: Concept -> Concept.
- `same_domain`: Concept -> Concept.

Current action types:

- `merge_duplicate_concepts`
- `promote_entity_note`
- `enrich_ambiguous_concept`
- `schedule_review`

Action lifecycle statuses:

- `proposed`
- `accepted`
- `in_progress`
- `done`
- `dismissed`
- `archived`

## Daily Flow

`daily` rebuilds the local index, projects notes into ontology objects, creates links, suggests actions, writes `.okf-cache/ontology.json`, then renders `daily/YYYY-MM-DD-synthesis.md`.

It also writes `.okf-cache/ontology-actions.json` and `syntheses/ontology-actions.md`. Use `action-list` to inspect proposed work, `action-update` to move an action through accepted, in-progress, done, dismissed, or archived states, and `action-execute` to create a safe lifecycle artifact for the action.

If `OKF_ONTOLOGY_LLM_COMMAND` is configured and `--use-llm` is passed, the graph is sent to that command for a Markdown review. This keeps the core portable: deployments can use OpenAI, local models, OpenClaw providers, or an internal LLM gateway without changing the vault format.

## Recall Flow

`recall` still returns lexical note matches, but now also returns `ontologyMatches`, which scores a concept using its ontology neighborhood. It also returns `vectorMatches` from `.okf-cache/vector-index.json`, then merges all signals into `fusedMatches`.

The vector index is deliberately not the memory source of truth. It is a recall accelerator layered over Markdown notes and ontology objects.

## Web Enrichment

Ambiguous content can call `OKF_WEB_ENRICH_COMMAND`. The command receives JSON on stdin and should return:

```json
{
  "text": "additional context",
  "citations": ["https://example.com/source"]
}
```

The enrichment is appended under `# Web Enrichment`, while citations are added to the note's citation section.

## Current Boundaries

- The default ontology builder is deterministic and local.
- LLM and web research are adapter protocols, not hardcoded to one vendor.
- The current graph is JSON, optimized for portability rather than scale.
- Current action execution is conservative: merge, enrich, and review actions create review artifacts instead of modifying source notes directly; promote-entity actions create entity notes.
- Future versions can add richer entity extraction and guarded automatic source-note edits.
