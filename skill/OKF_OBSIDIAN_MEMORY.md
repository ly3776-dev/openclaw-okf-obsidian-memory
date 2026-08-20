# OKF Obsidian Memory Skill

Use this skill when the user asks OpenClaw to capture, summarize, preserve, connect, or recall knowledge from text, images, documents, audio, video, URLs, screenshots, or rough notes.

## Intent

Turn incoming material into durable OKF-compatible Markdown notes in the user's Obsidian vault, then make those notes available for future recall.

## Workflow

1. Classify the input as text, image, document, audio, video, URL, or mixed content.
2. Extract the usable content. Prefer exact transcription/OCR before summarization.
3. If the input is ambiguous or incomplete, call `okf_obsidian_ingest` with `useWeb: true`. The project expects `OKF_WEB_ENRICH_COMMAND` to provide web research and citations; if it is not configured, preserve the original input and record the enrichment warning.
4. Create an OKF note with YAML frontmatter and a Markdown body.
5. Write the note to the configured Obsidian vault.
6. Update the local JSON index, SQLite/FTS index, ontology graph, and vector recall index.
7. Run `okf_obsidian_daily` for ontology-aware synthesis. Use `useLlm: true` when the deployment has `OKF_ONTOLOGY_LLM_COMMAND` configured.
8. Run `okf_obsidian_ontology_validate` after ontology changes or before treating the graph as production memory.
9. Run `okf_obsidian_actions_validate` to verify the lifecycle queue for merge, promote, enrich, review, and archive actions.
10. Use `okf_obsidian_actions_list`, `okf_obsidian_action_update`, and `okf_obsidian_action_execute` when the user or agent wants to accept, start, complete, dismiss, archive, or safely execute a suggested ontology action.
11. Use `okf_obsidian_obsidian_views` when the user wants Obsidian-native Canvas/Bases views refreshed.
12. Use `okf_obsidian_sqlite_index` when a large vault needs a fast explicit database index rebuild.
13. Before answering later related questions, call recall and cite matching notes.
14. When the user asks for portable OKF output, call `okf_obsidian_okf_validate` and `okf_obsidian_okf_export`.

## Ontology Model

Daily synthesis follows a Palantir-inspired ontology frame:

- Object types: `Concept`, `Source`, `Tag`, `Entity`.
- Properties: title, description, path, timestamp, confidence, source type, resource.
- Link types: `derived_from`, `has_tag`, `mentions`, `similar_to`, `same_domain`.
- Action types: `merge_duplicate_concepts`, `promote_entity_note`, `enrich_ambiguous_concept`, `schedule_review`.
- Action queue statuses: `proposed`, `accepted`, `in_progress`, `done`, `dismissed`, `archived`.

Use this ontology to reason about what the knowledge is about, where it came from, how concepts connect, and what maintenance action should happen next.

## Quality Rules

- Do not invent citations.
- Separate original input from inferred or web-enriched context.
- Mark uncertain claims with lower confidence.
- Prefer many small durable notes over one oversized dump.
- Use wiki links for related concepts when known.
- Keep notes useful when opened directly in Obsidian.

## Tool Preference

Use the plugin tools in this order:

1. `okf_obsidian_ingest` for new content.
2. `okf_obsidian_daily` for linking and synthesis.
3. `okf_obsidian_recall` before answering related questions.
4. `okf_obsidian_sqlite_index` after bulk import or migration.

For Douyin links or Douyin share text, first download the video through the Douyin downloader entrypoint, then ingest the downloaded MP4 as a video source. Preserve the original Douyin share text or URL in the source metadata when available.

## Tool Arguments

- `okf_obsidian_ingest`: requires `vault`; accepts `text`, `inputPath`, `sourceType`, `title`, `useWeb`.
- `okf_obsidian_douyin`: requires `vault`; accepts `url` or `text`, plus optional `title`.
- `okf_obsidian_recall`: requires `vault` and `query`; accepts `limit`.
- `okf_obsidian_sqlite_index`: requires `vault`.
- `okf_obsidian_daily`: requires `vault`; accepts `useLlm`.
- `okf_obsidian_doctor`: no arguments.
- `okf_obsidian_okf_validate`: requires `vault`.
- `okf_obsidian_ontology_validate`: requires `vault`.
- `okf_obsidian_actions_validate`: requires `vault`.
- `okf_obsidian_actions_list`: requires `vault`; accepts optional `status` and `limit`.
- `okf_obsidian_action_update`: requires `vault`, `id`, and `status`; accepts optional `note`.
- `okf_obsidian_action_execute`: requires `vault` and `id`.
- `okf_obsidian_obsidian_views`: requires `vault`.
- `okf_obsidian_okf_export`: requires `vault`; accepts `outputDir`.
