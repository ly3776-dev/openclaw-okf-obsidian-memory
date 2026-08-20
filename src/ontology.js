import path from "node:path";

export const ONTOLOGY_VERSION = "0.1";

export const DEFAULT_ONTOLOGY_LIMITS = Object.freeze({
  topK: 20,
  candidateMultiplier: 4,
  maxTagsPerConcept: 16,
  maxEntitiesPerConcept: 24,
  maxKeywordsPerConcept: 48,
  maxCandidatesPerSignal: 8
});

export const OBJECT_TYPES = {
  Concept: {
    description: "A durable OKF knowledge note or idea captured in the vault.",
    properties: ["title", "description", "path", "timestamp", "confidence", "source_type"]
  },
  Source: {
    description: "An original input artifact, URL, media file, document, or inline capture.",
    properties: ["resource", "source_type"]
  },
  Tag: {
    description: "A topical marker shared by concepts.",
    properties: ["name"]
  },
  Entity: {
    description: "A named person, product, organization, platform, metric, or domain term.",
    properties: ["name", "kind"]
  }
};

export const LINK_TYPES = {
  derived_from: {
    from: "Concept",
    to: "Source",
    description: "The concept note was generated from this source."
  },
  has_tag: {
    from: "Concept",
    to: "Tag",
    description: "The concept carries this topical tag."
  },
  mentions: {
    from: "Concept",
    to: "Entity",
    description: "The concept mentions this entity or operational term."
  },
  similar_to: {
    from: "Concept",
    to: "Concept",
    description: "Two concepts share enough properties, tags, and entities to review together."
  },
  same_domain: {
    from: "Concept",
    to: "Concept",
    description: "Two concepts appear to belong to the same operational domain."
  }
};

export const ACTION_TYPES = {
  merge_duplicate_concepts: {
    description: "Review concepts with very high overlap and merge duplicates if they describe the same idea.",
    inputs: ["Concept", "Concept"]
  },
  promote_entity_note: {
    description: "Create a dedicated entity note when an entity is mentioned across multiple concepts.",
    inputs: ["Entity"]
  },
  enrich_ambiguous_concept: {
    description: "Use web research or an LLM to add missing context and citations to a low-confidence concept.",
    inputs: ["Concept"]
  },
  schedule_review: {
    description: "Queue a human review for low-confidence or weakly-linked concepts.",
    inputs: ["Concept"]
  }
};

export function buildOntologyGraph(notes, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const safeNotes = Array.isArray(notes) ? notes : [];
  const limits = resolveOntologyLimits(safeNotes.length, options);
  const conceptObjects = safeNotes.map(noteToConceptObject);
  const sources = new Map();
  const tags = new Map();
  const entities = new Map();
  const links = [];
  const degradedReasons = new Set();
  const analyses = [];

  for (let index = 0; index < safeNotes.length; index += 1) {
    const note = safeNotes[index];
    const conceptId = conceptIdFor(note);
    const analysis = analyzeNote(note, index, limits);
    analyses.push(analysis);
    const source = sourceObjectFor(note);
    if (source) {
      sources.set(source.id, source);
      pushLinkWithinLimit(links, link("derived_from", conceptId, source.id, { evidence: note.path, confidence: 0.92 }), limits.maxLinks, degradedReasons);
    }

    for (const tagName of analysis.tags) {
      const tagObject = tagObjectFor(tagName);
      tags.set(tagObject.id, tagObject);
      pushLinkWithinLimit(links, link("has_tag", conceptId, tagObject.id, { evidence: note.path, confidence: 0.86 }), limits.maxLinks, degradedReasons);
    }

    for (const entity of analysis.entities) {
      entities.set(entity.id, entity);
      pushLinkWithinLimit(links, link("mentions", conceptId, entity.id, { evidence: note.path, confidence: entity.confidence }), limits.maxLinks, degradedReasons);
    }
  }

  let suggested = { links: [], candidatePairs: 0, degradedReasons: [] };
  try {
    suggested = suggestOntologyLinks(analyses, limits);
  } catch (error) {
    degradedReasons.add(`semantic_link_generation_failed:${error?.name || "Error"}`);
  }
  for (const item of suggested.links) {
    pushLinkWithinLimit(links, item, limits.maxLinks, degradedReasons);
  }
  for (const reason of suggested.degradedReasons) degradedReasons.add(reason);
  const dedupedLinks = dedupeLinks(links);
  const actions = suggestActions(safeNotes, entities, dedupedLinks);
  const objects = [
    ...conceptObjects,
    ...sources.values(),
    ...tags.values(),
    ...entities.values()
  ];
  const adjacency = buildOntologyAdjacency(dedupedLinks, objects);

  return {
    ontology_version: ONTOLOGY_VERSION,
    generatedAt,
    schema: {
      objectTypes: OBJECT_TYPES,
      linkTypes: LINK_TYPES,
      actionTypes: ACTION_TYPES
    },
    objects,
    links: dedupedLinks,
    adjacency,
    actions,
    limits: {
      ...limits,
      candidatePairs: suggested.candidatePairs,
      semanticLinks: suggested.links.length,
      degraded: degradedReasons.size > 0,
      degradedReasons: [...degradedReasons]
    }
  };
}

