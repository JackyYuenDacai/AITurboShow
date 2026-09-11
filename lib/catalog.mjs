import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "./state.mjs";
import { isFile, isDirectory, entries, walk, relativePath, safeRepositoryPath, readText, readJson } from "./fs-utils.mjs";
import { imageExtensions, videoExtensions, uploadImageExtensions, collator, episodePattern, clipFilePattern, scenePromptPattern } from "./constants.mjs";

export function firstHeading(text, fallback) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) return trimmed.slice(2).trim();
  }
  return fallback;
}

export function plainExcerpt(text, limit = 220) {
  const selected = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("|")) continue;
    if (/^(?:-|\d+\.)\s/.test(trimmed)) continue;
    selected.push(trimmed.replaceAll("**", "").replaceAll("`", ""));
    if (selected.join(" ").length >= limit) break;
  }
  const result = selected.join(" ");
  return result.length <= limit ? result : `${result.slice(0, limit - 1).trim()}…`;
}

export function sortPaths(paths) {
  return paths.sort((left, right) => collator.compare(basename(left), basename(right)));
}

export function assetRecord(path) {
  const relativeValue = relativePath(path);
  const stats = statSync(path);
  return {
    name: basename(path),
    path: relativeValue,
    url: `/api/asset?path=${encodeURIComponent(relativeValue)}&v=${Math.round(stats.mtimeMs)}`,
    extension: extname(path).toLowerCase(),
    size: stats.size,
  };
}

export function imageCandidates(directory, stem) {
  if (!isDirectory(directory)) return [];
  const normalizedStem = stem.toLowerCase().replaceAll("_", "-");
  return sortPaths(walk(directory).filter((path) => {
    if (!imageExtensions.has(extname(path).toLowerCase())) return false;
    const candidate = basename(path, extname(path)).toLowerCase().replaceAll("_", "-");
    return candidate === normalizedStem || candidate.includes(normalizedStem) || normalizedStem.includes(candidate);
  }));
}

export function scanReferenceGroup(base, kind, scope) {
  const promptDirectory = join(base, "prompts");
  if (!isDirectory(promptDirectory)) return [];
  return entries(promptDirectory)
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".prompt")
    .sort((a, b) => collator.compare(a.name, b.name))
    .map((entry) => {
      const promptPath = join(promptDirectory, entry.name);
      const slug = basename(entry.name, extname(entry.name));
      const images = imageCandidates(base, slug).map(assetRecord);
      const generationDirectory = scope === "episode" ? join(base, "generated") : join(base, "images");
      const generationPath = join(generationDirectory, `${slug}.png`);
      return {
        id: `${scope}:${kind}:${slug}`,
        name: slug.replaceAll("-", " ").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
        slug,
        kind,
        scope,
        prompt_path: relativePath(promptPath),
        prompt_text: readText(promptPath),
        images,
        ready: images.length > 0,
        generation_path: relativePath(generationPath),
        upload_path: relativePath(generationPath),
        upload_ready: isFile(generationPath),
      };
    });
}

export function scanStoryReferences(storyDirectory) {
  return [
    ...scanReferenceGroup(join(storyDirectory, "characters"), "character", "story"),
    ...scanReferenceGroup(join(storyDirectory, "environments"), "environment", "story"),
    ...scanReferenceGroup(join(storyDirectory, "objects"), "object", "story"),
  ];
}

export function scanEpisodeReferences(episodeDirectory) {
  return scanReferenceGroup(join(episodeDirectory, "reference-images"), "episode reference", "episode");
}

export function referencePathKey(value) {
  if (!value) return null;
  const key = resolve(env.repositoryRoot, value).split(sep).join("/");
  return sep === "\\" ? key.toLowerCase() : key;
}

export function indexedReferencePaths(reference) {
  // Preview discovery permits loose filename matches; library identity must not.
  const normalized = (value) => String(value).toLowerCase().replaceAll("_", "-");
  return [reference.generation_path, reference.upload_path, ...(reference.images || [])
    .filter((image) => normalized(basename(image.path, extname(image.path))) === normalized(reference.slug))
    .map((image) => image.path)].filter(Boolean);
}

