import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "./state.mjs";
import { entries, isDirectory, isFile, readJson, relativePath, safeRepositoryPath } from "./fs-utils.mjs";
import { writeJsonAtomically, writeTextAtomically } from "./files.mjs";
import { buildCatalog, loadStructuredClips, generatedReferenceDescription } from "./catalog.mjs";
import { assertH3PromptFormat, h3RequiresFirstFrameContinuity, withH3FirstFrameContinuity, resolveCatalogClip, resolveCatalogReference } from "./comfy.mjs";
import { httpError } from "./http.mjs";
import { normalizedReferenceSlug } from "./agent.mjs";

export function requiredSlug(value, label = "slug") {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw httpError(`${label} must contain lowercase letters, numbers, and single hyphens only.`, 400);
  }
  return slug;
}

export function markdownDocument(title, summary = "") {
  const heading = String(title || "Untitled").trim().replace(/[\r\n]+/g, " ");
  const body = String(summary || "").trim();
  return `# ${heading}\n${body ? `\n${body}\n` : ""}`;
}

export function resolveCatalogStory(payload) {
  const catalog = buildCatalog();
  const story = catalog.stories.find((candidate) => candidate.id === String(payload.story_id || ""));
  if (!story) throw httpError("Unknown story_id.", 404);
  return { catalog, story, storyDirectory: safeRepositoryPath(story.path) };
}

export function resolveCatalogEpisode(payload) {
  const target = resolveCatalogStory(payload);
  const episode = target.story.episodes.find((candidate) => candidate.id === String(payload.episode_id || ""));
  if (!episode) throw httpError("Unknown episode_id.", 404);
  return { ...target, episode, episodeDirectory: safeRepositoryPath(episode.path) };
}