export function validateOntologyGraph(graph) {
  const issues = [];
  if (!graph || typeof graph !== "object") {
    return validationResult({ graph, issues: [ontologyIssue("invalid_graph", "$", "Ontology graph must be an object.")] });
  }

  if (graph.ontology_version !== ONTOLOGY_VERSION) {
    issues.push(ontologyIssue("version_mismatch", "ontology_version", `Expected ontology_version ${ONTOLOGY_VERSION}.`));
  }

  validateSchema(graph.schema, issues);

  const objects = Array.isArray(graph.objects) ? graph.objects : [];
  const links = Array.isArray(graph.links) ? graph.links : [];
  const actions = Array.isArray(graph.actions) ? graph.actions : [];
  if (!Array.isArray(graph.objects)) issues.push(ontologyIssue("objects_not_array", "objects", "Graph objects must be an array."));
  if (!Array.isArray(graph.links)) issues.push(ontologyIssue("links_not_array", "links", "Graph links must be an array."));
  if (!Array.isArray(graph.actions)) issues.push(ontologyIssue("actions_not_array", "actions", "Graph actions must be an array."));

  const objectById = new Map();
  objects.forEach((object, index) => validateObject(object, index, objectById, issues));
  links.forEach((item, index) => validateLink(item, index, objectById, issues));
  actions.forEach((action, index) => validateAction(action, index, objectById, issues));

  return validationResult({ graph, issues });
}

export function rankOntologyRecall(graph, query, limit = 5) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const objects = Array.isArray(graph?.objects) ? graph.objects : [];
  const links = Array.isArray(graph?.links) ? graph.links : [];
  const adjacency = usableAdjacency(graph?.adjacency)
    ? graph.adjacency
    : buildOntologyAdjacency(links, objects);
  if (usableRecallIndex(adjacency)) {
    return rankFromOntologyRecallIndex(objects, adjacency, tokens, limit);
  }
  const concepts = objects.filter((object) => object.type === "Concept");
  const objectById = new Map(objects.map((object) => [object.id, object]));
  return concepts
    .map((object) => {
      const neighborhood = neighborhoodText({ links, objectById, adjacency }, object.id);
      const haystack = tokenize(`${object.properties.title} ${object.properties.description} ${neighborhood}`);
      const counts = countTokens(haystack);
      const score = tokens.reduce((sum, token) => sum + (counts.get(token) || 0), 0);
      return { object, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ object, score }) => ({
      id: object.id,
      type: object.type,
      score,
      title: object.properties.title,
      description: object.properties.description,
      path: object.properties.path
    }));
}

export function renderOntologySynthesis(date, notes, graph, llm = { skipped: true }) {
  const recentConcepts = graph.objects
    .filter((object) => object.type === "Concept")
    .slice(0, 12)
    .map((object) => `- [[${object.properties.path.replace(/\.md$/, "")}|${object.properties.title}]] - ${object.properties.description}`)
    .join("\n");

  const strongestLinks = graph.links
    .filter((item) => item.type === "similar_to" || item.type === "same_domain")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12)
    .map((item) => `- ${wikilink(graph, item.from)} ${item.type.replaceAll("_", " ")} ${wikilink(graph, item.to)} (${item.evidence.join(", ")})`)
    .join("\n");

  const entityHotspots = frequentEntities(graph)
    .slice(0, 12)
    .map((item) => `- ${item.name} (${item.kind}) - ${item.count} mentions`)
    .join("\n");

  const actions = graph.actions
    .slice(0, 12)
    .map((action) => `- ${action.type.replaceAll("_", " ")}: ${action.description} (${action.targets.join(", ")})`)
    .join("\n");
  const llmSection = llm.ok && llm.markdown
    ? llm.markdown
    : `- ${llm.reason || "LLM enrichment was not run."}`;

  return `---
type: Synthesis
title: Daily Ontology Synthesis ${date}
timestamp: ${new Date().toISOString()}
okf_version: "${ONTOLOGY_VERSION}"
ontology_version: "${ONTOLOGY_VERSION}"
---

# Ontology Frame

This synthesis models the vault as objects, properties, links, and actions. Concepts are the primary objects; sources, tags, and entities become linked objects that can be recalled by OpenClaw.

# Recent Concepts

${recentConcepts || "- No concepts indexed."}

# Strong Links

${strongestLinks || "- No strong ontology links yet."}

# Entity Hotspots

${entityHotspots || "- No repeated entities yet."}

# Suggested Actions

${actions || "- No actions suggested."}

# LLM Ontology Review

${llmSection}

# Graph Cache

- JSON graph: [[.okf-cache/ontology]]
- Concepts: ${notes.length}
- Objects: ${graph.objects.length}
- Links: ${graph.links.length}
`;
}