export function inferredReferencePrompt(imagePath, libraries) {
  const image = safeRepositoryPath(imagePath);
  const stem = basename(image, extname(image));
  const siblingPaths = [join(dirname(image), `${stem}.prompt`), join(dirname(dirname(image)), "prompts", `${stem}.prompt`)];
  const exact = [...new Set(siblingPaths.filter((path) => {
    const rel = relative(env.repositoryRoot, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && readText(path).trim();
  }).map(relativePath))];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const normalizedStem = (value) => value.toLowerCase().replaceAll("_", "-")
    .replace(/^(?:char|character|scene|env|environment|obj|object)-/, "")
    .replace(/-(?:turnaround|reference|ref)$/, "");
  const family = referencePathKey(relativePath(dirname(dirname(image))));
  const matches = libraries.filter((reference) => reference.prompt_text?.trim()
    && normalizedStem(reference.slug) === normalizedStem(stem)
    && referencePathKey(relativePath(dirname(dirname(safeRepositoryPath(reference.prompt_path))))) === family);
  const paths = [...new Set(matches.map((reference) => reference.prompt_path))];
  return paths.length === 1 ? paths[0] : null;
}

export function discoverClipReferences(storyDirectory, episodeDirectory, structuredClips, storyReferences, episodeReferences) {
  const libraries = [...storyReferences, ...episodeReferences];
  const pathInRepository = (base, value, extensions) => {
    if (!value || typeof value !== "string") return null;
    const candidate = resolve(base, value.replaceAll("\\", "/"));
    const rel = relative(env.repositoryRoot, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !extensions.has(extname(candidate).toLowerCase())) return null;
    return relativePath(candidate);
  };
  for (const record of [...structuredClips.byId.values()].sort((a, b) => Number(a.payload.sequence) - Number(b.payload.sequence))) {
    for (const entry of record.payload.references || []) {
      // Previous-frame artifacts retain their dependency relationship in the clip graph.
      if (entry?.source?.type !== "file") continue;
      const base = clipPathBase(record, storyDirectory, episodeDirectory);
      const imagePath = pathInRepository(base, entry.source.path, imageExtensions);
      if (!imagePath) continue;
      const imageKey = referencePathKey(imagePath);
      const declaredPrompt = pathInRepository(base, entry.source.prompt_path, new Set([".prompt", ".txt", ".md"]));
      const slug = `clip-ref-${createHash("sha256").update(imageKey).digest("hex").slice(0, 12)}`;
      const fallbackPrompt = relativePath(join(episodeDirectory, "reference-images", "prompts", `${slug}.prompt`));
      const promptPath = declaredPrompt || fallbackPrompt;
      let reference = libraries.find((item) => indexedReferencePaths(item).some((path) => referencePathKey(path) === imageKey));
      // A saved prompt for an auto-discovered reference must keep its original destination.
      if (!reference && !declaredPrompt) reference = episodeReferences.find((item) => referencePathKey(item.prompt_path) === referencePathKey(fallbackPrompt));
      if (!reference && declaredPrompt) {
        reference = episodeReferences.find((item) => referencePathKey(item.prompt_path) === referencePathKey(declaredPrompt) && !item.images.length && !item.used_by?.length);
        if (reference) {
          reference.generation_path = imagePath;
          reference.upload_path = uploadImageExtensions.has(extname(imagePath).toLowerCase()) ? imagePath : null;
        }
      }
      if (!reference) {
        reference = {
          id: `episode:episode reference:${slug}`, slug,
          name: cleanReferenceDescription(entry.description || entry.id || basename(imagePath, extname(imagePath))),
          kind: "episode reference", scope: "episode", images: [],
          prompt_path: promptPath, prompt_text: readText(safeRepositoryPath(promptPath)),
          generation_path: imagePath, upload_path: uploadImageExtensions.has(extname(imagePath).toLowerCase()) ? imagePath : null,
          auto_discovered: true,
        };
        episodeReferences.push(reference);
        libraries.push(reference);
      } else if (reference.scope === "episode" && reference.slug === slug) {
        reference.auto_discovered = true;
        reference.generation_path = imagePath;
        reference.upload_path = uploadImageExtensions.has(extname(imagePath).toLowerCase()) ? imagePath : null;
      }
      if (reference.scope !== "episode") continue;
      // A later clip may declare a prompt for an image first encountered without one.
      if (reference.auto_discovered && declaredPrompt && (!reference.prompt_text || reference.prompt_path === fallbackPrompt)) {
        reference.prompt_path = declaredPrompt;
        reference.prompt_text = readText(safeRepositoryPath(declaredPrompt));
      }
      if (reference.auto_discovered && !reference.prompt_text && entry.picture === 1 && entry.role === "first_frame_anchor" && record.payload.first_frame_image_prompt) {
        reference.prompt_text = String(record.payload.first_frame_image_prompt);
        reference.prompt_origin = `${record.payload.clip_id}:first_frame_image_prompt`;
      }
      if (reference.auto_discovered && !reference.prompt_text?.trim()) {
        const inferredPrompt = inferredReferencePrompt(imagePath, libraries);
        if (inferredPrompt) {
          reference.prompt_text = readText(safeRepositoryPath(inferredPrompt));
          reference.prompt_origin = inferredPrompt;
          // Keep the declared or dedicated editing destination; inference never edits shared prompts.
        }
      }
      const image = isFile(safeRepositoryPath(imagePath)) ? assetRecord(safeRepositoryPath(imagePath)) : null;
      if (image && !reference.images.some((candidate) => referencePathKey(candidate.path) === imageKey)) reference.images.push(image);
      reference.ready = reference.images.length > 0;
      reference.upload_ready = Boolean(reference.upload_path && isFile(safeRepositoryPath(reference.upload_path)));
      reference.used_by ||= [];
      reference.used_by.push({ clip_id: record.payload.clip_id, title: record.payload.title || record.payload.clip_id, picture: entry.picture });
    }
  }
  return libraries;
}

export function parseOutlineDurations(text) {
  const durations = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    const columns = line.trim().replace(/^\||\|$/g, "").split("|").map((column) => column.trim());
    if (columns.length < 3 || !/^\d+$/.test(columns[0])) continue;
    const match = columns[2].match(/([0-9.]+)\s*秒/);
    if (match) durations.set(Number(columns[0]), Number(match[1]));
  }
  return durations;
}