export function assertContainedPath(base, value, label) {
  if (typeof value !== "string" || !value.trim()) throw httpError(`${label} must be a non-empty path.`, 400);
  if (isAbsolute(value)) throw httpError(`${label} must be relative.`, 400);
  const candidate = resolve(base, value);
  const rel = relative(base, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw httpError(`${label} must stay inside its declared base directory.`, 400);
  return candidate;
}

export function validateStructuredClipPayload(candidate, original, storyDirectory, episodeDirectory) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw httpError("Clip payload must be an object.", 400);
  const allowed = new Set([
    "$schema", "schema_version", "clip_id", "sequence", "title", "path_base", "generation_mode",
    "duration_seconds", "video_prompt", "first_frame_image_prompt", "post_production_instructions", "references", "outputs",
  ]);
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) throw httpError(`Unsupported clip field: ${key}`, 400);
  if (candidate.schema_version !== 1) throw httpError("schema_version must be 1.", 400);
  if (!/^clip-[0-9]{2,}$/.test(String(candidate.clip_id || ""))) throw httpError("clip_id must match clip-XX.", 400);
  if (original && candidate.clip_id !== original.clip_id) throw httpError("clip_id is stable and cannot be changed after creation.", 400);
  if (!Number.isInteger(candidate.sequence) || candidate.sequence < 1) throw httpError("sequence must be a positive integer.", 400);
  if (original && candidate.sequence !== original.sequence) throw httpError("Use the move controls to change clip sequence.", 400);
  if (!String(candidate.title || "").trim()) throw httpError("Clip title is required.", 400);
  if (!["story", "episode", "repository"].includes(candidate.path_base)) throw httpError("path_base must be story, episode, or repository.", 400);
  if (!["ref2va", "i2va", "post"].includes(String(candidate.generation_mode || "").trim())) {
    throw httpError("generation_mode must be ref2va, i2va, or post.", 400);
  }
  const duration = Number(candidate.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15) throw httpError("duration_seconds must be greater than 0 and no more than 15.", 400);
  if (!Array.isArray(candidate.references)) throw httpError("references must be an array.", 400);
  if (!candidate.outputs || typeof candidate.outputs !== "object" || Array.isArray(candidate.outputs) || !Object.keys(candidate.outputs).length) {
    throw httpError("outputs must be a non-empty object.", 400);
  }
  if (candidate.generation_mode === "post") {
    if (candidate.video_prompt !== null) throw httpError("Post-production clips must use video_prompt: null.", 400);
  } else if (typeof candidate.video_prompt !== "string" || !candidate.video_prompt.trim()) {
    throw httpError("Generated clips require a video_prompt.", 400);
  }
  if (candidate.first_frame_image_prompt !== null && typeof candidate.first_frame_image_prompt !== "string") {
    throw httpError("first_frame_image_prompt must be text or null.", 400);
  }
  if (candidate.post_production_instructions !== null && typeof candidate.post_production_instructions !== "string") {
    throw httpError("post_production_instructions must be text or null.", 400);
  }
  const baseDirectory = candidate.path_base === "episode"
    ? episodeDirectory
    : candidate.path_base === "repository"
      ? env.repositoryRoot
      : storyDirectory;
  const pictureNumbers = [];
  for (const [index, reference] of candidate.references.entries()) {
    if (!reference || typeof reference !== "object") throw httpError(`references[${index}] must be an object.`, 400);
    if (reference.picture !== null && (!Number.isInteger(reference.picture) || reference.picture < 1)) {
      throw httpError(`references[${index}].picture must be a positive integer or null.`, 400);
    }
    if (Number.isInteger(reference.picture)) pictureNumbers.push(reference.picture);
    requiredSlug(reference.id, `references[${index}].id`);
    if (!String(reference.role || "").trim() || !String(reference.description || "").trim()) {
      throw httpError(`references[${index}] requires role and description.`, 400);
    }
    const source = reference.source;
    if (!source || typeof source !== "object") throw httpError(`references[${index}].source is required.`, 400);
    if (source.type === "file") {
      assertContainedPath(baseDirectory, source.path, `references[${index}].source.path`);
      if (source.prompt_path) assertContainedPath(baseDirectory, source.prompt_path, `references[${index}].source.prompt_path`);
    } else if (source.type === "clip_artifact") {
      if (!/^clip-[0-9]{2,}$/.test(String(source.clip_id || "")) || !String(source.artifact || "").trim()) {
        throw httpError(`references[${index}] has an invalid clip_artifact source.`, 400);
      }
    } else {
      throw httpError(`references[${index}] has an unsupported source.type.`, 400);
    }
  }
  const expectedPictures = Array.from({ length: pictureNumbers.length }, (_, index) => index + 1);
  if (JSON.stringify(pictureNumbers) !== JSON.stringify(expectedPictures)) {
    throw httpError("Reference picture sockets must be consecutive and stored in order.", 400);
  }
  if (pictureNumbers.length > 9) throw httpError("MiniMax H3 supports at most 9 image references.", 400);
  if (candidate.generation_mode !== "post") {
    const usedPictures = [...new Set([...candidate.video_prompt.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    if (JSON.stringify(usedPictures) !== JSON.stringify(pictureNumbers)) {
      throw httpError(`Prompt picture tags ${JSON.stringify(usedPictures)} do not match reference sockets ${JSON.stringify(pictureNumbers)}.`, 400);
    }
    const continuityRequired = h3RequiresFirstFrameContinuity(candidate.references, candidate.generation_mode);
    assertH3PromptFormat(candidate.video_prompt, candidate.generation_mode, continuityRequired);
  }
  for (const [name, output] of Object.entries(candidate.outputs)) {
    if (!output || typeof output !== "object" || !String(output.artifact_id || "").trim()) {
      throw httpError(`outputs.${name} requires path and artifact_id.`, 400);
    }
    assertContainedPath(baseDirectory, output.path, `outputs.${name}.path`);
  }
  return JSON.parse(JSON.stringify({ ...candidate, duration_seconds: duration }));
}

export function structuredRecords(episodeDirectory) {
  const loaded = loadStructuredClips(episodeDirectory);
  return [...loaded.byId.values()].sort((left, right) => left.payload.sequence - right.payload.sequence);
}

export function saveClipSequences(records) {
  records.forEach((record, index) => {
    const sequence = index + 1;
    if (record.payload.sequence === sequence && isFile(record.path)) return;
    record.payload.sequence = sequence;
    writeJsonAtomically(record.path, record.payload);
  });
}

export function createStoryContent(payload) {
  const slug = requiredSlug(payload.slug, "Story slug");
  const title = String(payload.title || "").trim();
  if (!title) throw httpError("Story title is required.", 400);
  const storyDirectory = resolve(env.repositoryRoot, slug);
  if (isDirectory(storyDirectory) || isFile(storyDirectory)) throw httpError("A repository entry already uses this story slug.", 409);
  mkdirSync(storyDirectory, { recursive: false });
  for (const path of [
    "characters/prompts", "characters/images",
    "environments/prompts", "environments/images",
    "objects/prompts", "objects/images",
  ]) mkdirSync(join(storyDirectory, path), { recursive: true });
  writeTextAtomically(join(storyDirectory, "outline.md"), markdownDocument(title, payload.summary));
  return { story_id: slug, path: relativePath(storyDirectory) };
}

export function updateStoryContent(payload) {
  const target = resolveCatalogStory(payload);
  const outlinePath = target.story.outline_path
    ? safeRepositoryPath(target.story.outline_path)
    : join(target.storyDirectory, "outline.md");
  const outline = String(payload.outline_text ?? "");
  if (!outline.trim()) throw httpError("Story outline cannot be empty.", 400);
  writeTextAtomically(outlinePath, outline.endsWith("\n") ? outline : `${outline}\n`);
  return { story_id: target.story.id, outline_path: relativePath(outlinePath) };
}

export function createEpisodeContent(payload) {
  const target = resolveCatalogStory(payload);
  const highest = Math.max(0, ...(target.story.episodes || []).map((episode) => Number(episode.number) || 0));
  const number = highest + 1;
  const episodeId = `episode-${String(number).padStart(2, "0")}`;
  const episodeDirectory = join(target.storyDirectory, episodeId);
  if (isDirectory(episodeDirectory) || isFile(episodeDirectory)) throw httpError("The next episode directory already exists.", 409);
  mkdirSync(episodeDirectory, { recursive: false });
  for (const path of ["reference-images/prompts", "reference-images/generated", "generated/clips", "generated/frames"]) {
    mkdirSync(join(episodeDirectory, path), { recursive: true });
  }
  const title = String(payload.title || `Episode ${String(number).padStart(2, "0")}`).trim();
  writeTextAtomically(join(episodeDirectory, "outline.md"), markdownDocument(title, payload.summary));
  return { story_id: target.story.id, episode_id: episodeId, path: relativePath(episodeDirectory) };
}

export function updateEpisodeContent(payload) {
  const target = resolveCatalogEpisode(payload);
  const outlinePath = target.episode.outline_path
    ? safeRepositoryPath(target.episode.outline_path)
    : join(target.episodeDirectory, "outline.md");
  const outline = String(payload.outline_text ?? "");
  if (!outline.trim()) throw httpError("Episode outline cannot be empty.", 400);
  writeTextAtomically(outlinePath, outline.endsWith("\n") ? outline : `${outline}\n`);
  return { story_id: target.story.id, episode_id: target.episode.id, outline_path: relativePath(outlinePath) };
}

export function manualClipReferences(target, records, insertionIndex, mode, payload) {
  const requestedIds = Array.isArray(payload.reference_ids)
    ? payload.reference_ids.map((value) => String(value)).filter(Boolean)
    : [];
  if (new Set(requestedIds).size !== requestedIds.length) throw httpError("Reference images must be selected only once.", 400);
  const usePreviousFrame = payload.use_previous_frame === true;
  const previousClipId = insertionIndex > 0 ? records[insertionIndex - 1]?.payload.clip_id || null : null;
  if (usePreviousFrame && !previousClipId) {
    throw httpError("This insertion position has no preceding clip whose last frame can be referenced.", 400);
  }
  const availableReferences = [...(target.story.references || []), ...(target.episode.references || [])];
  const referenceById = new Map(availableReferences.map((reference) => [reference.id, reference]));
  const selectedReferences = requestedIds.map((referenceId) => {
    const reference = referenceById.get(referenceId);
    if (!reference) throw httpError(`Unknown reference image selection: ${referenceId}`, 400);
    return reference;
  });
  const inputCount = (usePreviousFrame ? 1 : 0) + selectedReferences.length;
  if (inputCount > 9) throw httpError("MiniMax H3 supports at most 9 image inputs per clip.", 400);
  if (mode === "i2va" && inputCount !== 1) {
    throw httpError("I2VA manual clips require exactly one image input: either the preceding clip's last frame or one selected reference image.", 400);
  }
  if (mode === "ref2va" && inputCount < 1) {
    throw httpError("Ref2VA manual clips require at least one selected reference image or the preceding clip's last frame.", 400);
  }

  const references = [];
  let nextPicture = 1;
  if (usePreviousFrame) {
    references.push({
      picture: mode === "post" ? null : nextPicture++,
      id: "previous-clip-last-frame",
      role: "first_frame_anchor",
      description: `Final frame from ${previousClipId} for visual continuity`,
      source: { type: "clip_artifact", clip_id: previousClipId, artifact: "last_frame" },
    });
  }
  const usedSlugs = new Set(references.map((reference) => reference.id));
  for (const [index, reference] of selectedReferences.entries()) {
    let id = normalizedReferenceSlug(reference.slug, `reference-${index + 1}`);
    let suffix = 2;
    while (usedSlugs.has(id)) id = `${normalizedReferenceSlug(reference.slug, "reference").slice(0, 64)}-${suffix++}`;
    usedSlugs.add(id);
    references.push({
      picture: mode === "post" ? null : nextPicture++,
      id,
      role: reference.kind || "visual_reference",
      description: generatedReferenceDescription(reference),
      source: {
        type: "file",
        path: relative(target.storyDirectory, safeRepositoryPath(reference.generation_path)).split(sep).join("/"),
        prompt_path: relative(target.storyDirectory, safeRepositoryPath(reference.prompt_path)).split(sep).join("/"),
      },
    });
  }
  return references;
}

export function manualClipPlaceholderPrompt(mode, references) {
  const pictures = references.filter((reference) => Number.isInteger(reference.picture));
  if (mode === "ref2va") {
    const definitions = pictures.map((reference) => `<Picture ${reference.picture}> is the selected ${reference.role} reference for [Shot 1]: ${reference.description}.`);
    const retention = pictures.map((reference) => `<Picture ${reference.picture}> ([Shot 1] reference): fully_preserved - preserve the selected visual identity and relevant visible details.`);
    const pictureUse = pictures.map((reference) => `<Picture ${reference.picture}>`).join(", ");
    return withH3FirstFrameContinuity([
      "subject_definitions:",
      ...definitions,
      "",
      "summary:",
      `[reference generation] Create the target clip using ${pictureUse}.`,
      "",
      "retention_analysis:",
      ...retention,
      "",
      "detailed_description:",
      `[Shot 1] Begin from and preserve the declared visual information in ${pictureUse}; replace this placeholder with the intended action, composition, camera movement, dialogue, and timing before generation.`,
      "",
      "overall_soundscape:",
      "Describe ambience and physical sound effects here.",
      "",
      "non_diegetic_music:",
      "N/A",
    ].join("\n"), h3RequiresFirstFrameContinuity(references, mode));
  }
  return withH3FirstFrameContinuity([
    "integrated_multimodal_description:",
    "[Shot 1] Begin from the complete visible state of <Picture 1> at 0.00 seconds; replace this placeholder with the intended continuous action, composition, camera movement, dialogue, and timing before generation.",
    "",
    "overall_soundscape:",
    "Describe ambience and physical sound effects here.",
    "",
    "non_diegetic_music:",
    "N/A",
  ].join("\n"), true);
}

export function createClipContent(payload) {
  const target = resolveCatalogEpisode(payload);
  const records = structuredRecords(target.episodeDirectory);
  const mode = String(payload.generation_mode || "ref2va").trim();
  if (!["ref2va", "i2va", "post"].includes(mode)) throw httpError("New clips must use ref2va, i2va, or post mode.", 400);
  const duration = Number(payload.duration_seconds ?? 10);
  const numericIds = records.map((record) => Number(String(record.payload.clip_id).match(/\d+/)?.[0])).filter(Number.isFinite);
  const clipId = `clip-${String(Math.max(0, ...numericIds) + 1).padStart(2, "0")}`;
  const position = String(payload.position || "end");
  let insertionIndex = records.length;
  if (position === "start") insertionIndex = 0;
  else if (position === "before" || position === "after") {
    const anchorIndex = records.findIndex((record) => record.payload.clip_id === String(payload.anchor_clip_id || ""));
    if (anchorIndex < 0) throw httpError("The selected anchor clip does not exist.", 404);
    insertionIndex = position === "before" ? anchorIndex : anchorIndex + 1;
  } else if (position !== "end") throw httpError("position must be start, end, before, or after.", 400);
  const episodeRelative = relative(target.storyDirectory, target.episodeDirectory).split(sep).join("/");
  const references = manualClipReferences(target, records, insertionIndex, mode, payload);
  const suppliedPrompt = String(payload.video_prompt || "").trim();
  const generatedPrompt = mode === "post"
    ? null
    : suppliedPrompt
      ? withH3FirstFrameContinuity(suppliedPrompt, h3RequiresFirstFrameContinuity(references, mode))
      : manualClipPlaceholderPrompt(mode, references);
  const clipPayload = {
    $schema: "../../AITurboShow/schemas/clip.schema.json",
    schema_version: 1,
    clip_id: clipId,
    sequence: insertionIndex + 1,
    title: String(payload.title || `New clip ${clipId}`).trim(),
    path_base: "story",
    generation_mode: mode,
    duration_seconds: duration,
    video_prompt: generatedPrompt,
    first_frame_image_prompt: null,
    post_production_instructions: mode === "post" ? String(payload.post_production_instructions || "Describe the post-production work here.") : null,
    references,
    outputs: {
      video: { path: `${episodeRelative}/generated/clips/${clipId}.mp4`, artifact_id: `${clipId}:video` },
      last_frame: { path: `${episodeRelative}/generated/frames/${clipId}-last.png`, artifact_id: `${clipId}:last_frame` },
    },
  };
  validateStructuredClipPayload(clipPayload, null, target.storyDirectory, target.episodeDirectory);
  const newRecord = { path: join(target.episodeDirectory, `${clipId}.json`), payload: clipPayload };
  records.splice(insertionIndex, 0, newRecord);
  saveClipSequences(records);
  return { story_id: target.story.id, episode_id: target.episode.id, clip_id: clipId, sequence: insertionIndex + 1 };
}

export function updateClipContent(payload) {
  const target = resolveCatalogClip(payload);
  const path = safeRepositoryPath(target.clip.structured_path);
  const original = readJson(path);
  if (!original) throw httpError("The structured clip file could not be read.", 400);
  const updated = validateStructuredClipPayload(payload.clip, original, target.storyDirectory, target.episodeDirectory);
  writeJsonAtomically(path, updated);
  return { story_id: target.story.id, episode_id: target.episode.id, clip_id: updated.clip_id, sequence: updated.sequence };
}

export function moveClipContent(payload) {
  const target = resolveCatalogEpisode(payload);
  const records = structuredRecords(target.episodeDirectory);
  const index = records.findIndex((record) => record.payload.clip_id === String(payload.clip_id || ""));
  if (index < 0) throw httpError("Unknown structured clip.", 404);
  const direction = String(payload.direction || "");
  let destination;
  if (direction === "earlier") destination = Math.max(0, index - 1);
  else if (direction === "later") destination = Math.min(records.length - 1, index + 1);
  else if (direction === "start") destination = 0;
  else if (direction === "end") destination = records.length - 1;
  else throw httpError("direction must be earlier, later, start, or end.", 400);
  if (destination !== index) {
    const [record] = records.splice(index, 1);
    records.splice(destination, 0, record);
    records.forEach((record, recordIndex) => { record.payload.sequence = recordIndex + 1; });
    records.forEach((record) => writeJsonAtomically(record.path, record.payload));
  }
  const moved = records.find((record) => record.payload.clip_id === String(payload.clip_id));
  return { story_id: target.story.id, episode_id: target.episode.id, clip_id: moved.payload.clip_id, sequence: moved.payload.sequence };
}

export function createReferenceContent(payload) {
  const target = payload.scope === "episode" ? resolveCatalogEpisode(payload) : resolveCatalogStory(payload);
  const scope = payload.scope === "episode" ? "episode" : "story";
  const slug = requiredSlug(payload.slug, "Reference slug");
  let base;
  let kind;
  if (scope === "episode") {
    base = join(target.episodeDirectory, "reference-images");
    kind = "episode reference";
  } else {
    const directoryByKind = { character: "characters", environment: "environments", object: "objects" };
    kind = String(payload.kind || "");
    if (!directoryByKind[kind]) throw httpError("Story reference kind must be character, environment, or object.", 400);
    base = join(target.storyDirectory, directoryByKind[kind]);
  }
  const promptDirectory = join(base, "prompts");
  const imageDirectory = scope === "episode" ? join(base, "generated") : join(base, "images");
  mkdirSync(promptDirectory, { recursive: true });
  mkdirSync(imageDirectory, { recursive: true });
  const promptPath = join(promptDirectory, `${slug}.prompt`);
  if (isFile(promptPath)) throw httpError("A reference prompt already uses this slug.", 409);
  const prompt = String(payload.prompt_text || "").trim();
  if (!prompt) throw httpError("Reference prompt is required.", 400);
  writeTextAtomically(promptPath, `${prompt}\n`);
  return {
    story_id: target.story.id,
    episode_id: target.episode?.id || null,
    reference_id: `${scope}:${kind}:${slug}`,
    prompt_path: relativePath(promptPath),
    generation_path: relativePath(join(imageDirectory, `${slug}.png`)),
  };
}

export function updateReferenceContent(payload) {
  const target = resolveCatalogReference(payload, { requireGeneration: false });
  const promptPath = safeRepositoryPath(target.reference.prompt_path);
  const prompt = String(payload.prompt_text || "").trim();
  if (!prompt) throw httpError("Reference prompt cannot be empty.", 400);
  writeTextAtomically(promptPath, `${prompt}\n`);
  return {
    story_id: target.story.id,
    episode_id: target.episode?.id || null,
    reference_id: target.reference.id,
    prompt_path: target.reference.prompt_path,
  };
}