function noteToConceptObject(note) {
  return {
    id: conceptIdFor(note),
    type: "Concept",
    properties: {
      title: note.title,
      description: note.description || "",
      path: note.path,
      timestamp: note.timestamp || "",
      confidence: Number(note.confidence || 0.72),
      source_type: note.source_type || note.sourceType || "unknown"
    }
  };
}

function conceptIdFor(note) {
  return `concept:${normalizeId(note.path || note.title)}`;
}

function sourceObjectFor(note) {
  const resource = note.resource || note.source || "";
  if (!resource) return null;
  return {
    id: `source:${normalizeId(resource)}`,
    type: "Source",
    properties: {
      resource,
      source_type: note.source_type || note.sourceType || inferSourceType(resource)
    }
  };
}

function tagObjectFor(name) {
  return {
    id: `tag:${normalizeId(name)}`,
    type: "Tag",
    properties: { name }
  };
}

function extractEntities(note) {
  const text = `${note.title || ""} ${note.description || ""} ${note.body || ""}`;
  const candidates = new Map();
  const patterns = [
    { kind: "Platform", regex: /\b(OpenClaw|Obsidian|Codex|Douyin|Amazon|PaddleOCR|FunASR|Whisper|Palantir|Foundry)\b/gi },
    { kind: "Metric", regex: /\b(ACOS|CVR|CTR|ROI|BSR|conversion|budget|inventory|sales)\b/gi },
    { kind: "DomainTerm", regex: /\b(listing|keyword|campaign|review|store|report|ontology|skill|agent|vault)\b/gi },
    { kind: "ChineseTerm", regex: /[\p{Script=Han}A-Za-z0-9]{3,18}/gu }
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const raw = match[0].trim();
      if (!raw || raw.length < 3) continue;
      const name = normalizeEntityName(raw);
      if (!name || isStopEntity(name)) continue;
      const id = `entity:${normalizeId(name)}`;
      if (!candidates.has(id)) {
        candidates.set(id, {
          id,
          type: "Entity",
          properties: { name, kind: pattern.kind },
          confidence: pattern.kind === "ChineseTerm" ? 0.58 : 0.78
        });
      }
    }
  }
  return [...candidates.values()].slice(0, 24);
}

function analyzeNote(note, index, limits) {
  const tags = normalizedTags(note?.tags).slice(0, limits.maxTagsPerConcept);
  const entities = extractEntities(note || {}).slice(0, limits.maxEntitiesPerConcept);
  const text = `${note?.title || ""} ${note?.description || ""} ${tags.join(" ")} ${note?.body || ""}`;
  const keywords = [...new Set(tokenize(text)
    .filter((token) => token.length > 3 && !isStopEntity(token)))]
    .slice(0, limits.maxKeywordsPerConcept);
  const tagKeys = tags.map((value) => normalizeEntityName(value).toLowerCase());
  const entityKeys = entities.map((entity) => entity.id);
  return {
    index,
    note,
    conceptId: conceptIdFor(note || {}),
    tags,
    entities,
    keywords,
    domains: detectDomains(note || {}),
    tagKeys,
    entityKeys,
    tagSet: new Set(tagKeys),
    entitySet: new Set(entityKeys),
    keywordSet: new Set(keywords),
    entityNameById: new Map(entities.map((entity) => [entity.id, entity.properties.name]))
  };
}