export function parsePromptDuration(text) {
  const patterns = [
    /\b([0-9]+(?:\.[0-9]+)?)\s*[- ]second target video\b/i,
    /\bover one continuous\s+([0-9]+(?:\.[0-9]+)?)-second\b/i,
    /\b([0-9]+(?:\.[0-9]+)?)-second target video\b/i,
    /\b([0-9]+(?:\.[0-9]+)?)\.00-second\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function loadStructuredClips(episodeDirectory) {
  const bySequence = new Map();
  const byId = new Map();
  for (const entry of entries(episodeDirectory)) {
    if (!entry.isFile() || !/^clip[-_ ]?\d+\.json$/i.test(entry.name)) continue;
    const path = join(episodeDirectory, entry.name);
    const payload = readJson(path);
    const number = Number(payload?.sequence ?? payload?.clip_id?.match(/\d+/)?.[0]);
    if (!payload || !Number.isFinite(number) || !payload.clip_id) continue;
    const record = { path, payload };
    bySequence.set(number, record);
    byId.set(String(payload.clip_id), record);
  }
  return { bySequence, byId };
}

export function clipPathBase(record, storyDirectory, episodeDirectory) {
  const pathBase = record?.payload?.path_base || "story";
  if (pathBase === "episode") return episodeDirectory;
  if (pathBase === "repository") return env.repositoryRoot;
  return storyDirectory;
}

export function structuredOutputStates(record, storyDirectory, episodeDirectory) {
  const outputStates = {};
  const base = clipPathBase(record, storyDirectory, episodeDirectory);
  for (const [name, output] of Object.entries(record?.payload?.outputs || {})) {
    if (!output?.path) continue;
    const candidate = resolve(base, String(output.path));
    const ready = isFile(candidate);
    outputStates[name] = {
      path: relativePath(candidate),
      artifact_id: output.artifact_id || `${record.payload.clip_id}:${name}`,
      ready,
      asset: ready ? assetRecord(candidate) : null,
    };
  }
  return outputStates;
}

export function cleanReferenceDescription(value) {
  return String(value || "")
    .replace(/\breference(?:\s+reference)+\b/gi, "reference")
    .replace(/\s+/g, " ")
    .trim();
}

export function generatedReferenceDescription(reference) {
  const name = String(reference?.name || reference?.slug || "Reference").trim();
  const kind = String(reference?.kind || "visual").trim();
  const suffix = /\breference$/i.test(kind) ? kind : `${kind} reference`;
  return cleanReferenceDescription(`${name} ${suffix}`);
}

export function resolveStructuredReference(entry, ownerRecord, storyDirectory, episodeDirectory, structuredClips, libraries) {
  const source = entry?.source || {};
  const description = cleanReferenceDescription(entry?.description || entry?.id || "Reference");
  const result = {
    picture: Number.isInteger(entry?.picture) ? entry.picture : null,
    id: entry?.id || "reference",
    label: description,
    description,
    role: entry?.role || "reference",
    kind: source.type || "structured",
    source_type: source.type || "unknown",
    ready: false,
  };

  if (source.type === "file") {
    const baseDirectory = clipPathBase(ownerRecord, storyDirectory, episodeDirectory);
    const candidate = resolve(baseDirectory, String(source.path || ""));
    result.expected = source.path ? relativePath(candidate) : "Reference path is missing";
    if (source.path && uploadImageExtensions.has(extname(candidate).toLowerCase())) {
      result.upload_path = relativePath(candidate);
      result.upload_ready = isFile(candidate);
    }
    if (isFile(candidate) && imageExtensions.has(extname(candidate).toLowerCase())) {
      result.image = assetRecord(candidate);
      result.ready = true;
    }
    if (source.prompt_path) {
      const promptCandidate = resolve(baseDirectory, source.prompt_path);
      result.prompt_path = relativePath(promptCandidate);
      result.prompt_text = readText(promptCandidate);
      const library = libraries.find((item) => item.prompt_path === result.prompt_path);
      if (library) {
        result.source_id = library.id;
        if (result.upload_path && (!library.upload_path || library.upload_path === result.upload_path)) {
          library.upload_path = result.upload_path;
          library.upload_ready = result.upload_ready;
        }
      }
    }
    const library = libraries.find((item) => indexedReferencePaths(item).some((path) => referencePathKey(path) === referencePathKey(result.upload_path || result.image?.path || (source.path ? result.expected : null))));
    if (library) {
      result.source_id = library.id;
      result.prompt_path = library.prompt_path;
      result.prompt_text = library.prompt_text;
    }
    return result;
  }

  if (source.type === "clip_artifact") {
    const sourceRecord = structuredClips.byId.get(String(source.clip_id || ""));
    const output = sourceRecord?.payload?.outputs?.[source.artifact];
    const outputPath = output?.path || null;
    const artifactId = output?.artifact_id || `${source.clip_id}:${source.artifact}`;
    result.dependency = {
      clip_id: source.clip_id,
      artifact: source.artifact,
      artifact_id: artifactId,
      output_path: outputPath,
    };
    result.expected = outputPath
      ? `${source.type} → ${artifactId} (${outputPath})`
      : `${source.type} → ${artifactId}`;
    const sourceBase = clipPathBase(sourceRecord, storyDirectory, episodeDirectory);
    const candidate = outputPath ? resolve(sourceBase, outputPath) : null;
    if (candidate && uploadImageExtensions.has(extname(candidate).toLowerCase())) {
      result.upload_path = relativePath(candidate);
      result.upload_ready = isFile(candidate);
    }
    if (candidate && imageExtensions.has(extname(candidate).toLowerCase())) {
      if (isFile(candidate)) {
        result.image = assetRecord(candidate);
        result.ready = true;
      }
    }
    return result;
  }

  result.expected = "Unknown structured reference source";
  return result;
}

export function clipLocalImages(episodeDirectory, clipNumber, clipId = null) {
  const identifiers = new Set([Number(clipNumber)]);
  const clipIdNumber = Number(String(clipId || "").match(/\d+/)?.[0]);
  if (Number.isFinite(clipIdNumber)) identifiers.add(clipIdNumber);
  const prefixes = [...identifiers].flatMap((identifier) => [
    `clip-${String(identifier).padStart(2, "0")}`,
    `clip_${String(identifier).padStart(2, "0")}`,
    `clip${identifier}`,
    `${identifier}-end`,
  ]);
  const matches = new Set(walk(episodeDirectory).filter((path) => {
    if (!imageExtensions.has(extname(path).toLowerCase())) return false;
    const stem = basename(path, extname(path)).toLowerCase();
    return prefixes.some((prefix) => stem.startsWith(prefix.toLowerCase()));
  }));
  return sortPaths([...matches]).map(assetRecord);
}

export function scanEpisode(storyDirectory, episodeDirectory, episodeNumber, storyReferences) {
  const outlineCandidates = [
    join(episodeDirectory, "outline.md"),
    join(storyDirectory, `episode-${String(episodeNumber).padStart(2, "0")}-outline.md`),
    join(storyDirectory, `episode-${episodeNumber}-outline.md`),
  ];
  const outlinePath = outlineCandidates.find(isFile) || null;
  const outlineText = readText(outlinePath);
  const outlineDurations = parseOutlineDurations(outlineText);
  const structuredClips = loadStructuredClips(episodeDirectory);
  const episodeReferences = scanEpisodeReferences(episodeDirectory);
  const libraries = discoverClipReferences(storyDirectory, episodeDirectory, structuredClips, storyReferences, episodeReferences);
  const clipFiles = new Map();
  for (const entry of entries(episodeDirectory)) {
    if (!entry.isFile()) continue;
    const match = basename(entry.name, extname(entry.name)).match(clipFilePattern);
    if (!match) continue;
    const number = Number(match[1]);
    if (!clipFiles.has(number)) clipFiles.set(number, []);
    clipFiles.get(number).push(join(episodeDirectory, entry.name));
  }
  const consumedFileNumbers = new Set();
  const descriptors = [...structuredClips.bySequence.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sequence, structuredRecord]) => {
      const fileNumber = Number(String(structuredRecord.payload.clip_id).match(/\d+/)?.[0]);
      if (Number.isFinite(fileNumber)) consumedFileNumbers.add(fileNumber);
      return { sequence, fileNumber, structuredRecord };
    });
  const fallbackNumbers = [...new Set([...clipFiles.keys(), ...outlineDurations.keys()])]
    .filter((number) => !consumedFileNumbers.has(number) && !structuredClips.bySequence.has(number))
    .sort((left, right) => left - right);
  descriptors.push(...fallbackNumbers.map((number) => ({ sequence: number, fileNumber: number, structuredRecord: null })));
  descriptors.sort((left, right) => left.sequence - right.sequence);

  const clips = descriptors.map(({ sequence: clipNumber, fileNumber, structuredRecord }) => {
    const sourceFiles = [...(clipFiles.get(fileNumber) || [])];
    if (structuredRecord && !sourceFiles.includes(structuredRecord.path)) sourceFiles.push(structuredRecord.path);
    const files = sortPaths(sourceFiles);
    const structured = structuredRecord?.payload || null;
    const stableClipId = structured?.clip_id || `clip-${String(clipNumber).padStart(2, "0")}`;
    const videoPromptPath = files.find((path) => basename(path).toLowerCase().endsWith("-video.prompt")) || null;
    const firstFramePromptPath = files.find((path) => basename(path).toLowerCase().includes("first-frame") && extname(path).toLowerCase() === ".prompt") || null;
    const postPath = files.find((path) => basename(path).toLowerCase().includes("post") && extname(path).toLowerCase() === ".md") || null;
    const fallbackPrompt = files.find((path) => extname(path).toLowerCase() === ".prompt") || null;
    let promptPath = videoPromptPath || fallbackPrompt;
    let promptText = readText(promptPath);
    const duration = structured?.duration_seconds ?? outlineDurations.get(clipNumber) ?? parsePromptDuration(promptText);
    let references;
    if (structured) {
      references = (structured.references || []).map((entry) => resolveStructuredReference(entry, structuredRecord, storyDirectory, episodeDirectory, structuredClips, libraries));
    } else {
      references = [];
    }

    let type;
    if (structured) {
      type = structured.generation_mode || "h3";
      promptPath = structuredRecord.path;
      promptText = type === "post"
        ? structured.post_production_instructions || ""
        : structured.video_prompt || "";
    } else if (postPath) {
      type = "post";
      promptPath = postPath;
      promptText = readText(postPath);
    } else if (promptText.trimStart().startsWith("subject_definitions:")) type = "ref2va";
    else if (promptText.includes("For the target video")) type = "i2va";
    else type = "h3";

    const images = clipLocalImages(episodeDirectory, clipNumber, stableClipId);
    const outputStates = structuredRecord
      ? structuredOutputStates(structuredRecord, storyDirectory, episodeDirectory)
      : {};
    const readyReferenceCount = references.filter((reference) => reference.ready).length;
    const issues = [];
    if (type !== "post" && !promptText) issues.push("Missing generation Prompt");
    if (references.length && readyReferenceCount < references.length) issues.push(`${references.length - readyReferenceCount} reference image(s) missing`);
    if (duration === null || duration === undefined) issues.push("Duration not resolved");
    return {
      id: stableClipId,
      clip_id: stableClipId,
      number: clipNumber,
      sequence: clipNumber,
      title: structured?.title || (type === "post" ? "Title card" : `Clip ${String(clipNumber).padStart(2, "0")}`),
      type,
      duration,
      prompt_path: promptPath ? relativePath(promptPath) : null,
      prompt_text: promptText,
      first_frame_prompt_path: structured?.first_frame_image_prompt ? relativePath(structuredRecord.path) : (firstFramePromptPath ? relativePath(firstFramePromptPath) : null),
      first_frame_prompt_text: structured?.first_frame_image_prompt || readText(firstFramePromptPath),
      structured_path: structuredRecord ? relativePath(structuredRecord.path) : null,
      structured_payload: structured,
      outputs: structured?.outputs || null,
      output_states: outputStates,
      complete: Object.keys(outputStates).length > 0 && Object.values(outputStates).every((output) => output.ready),
      references,
      reference_count: references.length,
      ready_reference_count: readyReferenceCount,
      images,
      files: files.map(relativePath),
      issues,
      ready: Boolean(promptPath || postPath) && !issues.length,
    };
  });

  const episodeImages = sortPaths(walk(episodeDirectory).filter((path) => imageExtensions.has(extname(path).toLowerCase()))).map(assetRecord);
  return {
    id: `episode-${String(episodeNumber).padStart(2, "0")}`,
    number: episodeNumber,
    title: firstHeading(outlineText, `Episode ${String(episodeNumber).padStart(2, "0")}`),
    summary: plainExcerpt(outlineText),
    path: relativePath(episodeDirectory),
    outline_path: outlinePath ? relativePath(outlinePath) : null,
    outline_text: outlineText,
    references: episodeReferences,
    images: episodeImages,
    clips,
    clip_count: clips.length,
    duration: clips.reduce((sum, clip) => sum + Number(clip.duration || 0), 0),
  };
}