function suggestOntologyLinks(analyses, limits) {
  const indexes = buildCandidateIndexes(analyses);
  const links = [];
  const degree = new Uint16Array(analyses.length);
  const degradedReasons = new Set();
  let candidatePairs = 0;
  let relationshipLimitReached = false;

  for (let index = 0; index < analyses.length; index += 1) {
    if (links.length >= limits.maxRelationships) {
      relationshipLimitReached = true;
      break;
    }
    if (degree[index] >= limits.topK) continue;
    const analysis = analyses[index];
    const candidateIndexes = collectCandidateIndexes(analysis, indexes, limits);
    candidatePairs += candidateIndexes.length;
    const proposals = [];
    for (const candidateIndex of candidateIndexes) {
      const proposal = scoreCandidateRelation(analysis, analyses[candidateIndex]);
      if (proposal) proposals.push(proposal);
    }
    proposals.sort(compareRelationProposals);

    for (const proposal of proposals) {
      if (degree[index] >= limits.topK) break;
      if (degree[proposal.toIndex] >= limits.topK) continue;
      if (links.length >= limits.maxRelationships) {
        relationshipLimitReached = true;
        break;
      }
      links.push(proposal.item);
      degree[index] += 1;
      degree[proposal.toIndex] += 1;
    }
  }

  if (relationshipLimitReached) degradedReasons.add("max_relationships_reached");
  return { links, candidatePairs, degradedReasons: [...degradedReasons] };
}

function buildCandidateIndexes(analyses) {
  const indexes = {
    tags: new Map(),
    entities: new Map(),
    keywords: new Map()
  };
  for (const analysis of analyses) {
    addToInvertedIndex(indexes.tags, analysis.tagKeys, analysis.index);
    addToInvertedIndex(indexes.entities, analysis.entityKeys, analysis.index);
    addToInvertedIndex(indexes.keywords, analysis.keywords, analysis.index);
  }
  return indexes;
}

function addToInvertedIndex(index, keys, noteIndex) {
  for (const key of keys) {
    const postings = index.get(key);
    if (postings) postings.push(noteIndex);
    else index.set(key, [noteIndex]);
  }
}

function collectCandidateIndexes(analysis, indexes, limits) {
  const signals = [];
  appendCandidateSignals(signals, indexes.tags, analysis.tagKeys, 3);
  appendCandidateSignals(signals, indexes.entities, analysis.entityKeys, 2);
  appendCandidateSignals(signals, indexes.keywords, analysis.keywords, 1);
  signals.sort((a, b) => a.postings.length - b.postings.length || b.weight - a.weight || a.key.localeCompare(b.key));

  const candidateVotes = new Map();
  for (const signal of signals) {
    for (const candidateIndex of forwardPostingNeighbors(signal.postings, analysis.index, limits.maxCandidatesPerSignal)) {
      const existing = candidateVotes.get(candidateIndex);
      if (existing !== undefined) {
        candidateVotes.set(candidateIndex, existing + signal.weight);
      } else if (candidateVotes.size < limits.maxCandidatesPerConcept) {
        candidateVotes.set(candidateIndex, signal.weight);
      }
    }
  }
  return [...candidateVotes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([candidateIndex]) => candidateIndex);
}

function appendCandidateSignals(target, index, keys, weight) {
  for (const key of keys) {
    const postings = index.get(key);
    if (postings?.length > 1) target.push({ key, postings, weight });
  }
}

function forwardPostingNeighbors(postings, noteIndex, limit) {
  const position = binarySearch(postings, noteIndex);
  if (position < 0) return [];
  const candidates = [];
  for (let offset = 1; offset <= limit && position + offset < postings.length; offset += 1) {
    candidates.push(postings[position + offset]);
  }
  return candidates;
}

function binarySearch(values, target) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (values[middle] === target) return middle;
    if (values[middle] < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function scoreCandidateRelation(a, b) {
  const sharedTags = intersectValues(a.tagSet, b.tagSet);
  const sharedEntities = intersectValues(a.entitySet, b.entitySet)
    .map((id) => a.entityNameById.get(id) || b.entityNameById.get(id) || id);
  const sharedKeywords = intersectValues(a.keywordSet, b.keywordSet);
  const sharedDomains = intersectValues(a.domains, b.domains);
  const evidence = [...new Set([...sharedTags, ...sharedEntities, ...sharedKeywords])].slice(0, 6);
  const weightedScore = sharedTags.length * 3 + sharedEntities.length * 2 + sharedKeywords.length;
  if (evidence.length >= 2) {
    const confidence = Math.min(0.95, 0.5 + Math.min(7, weightedScore) * 0.06);
    return {
      toIndex: b.index,
      confidence,
      evidenceCount: evidence.length,
      item: link("similar_to", a.conceptId, b.conceptId, { evidence, confidence })
    };
  }
  if (sharedDomains.length) {
    return {
      toIndex: b.index,
      confidence: 0.68,
      evidenceCount: 1,
      item: link("same_domain", a.conceptId, b.conceptId, { evidence: [sharedDomains[0]], confidence: 0.68 })
    };
  }
  return null;
}

function compareRelationProposals(a, b) {
  return b.confidence - a.confidence || b.evidenceCount - a.evidenceCount || a.toIndex - b.toIndex;
}

function intersectValues(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const values = [];
  for (const value of small) {
    if (large.has(value)) values.push(value);
  }
  return values;
}

function suggestActions(notes, entities, links) {
  const actions = [];
  const similarByPair = links.filter((item) => item.type === "similar_to" && item.confidence >= 0.78);
  for (const item of similarByPair.slice(0, 8)) {
    actions.push({
      type: "merge_duplicate_concepts",
      targets: [item.from, item.to],
      description: "High-overlap concepts should be reviewed for duplicate or parent-child consolidation.",
      confidence: item.confidence
    });
  }

  for (const entity of frequentEntities({ objects: [...entities.values()], links }).slice(0, 8)) {
    if (entity.count >= 2) {
      actions.push({
        type: "promote_entity_note",
        targets: [entity.id],
        description: `Promote repeated entity ${entity.name} into a dedicated ontology object note.`,
        confidence: 0.7
      });
    }
  }

  for (const note of notes.filter((item) => !item.description || String(item.description).length < 40).slice(0, 8)) {
    actions.push({
      type: "enrich_ambiguous_concept",
      targets: [conceptIdFor(note)],
      description: "Concept has weak context and should be enriched with web research plus citations.",
      confidence: 0.62
    });
  }

  return actions;
}

function detectDomains(note) {
  const domains = [
    ["amazon", "亚马逊", "listing", "acos", "keyword", "广告"],
    ["openclaw", "codex", "skill", "agent"],
    ["obsidian", "vault", "okf", "ontology"],
    ["douyin", "抖音", "video", "transcription"]
  ];
  const text = `${note.title || ""} ${note.description || ""} ${(note.tags || []).join(" ")}`.toLowerCase();
  return new Set(domains.filter((domain) => domain.some((term) => text.includes(term))).map((domain) => domain[0]));
}

function frequentEntities(graph) {
  const entityById = new Map(graph.objects.filter((object) => object.type === "Entity").map((object) => [object.id, object]));
  const counts = new Map();
  for (const item of graph.links.filter((linkItem) => linkItem.type === "mentions")) {
    counts.set(item.to, (counts.get(item.to) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => {
      const entity = entityById.get(id);
      return entity ? { id, count, name: entity.properties.name, kind: entity.properties.kind } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count);
}

function validateSchema(schema, issues) {
  if (!schema || typeof schema !== "object") {
    issues.push(ontologyIssue("missing_schema", "schema", "Graph must include ontology schema."));
    return;
  }
  validateSchemaSection(schema.objectTypes, OBJECT_TYPES, "objectTypes", issues);
  validateSchemaSection(schema.linkTypes, LINK_TYPES, "linkTypes", issues);
  validateSchemaSection(schema.actionTypes, ACTION_TYPES, "actionTypes", issues);
}

function validateSchemaSection(actual, expected, section, issues) {
  if (!actual || typeof actual !== "object") {
    issues.push(ontologyIssue("missing_schema_section", `schema.${section}`, `Schema must include ${section}.`));
    return;
  }
  for (const [type, expectedSpec] of Object.entries(expected)) {
    const actualSpec = actual[type];
    if (!actualSpec || typeof actualSpec !== "object") {
      issues.push(ontologyIssue("missing_schema_type", `schema.${section}.${type}`, `Schema is missing ${section}.${type}.`));
      continue;
    }
    if (expectedSpec.properties) {
      const properties = Array.isArray(actualSpec.properties) ? actualSpec.properties : [];
      for (const property of expectedSpec.properties) {
        if (!properties.includes(property)) {
          issues.push(ontologyIssue("missing_schema_property", `schema.${section}.${type}.properties`, `${type} is missing property ${property}.`));
        }
      }
    }
    for (const key of ["from", "to"]) {
      if (expectedSpec[key] && actualSpec[key] !== expectedSpec[key]) {
        issues.push(ontologyIssue("schema_type_mismatch", `schema.${section}.${type}.${key}`, `${type}.${key} should be ${expectedSpec[key]}.`));
      }
    }
    if (expectedSpec.inputs) {
      const inputs = Array.isArray(actualSpec.inputs) ? actualSpec.inputs : [];
      if (inputs.join("|") !== expectedSpec.inputs.join("|")) {
        issues.push(ontologyIssue("schema_inputs_mismatch", `schema.${section}.${type}.inputs`, `${type}.inputs should be ${expectedSpec.inputs.join(", ")}.`));
      }
    }
  }
}

function validateObject(object, index, objectById, issues) {
  const pathValue = `objects[${index}]`;
  if (!object || typeof object !== "object") {
    issues.push(ontologyIssue("invalid_object", pathValue, "Ontology object must be an object."));
    return;
  }
  if (!nonEmptyString(object.id)) {
    issues.push(ontologyIssue("missing_object_id", `${pathValue}.id`, "Ontology object requires a non-empty id."));
  } else if (objectById.has(object.id)) {
    issues.push(ontologyIssue("duplicate_object_id", `${pathValue}.id`, `Duplicate object id ${object.id}.`));
  } else {
    objectById.set(object.id, object);
  }
  if (!OBJECT_TYPES[object.type]) {
    issues.push(ontologyIssue("unknown_object_type", `${pathValue}.type`, `Unknown object type ${object.type || ""}.`));
    return;
  }
  if (!object.properties || typeof object.properties !== "object" || Array.isArray(object.properties)) {
    issues.push(ontologyIssue("invalid_object_properties", `${pathValue}.properties`, "Object properties must be an object."));
    return;
  }
  for (const property of OBJECT_TYPES[object.type].properties) {
    const value = object.properties[property];
    if (value === undefined || value === null || value === "") {
      issues.push(ontologyIssue("missing_object_property", `${pathValue}.properties.${property}`, `${object.type} object requires ${property}.`));
    }
  }
  if (object.type === "Concept" && !isConfidence(object.properties.confidence)) {
    issues.push(ontologyIssue("invalid_confidence", `${pathValue}.properties.confidence`, "Concept confidence must be between 0 and 1."));
  }
}

function validateLink(item, index, objectById, issues) {
  const pathValue = `links[${index}]`;
  if (!item || typeof item !== "object") {
    issues.push(ontologyIssue("invalid_link", pathValue, "Ontology link must be an object."));
    return;
  }
  const spec = LINK_TYPES[item.type];
  if (!spec) {
    issues.push(ontologyIssue("unknown_link_type", `${pathValue}.type`, `Unknown link type ${item.type || ""}.`));
    return;
  }
  const from = objectById.get(item.from);
  const to = objectById.get(item.to);
  if (!from) issues.push(ontologyIssue("missing_link_from", `${pathValue}.from`, `Link source object does not exist: ${item.from || ""}.`));
  if (!to) issues.push(ontologyIssue("missing_link_to", `${pathValue}.to`, `Link target object does not exist: ${item.to || ""}.`));
  if (from && from.type !== spec.from) {
    issues.push(ontologyIssue("link_from_type_mismatch", `${pathValue}.from`, `${item.type} source must be ${spec.from}, got ${from.type}.`));
  }
  if (to && to.type !== spec.to) {
    issues.push(ontologyIssue("link_to_type_mismatch", `${pathValue}.to`, `${item.type} target must be ${spec.to}, got ${to.type}.`));
  }
  if (!isConfidence(item.confidence)) {
    issues.push(ontologyIssue("invalid_link_confidence", `${pathValue}.confidence`, "Link confidence must be between 0 and 1."));
  }
  if (!Array.isArray(item.evidence)) {
    issues.push(ontologyIssue("invalid_link_evidence", `${pathValue}.evidence`, "Link evidence must be an array."));
  }
}

function validateAction(action, index, objectById, issues) {
  const pathValue = `actions[${index}]`;
  if (!action || typeof action !== "object") {
    issues.push(ontologyIssue("invalid_action", pathValue, "Ontology action must be an object."));
    return;
  }
  const spec = ACTION_TYPES[action.type];
  if (!spec) {
    issues.push(ontologyIssue("unknown_action_type", `${pathValue}.type`, `Unknown action type ${action.type || ""}.`));
    return;
  }
  if (!Array.isArray(action.targets)) {
    issues.push(ontologyIssue("invalid_action_targets", `${pathValue}.targets`, "Action targets must be an array."));
    return;
  }
  if (action.targets.length < spec.inputs.length) {
    issues.push(ontologyIssue("action_target_count_mismatch", `${pathValue}.targets`, `${action.type} requires targets: ${spec.inputs.join(", ")}.`));
  }
  action.targets.forEach((targetId, targetIndex) => {
    const target = objectById.get(targetId);
    if (!target) {
      issues.push(ontologyIssue("missing_action_target", `${pathValue}.targets[${targetIndex}]`, `Action target does not exist: ${targetId || ""}.`));
      return;
    }
    const expectedType = spec.inputs[Math.min(targetIndex, spec.inputs.length - 1)];
    if (expectedType && target.type !== expectedType) {
      issues.push(ontologyIssue("action_target_type_mismatch", `${pathValue}.targets[${targetIndex}]`, `${action.type} target must be ${expectedType}, got ${target.type}.`));
    }
  });
  if (action.confidence !== undefined && !isConfidence(action.confidence)) {
    issues.push(ontologyIssue("invalid_action_confidence", `${pathValue}.confidence`, "Action confidence must be between 0 and 1."));
  }
  if (!nonEmptyString(action.description)) {
    issues.push(ontologyIssue("missing_action_description", `${pathValue}.description`, "Action requires a description."));
  }
}

function validationResult({ graph, issues }) {
  return {
    ok: issues.length === 0,
    ontologyVersion: graph?.ontology_version || "",
    objects: Array.isArray(graph?.objects) ? graph.objects.length : 0,
    links: Array.isArray(graph?.links) ? graph.links.length : 0,
    actions: Array.isArray(graph?.actions) ? graph.actions.length : 0,
    objectTypes: Object.keys(graph?.schema?.objectTypes || {}),
    linkTypes: Object.keys(graph?.schema?.linkTypes || {}),
    actionTypes: Object.keys(graph?.schema?.actionTypes || {}),
    issues
  };
}

function ontologyIssue(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function neighborhoodText({ links, objectById, adjacency }, objectId) {
  const linkIndexes = adjacency.byConcept[objectId] || [];
  const parts = [];
  for (const linkIndex of linkIndexes) {
    const item = links[linkIndex];
    if (!item) continue;
    const other = objectById.get(item.from === objectId ? item.to : item.from);
    parts.push(`${item.type} ${other?.properties?.title || other?.properties?.name || other?.properties?.resource || ""} ${(item.evidence || []).join(" ")}`);
  }
  return parts.join(" ");
}

function buildOntologyAdjacency(links, objects = []) {
  const byConcept = Object.create(null);
  for (let index = 0; index < links.length; index += 1) {
    const item = links[index];
    if (String(item?.from || "").startsWith("concept:")) addAdjacencyIndex(byConcept, item.from, index);
    if (item?.to !== item?.from && String(item?.to || "").startsWith("concept:")) addAdjacencyIndex(byConcept, item.to, index);
  }
  if (!objects.length) return { version: 1, byConcept };

  const objectById = new Map(objects.map((object, objectIndex) => [object.id, { object, objectIndex }]));
  const conceptObjectIndexes = [];
  const tokenIndex = Object.create(null);
  for (let objectIndex = 0; objectIndex < objects.length; objectIndex += 1) {
    const object = objects[objectIndex];
    if (object.type !== "Concept") continue;
    const ordinal = conceptObjectIndexes.length;
    conceptObjectIndexes.push(objectIndex);
    const parts = [object.properties.title, object.properties.description];
    for (const linkIndex of byConcept[object.id] || []) {
      const item = links[linkIndex];
      if (!item) continue;
      const otherId = item.from === object.id ? item.to : item.from;
      const other = objectById.get(otherId)?.object;
      parts.push(item.type, other?.properties?.title, other?.properties?.name, other?.properties?.resource, ...(item.evidence || []));
    }
    const counts = countTokens(tokenize(parts.filter(Boolean).join(" ")));
    for (const [token, count] of counts) {
      if (tokenIndex[token]) tokenIndex[token].push(ordinal, count);
      else tokenIndex[token] = [ordinal, count];
    }
  }
  return { version: 2, byConcept, conceptObjectIndexes, tokenIndex };
}

function addAdjacencyIndex(adjacency, objectId, linkIndex) {
  if (adjacency[objectId]) adjacency[objectId].push(linkIndex);
  else adjacency[objectId] = [linkIndex];
}

function usableAdjacency(adjacency) {
  return (adjacency?.version === 1 || adjacency?.version === 2) && adjacency.byConcept && typeof adjacency.byConcept === "object";
}

function usableRecallIndex(adjacency) {
  return adjacency?.version === 2
    && Array.isArray(adjacency.conceptObjectIndexes)
    && adjacency.tokenIndex
    && typeof adjacency.tokenIndex === "object";
}

function rankFromOntologyRecallIndex(objects, adjacency, tokens, limit) {
  const scores = new Map();
  for (const token of tokens) {
    const postings = adjacency.tokenIndex[token] || [];
    for (let index = 0; index < postings.length; index += 2) {
      const ordinal = postings[index];
      scores.set(ordinal, (scores.get(ordinal) || 0) + postings[index + 1]);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([ordinal, score]) => {
      const object = objects[adjacency.conceptObjectIndexes[ordinal]];
      return {
        id: object.id,
        type: object.type,
        score,
        title: object.properties.title,
        description: object.properties.description,
        path: object.properties.path
      };
    });
}

function wikilink(graph, id) {
  const object = graph.objects.find((item) => item.id === id);
  if (!object) return id;
  if (object.type === "Concept") {
    return `[[${object.properties.path.replace(/\.md$/, "")}|${object.properties.title}]]`;
  }
  return object.properties.name || object.properties.resource || id;
}

function link(type, from, to, { evidence = [], confidence = 0.6 } = {}) {
  return { type, from, to, evidence: Array.isArray(evidence) ? evidence : [evidence], confidence };
}

function dedupeLinks(links) {
  const seen = new Map();
  for (const item of links) {
    const key = [item.type, item.from, item.to].join("|");
    const existing = seen.get(key);
    if (!existing || item.confidence > existing.confidence) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

function pushLinkWithinLimit(links, item, maxLinks, degradedReasons) {
  if (links.length >= maxLinks) {
    degradedReasons.add("max_links_reached");
    return false;
  }
  links.push(item);
  return true;
}

function resolveOntologyLimits(noteCount, options) {
  const topK = boundedInteger(options.topK, DEFAULT_ONTOLOGY_LIMITS.topK, 1, 100);
  const candidateMultiplier = boundedInteger(options.candidateMultiplier, DEFAULT_ONTOLOGY_LIMITS.candidateMultiplier, 1, 20);
  const maxTagsPerConcept = boundedInteger(options.maxTagsPerConcept, DEFAULT_ONTOLOGY_LIMITS.maxTagsPerConcept, 1, 64);
  const maxEntitiesPerConcept = boundedInteger(options.maxEntitiesPerConcept, DEFAULT_ONTOLOGY_LIMITS.maxEntitiesPerConcept, 1, 64);
  const maxKeywordsPerConcept = boundedInteger(options.maxKeywordsPerConcept, DEFAULT_ONTOLOGY_LIMITS.maxKeywordsPerConcept, 2, 128);
  const maxCandidatesPerSignal = boundedInteger(options.maxCandidatesPerSignal, DEFAULT_ONTOLOGY_LIMITS.maxCandidatesPerSignal, 1, 64);
  const defaultMaxRelationships = Math.ceil(noteCount * topK / 2);
  const maxRelationships = boundedInteger(options.maxRelationships, defaultMaxRelationships, 0, Math.max(defaultMaxRelationships, noteCount * 100));
  const defaultMaxLinks = Math.max(1000, noteCount * (1 + maxTagsPerConcept + maxEntitiesPerConcept) + maxRelationships);
  const maxLinks = boundedInteger(options.maxLinks, defaultMaxLinks, 0, Math.max(defaultMaxLinks, noteCount * 256, 1000));
  return {
    topK,
    candidateMultiplier,
    maxCandidatesPerConcept: topK * candidateMultiplier,
    maxCandidatesPerSignal,
    maxTagsPerConcept,
    maxEntitiesPerConcept,
    maxKeywordsPerConcept,
    maxRelationships,
    maxLinks
  };
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizedTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").trim()).filter(Boolean))];
}

function normalizeEntityName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "unknown";
}

function inferSourceType(resource) {
  const ext = path.extname(String(resource || "")).replace(".", "").toLowerCase();
  if (["mp4", "mov", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (/^https?:/i.test(resource)) return "url";
  return "unknown";
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function isStopEntity(value) {
  const normalized = String(value || "").toLowerCase();
  return new Set([
    "this", "that", "with", "from", "into", "able", "should", "later", "before", "after",
    "their", "there", "these", "those", "and", "the", "for", "一个", "可以", "通过", "内容",
    "自己", "然后", "最后", "主要", "因为", "这个", "那个"
  ]).has(normalized);
}