export function sceneImagePairs(storyDirectory) {
  const directory = join(storyDirectory, "comic slices");
  if (!isDirectory(directory)) return [];
  return sortPaths(entries(directory)
    .filter((entry) => entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(directory, entry.name)));
}

export function scanLegacyEpisode(storyDirectory) {
  const prompts = entries(storyDirectory)
    .filter((entry) => entry.isFile() && scenePromptPattern.test(entry.name))
    .map((entry) => ({ number: Number(entry.name.match(scenePromptPattern)[1]), path: join(storyDirectory, entry.name) }))
    .sort((a, b) => a.number - b.number);
  const images = sceneImagePairs(storyDirectory);
  const clips = prompts.map(({ number, path }) => {
    const promptText = readText(path);
    const references = [];
    const localImages = [];
    for (const [picture, imageIndex] of [[1, number - 1], [2, number]]) {
      if (!images[imageIndex]) continue;
      const image = assetRecord(images[imageIndex]);
      localImages.push(image);
      references.push({
        picture,
        label: picture === 1 ? "First frame" : "Last frame",
        role: "keyframe",
        kind: "file",
        image,
        ready: true,
        expected: image.path,
      });
    }
    return {
      id: `clip-${String(number).padStart(2, "0")}`,
      number,
      title: `Scene ${String(number).padStart(2, "0")}`,
      type: "fl2va",
      duration: parsePromptDuration(promptText) || 15,
      prompt_path: relativePath(path),
      prompt_text: promptText,
      first_frame_prompt_path: null,
      first_frame_prompt_text: "",
      references,
      reference_count: references.length,
      ready_reference_count: references.length,
      images: localImages,
      files: [relativePath(path)],
      issues: [],
      ready: true,
    };
  });
  return {
    id: "legacy-sequence",
    number: 1,
    title: "Comic-to-video sequence",
    summary: "Sequential first-and-last-frame video clips generated from the comic slices.",
    path: relativePath(storyDirectory),
    outline_path: null,
    outline_text: "",
    references: [],
    images: images.map(assetRecord),
    clips,
    clip_count: clips.length,
    duration: clips.reduce((sum, clip) => sum + Number(clip.duration || 0), 0),
  };
}

export function isStoryDirectory(path) {
  if (isFile(join(path, "outline.md"))) return true;
  const children = entries(path);
  if (children.some((entry) => entry.isDirectory() && episodePattern.test(entry.name))) return true;
  return children.some((entry) => entry.isFile() && scenePromptPattern.test(entry.name));
}

export function scanStory(storyDirectory) {
  const outlinePath = join(storyDirectory, "outline.md");
  const outlineText = readText(outlinePath);
  const references = scanStoryReferences(storyDirectory);
  const episodeByNumber = new Map();
  for (const entry of entries(storyDirectory)) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(episodePattern);
    if (!match) continue;
    const number = Number(match[1]);
    const candidate = { number, path: join(storyDirectory, entry.name), name: entry.name };
    const existing = episodeByNumber.get(number);
    const candidateScore = walk(candidate.path).length + (candidate.name === `episode-${String(number).padStart(2, "0")}` ? 100000 : 0);
    const existingScore = existing ? walk(existing.path).length + (existing.name === `episode-${String(number).padStart(2, "0")}` ? 100000 : 0) : -1;
    if (!existing || candidateScore > existingScore) episodeByNumber.set(number, candidate);
  }
  const episodeDirectories = [...episodeByNumber.values()].sort((a, b) => a.number - b.number);
  const hasLegacyPrompts = entries(storyDirectory).some((entry) => entry.isFile() && scenePromptPattern.test(entry.name));
  const episodes = episodeDirectories.length
    ? episodeDirectories.map((episode) => scanEpisode(storyDirectory, episode.path, episode.number, references))
    : hasLegacyPrompts
      ? [scanLegacyEpisode(storyDirectory)]
      : [];
  const media = sortPaths(walk(storyDirectory).filter((path) => videoExtensions.has(extname(path).toLowerCase()))).map(assetRecord);
  return {
    id: basename(storyDirectory),
    title: firstHeading(outlineText, basename(storyDirectory).replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())),
    summary: plainExcerpt(outlineText) || `Project discovered in ${basename(storyDirectory)}.`,
    path: relativePath(storyDirectory),
    outline_path: isFile(outlinePath) ? relativePath(outlinePath) : null,
    outline_text: outlineText,
    references,
    episodes,
    episode_count: episodes.length,
    clip_count: episodes.reduce((sum, episode) => sum + episode.clip_count, 0),
    media,
  };
}

export function buildCatalog() {
  const stories = [];
  for (const entry of entries(env.repositoryRoot).sort((a, b) => collator.compare(a.name, b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(env.repositoryRoot, entry.name);
    if (resolve(path) === resolve(env.toolDirectory)) continue;
    if (!isStoryDirectory(path)) continue;
    try {
      stories.push(scanStory(path));
    } catch (error) {
      stories.push({
        id: entry.name,
        title: entry.name,
        summary: `Could not scan project: ${error.message}`,
        path: relativePath(path),
        references: [],
        episodes: [],
        episode_count: 0,
        clip_count: 0,
        media: [],
        scan_error: error.message,
      });
    }
  }
  return {
    name: "AITurboShow",
    generated_at: new Date().toISOString(),
    repository: basename(env.repositoryRoot),
    story_count: stories.length,
    stories,
  };
}
