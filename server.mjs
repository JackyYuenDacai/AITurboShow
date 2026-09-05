import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolDirectory, "..");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const uploadImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv"]);
const maximumUploadBytes = 50 * 1024 * 1024;
const maximumJsonBytes = 1024 * 1024;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const episodePattern = /^episode[-_ ]?(\d+)$/i;
const clipFilePattern = /^clip[-_ ]?(\d+)(?:[-_ ].*)?$/i;
const scenePromptPattern = /^scene(\d+)\.prompt$/i;
const comfyRequiredNodes = [
  "MiniMaxH3ReferenceToVideo",
  "VAEDecodeAudio",
  "CreateVideo",
  "SaveVideo",
  "H3SaveLastFrame",
];
const comfyRequiredModels = [
  ["VAELoader", "vae_name", "minimax_h3_video_vae_fp16.safetensors"],
  ["VAELoader", "vae_name", "minimax_h3_audio_vae_fp32.safetensors"],
  ["UNETLoader", "unet_name", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"],
  ["CLIPLoader", "clip_name", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
];
const zImageRequiredNodes = [
  "CLIPTextEncode",
  "ConditioningZeroOut",
  "EmptySD3LatentImage",
  "ModelSamplingAuraFlow",
  "KSampler",
  "VAEDecode",
  "SaveImage",
];
const zImageRequiredModels = [
  ["VAELoader", "vae_name", "ae.safetensors"],
  ["UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"],
  ["CLIPLoader", "clip_name", "qwen_3_4b.safetensors"],
];
const generationJobs = new Map();
const labHistoryPath = join(toolDirectory, "lab-history.json");
const labReferencesPath = join(toolDirectory, "lab-references.json");
let generationQueueSequence = 0;
let processingVideoGenerationQueue = false;
let comfyUiBaseUrl = String(process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
let apiToken = String(process.env.AITURBOSHOW_TOKEN || "").trim();
const agentConfigPath = join(toolDirectory, "config.local.json");
const deepSeekH3SkillPath = join(toolDirectory, "agent-skills", "minimax-h3-prompt-writing.md");
const deepSeekH3PromptSkill = readFileSync(deepSeekH3SkillPath, "utf8").trim();
const defaultDeepSeekBaseUrl = "https://api.deepseek.com";
const defaultDeepSeekModel = "deepseek-chat";
const h3FirstFrameContinuityInstruction = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
const agentActions = new Set([
  "story_summary",
  "story_outline",
  "episode_summary",
  "episode_outline",
  "clip_prompt",
  "first_frame_prompt",
  "post_production_instructions",
  "reference_image_prompt",
  "episode_clip_batch",
  "clip_prompt_batch",
]);
const activeAgentClipBatches = new Set();

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function entries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(directory) {
  const output = [];
  for (const entry of entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function relativePath(path) {
  return relative(repositoryRoot, resolve(path)).split(sep).join("/");
}

function safeRepositoryPath(value) {
  const cleaned = decodeURIComponent(String(value || "")).replaceAll("\\", "/").replace(/^\/+/, "");
  const candidate = resolve(repositoryRoot, cleaned);
  const rel = relative(repositoryRoot, candidate);
  if (rel.startsWith("..") || resolve(candidate) === resolve(repositoryRoot, "..")) {
    throw new Error("Requested path is outside the repository.");
  }
  return candidate;
}

function readText(path) {
  if (!path || !isFile(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJson(path) {
  if (!path || !isFile(path)) return null;
  try {
    return JSON.parse(readText(path));
  } catch {
    return null;
  }
}

function readLabHistory() { return readJson(labHistoryPath) || []; }
function saveLabHistory(history) { writeJsonAtomically(labHistoryPath, history.slice(-100)); }
function appendLabHistory(entry) { const history = readLabHistory(); history.push(entry); saveLabHistory(history); return entry; }
function readLabReferences() { return readJson(labReferencesPath) || []; }
function saveLabReferences(items) { writeJsonAtomically(labReferencesPath, items.slice(0, 100)); }

function labNumber(value, fallback, min, max, name, step = 1) {
  const number = value === undefined ? fallback : Number(value);
  if (value === null || value === "" || !Number.isSafeInteger(number) || number < min || number > max || number % step !== 0) {
    throw httpError(`${name} must be an integer from ${min} to ${max}${step > 1 ? ` in multiples of ${step}` : ""}.`, 400);
  }
  return number;
}

function labOptions(payload, video = false) {
  return {
    width: labNumber(payload.width, video ? 864 : 1024, 256, 2048, "Width", video ? 32 : 16),
    height: labNumber(payload.height, video ? 480 : 1024, 256, 2048, "Height", video ? 32 : 16),
    steps: labNumber(payload.steps, video ? 20 : 15, 1, video ? 100 : 50, "Steps"),
    seed: payload.seed === undefined ? randomSeed() : labNumber(payload.seed, 0, 0, Number.MAX_SAFE_INTEGER, "Seed"),
  };
}

function labReferencePath(image) {
  let path;
  try { path = safeRepositoryPath(image); } catch { throw httpError("Reference image must be inside the repository.", 400); }
  if (!imageExtensions.has(extname(path).toLowerCase()) || !isFile(path)) throw httpError("Reference must point to an existing repository image.", 400);
  if (statSync(path).size > maximumUploadBytes) throw httpError("Reference image exceeds the 50 MB limit.", 400);
  return path;
}

function labVideoInputs(payload) {
  const references = Array.isArray(payload.references) ? payload.references : [];
  const mode = payload.video_mode || (references.length ? "ref2va" : "t2va");
  if (!["t2va", "i2va", "ref2va"].includes(mode)) throw httpError("Choose a valid video mode.", 400);
  if (mode === "t2va" && references.length) throw httpError("Text to video cannot use image references.", 400);
  if (mode === "i2va" && references.length !== 1) throw httpError("Image to video needs exactly one reference.", 400);
  if (mode === "ref2va" && (references.length < 1 || references.length > 9)) throw httpError("Reference to video needs 1–9 images.", 400);
  return {
    mode,
    duration: labNumber(payload.duration, 6, 1, 15, "Duration"),
    references: references.map((reference, index) => {
      if (!reference || Number(reference.picture) !== index + 1) throw httpError("Reference pictures must be numbered consecutively from 1.", 400);
      const image = String(reference.image || "").trim();
      labReferencePath(image);
      return { picture: index + 1, image, description: String(reference.description || "") };
    }),
  };
}

async function uploadLabReferences(references) {
  const staged = [];
  for (const reference of references) {
    const path = labReferencePath(reference.image);
    const form = new FormData();
    form.append("image", new Blob([readFileSync(path)]), `${randomUUID()}${extname(path)}`);
    form.append("type", "input");
    form.append("subfolder", "aiturboshow-lab");
    const uploaded = await comfyRequest("/upload/image", { method: "POST", body: form, timeoutMs: 30000 });
    if (!uploaded.name) throw httpError("ComfyUI did not accept the reference image.", 502);
    staged.push({ ...reference, image: [uploaded.subfolder, uploaded.name].filter(Boolean).join("/") });
  }
  return staged;
}

let labHistorySync = null;
async function syncLabHistory() {
  if (labHistorySync) return labHistorySync;
  labHistorySync = (async () => {
    if (!readLabHistory().some((item) => ["queued", "running"].includes(item.status))) return readLabHistory();
    const [completed, queue] = await Promise.all([
      comfyRequest("/history", { timeoutMs: 5000 }), comfyRequest("/queue", { timeoutMs: 5000 }),
    ]);
    // Read again after the network calls so newly queued runs are preserved.
    const history = readLabHistory();
    let changed = false;
    for (const item of history) {
      if (!["queued", "running"].includes(item.status) || !item.prompt_id) continue;
      const record = completed[item.prompt_id];
      const before = JSON.stringify(item);
      if (record?.status?.status_str === "error") {
        item.status = "error";
        const detail = record.status.messages?.find(([type]) => type === "execution_error")?.[1];
        item.error = detail?.exception_message || "ComfyUI generation failed.";
      } else if (record && (record.status?.completed || record.status?.status_str === "success")) {
        const outputs = Object.values(record.outputs || {}).flatMap((output) => [...(output.images || []), ...(output.gifs || []), ...(output.videos || [])]);
        // Video workflows can also emit a last-frame PNG; only preview matching media.
        item.outputs = outputs.filter((output) => (item.kind === "video" ? videoExtensions : imageExtensions).has(extname(output.filename || "").toLowerCase()));
        item.preview_urls = item.outputs.map((output) => `/api/lab/output?${new URLSearchParams({ prompt_id: item.prompt_id, filename: output.filename, subfolder: output.subfolder || "", type: output.type || "output" })}`);
        item.status = item.outputs.length ? "completed" : "error";
        if (!item.outputs.length) item.error = "ComfyUI finished without a matching output file.";
      } else if ((queue.queue_running || []).some((entry) => String(entry[1]) === item.prompt_id)) item.status = "running";
      else if ((queue.queue_pending || []).some((entry) => String(entry[1]) === item.prompt_id)) item.status = "queued";
      if (before !== JSON.stringify(item)) changed = true;
    }
    if (changed) saveLabHistory(history);
    return history;
  })();
  try { return await labHistorySync; } finally { labHistorySync = null; }
}

function firstHeading(text, fallback) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) return trimmed.slice(2).trim();
  }
  return fallback;
}

function plainExcerpt(text, limit = 220) {
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

function sortPaths(paths) {
  return paths.sort((left, right) => collator.compare(basename(left), basename(right)));
}

function assetRecord(path) {
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

function imageCandidates(directory, stem) {
  if (!isDirectory(directory)) return [];
  const normalizedStem = stem.toLowerCase().replaceAll("_", "-");
  return sortPaths(walk(directory).filter((path) => {
    if (!imageExtensions.has(extname(path).toLowerCase())) return false;
    const candidate = basename(path, extname(path)).toLowerCase().replaceAll("_", "-");
    return candidate === normalizedStem || candidate.includes(normalizedStem) || normalizedStem.includes(candidate);
  }));
}

function scanReferenceGroup(base, kind, scope) {
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

function scanStoryReferences(storyDirectory) {
  return [
    ...scanReferenceGroup(join(storyDirectory, "characters"), "character", "story"),
    ...scanReferenceGroup(join(storyDirectory, "environments"), "environment", "story"),
    ...scanReferenceGroup(join(storyDirectory, "objects"), "object", "story"),
  ];
}

function scanEpisodeReferences(episodeDirectory) {
  return scanReferenceGroup(join(episodeDirectory, "reference-images"), "episode reference", "episode");
}

function referencePathKey(value) {
  if (!value) return null;
  const key = resolve(repositoryRoot, value).split(sep).join("/");
  return sep === "\\" ? key.toLowerCase() : key;
}

function indexedReferencePaths(reference) {
  // Preview discovery permits loose filename matches; library identity must not.
  const normalized = (value) => String(value).toLowerCase().replaceAll("_", "-");
  return [reference.generation_path, reference.upload_path, ...(reference.images || [])
    .filter((image) => normalized(basename(image.path, extname(image.path))) === normalized(reference.slug))
    .map((image) => image.path)].filter(Boolean);
}

function inferredReferencePrompt(imagePath, libraries) {
  const image = safeRepositoryPath(imagePath);
  const stem = basename(image, extname(image));
  const siblingPaths = [join(dirname(image), `${stem}.prompt`), join(dirname(dirname(image)), "prompts", `${stem}.prompt`)];
  const exact = [...new Set(siblingPaths.filter((path) => {
    const rel = relative(repositoryRoot, path);
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

function discoverClipReferences(storyDirectory, episodeDirectory, structuredClips, storyReferences, episodeReferences) {
  const libraries = [...storyReferences, ...episodeReferences];
  const pathInRepository = (base, value, extensions) => {
    if (!value || typeof value !== "string") return null;
    const candidate = resolve(base, value.replaceAll("\\", "/"));
    const rel = relative(repositoryRoot, candidate);
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

function parseOutlineDurations(text) {
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

function parsePromptDuration(text) {
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

function loadStructuredClips(episodeDirectory) {
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

function clipPathBase(record, storyDirectory, episodeDirectory) {
  const pathBase = record?.payload?.path_base || "story";
  if (pathBase === "episode") return episodeDirectory;
  if (pathBase === "repository") return repositoryRoot;
  return storyDirectory;
}

function structuredOutputStates(record, storyDirectory, episodeDirectory) {
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

function cleanReferenceDescription(value) {
  return String(value || "")
    .replace(/\breference(?:\s+reference)+\b/gi, "reference")
    .replace(/\s+/g, " ")
    .trim();
}

function generatedReferenceDescription(reference) {
  const name = String(reference?.name || reference?.slug || "Reference").trim();
  const kind = String(reference?.kind || "visual").trim();
  const suffix = /\breference$/i.test(kind) ? kind : `${kind} reference`;
  return cleanReferenceDescription(`${name} ${suffix}`);
}

function resolveStructuredReference(entry, ownerRecord, storyDirectory, episodeDirectory, structuredClips, libraries) {
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

function clipLocalImages(episodeDirectory, clipNumber, clipId = null) {
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

function scanEpisode(storyDirectory, episodeDirectory, episodeNumber, storyReferences) {
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

function sceneImagePairs(storyDirectory) {
  const directory = join(storyDirectory, "comic slices");
  if (!isDirectory(directory)) return [];
  return sortPaths(entries(directory)
    .filter((entry) => entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(directory, entry.name)));
}

function scanLegacyEpisode(storyDirectory) {
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

function isStoryDirectory(path) {
  if (isFile(join(path, "outline.md"))) return true;
  const children = entries(path);
  if (children.some((entry) => entry.isDirectory() && episodePattern.test(entry.name))) return true;
  return children.some((entry) => entry.isFile() && scenePromptPattern.test(entry.name));
}

function scanStory(storyDirectory) {
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

function buildCatalog() {
  const stories = [];
  for (const entry of entries(repositoryRoot).sort((a, b) => collator.compare(a.name, b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(repositoryRoot, entry.name);
    if (resolve(path) === resolve(toolDirectory)) continue;
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
    repository: basename(repositoryRoot),
    story_count: stories.length,
    stories,
  };
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function collectUploadTargets(catalog) {
  const targets = new Map();
  const collect = (references = []) => {
    for (const reference of references) {
      if (!reference?.upload_path || targets.has(reference.upload_path)) continue;
      if (!uploadImageExtensions.has(extname(reference.upload_path).toLowerCase())) continue;
      try {
        const path = safeRepositoryPath(reference.upload_path);
        if (relativePath(path) !== reference.upload_path) continue;
        targets.set(reference.upload_path, path);
      } catch {
        // Invalid declarations remain visible in the catalog but never become writable targets.
      }
    }
  };

  for (const story of catalog.stories || []) {
    collect(story.references);
    for (const episode of story.episodes || []) {
      collect(episode.references);
      for (const clip of episode.clips || []) collect(clip.references);
    }
  }
  return targets;
}

function readRequestBody(request, maximumBytes, label = "Request body") {
  return new Promise((resolveBody, rejectBody) => {
    const declaredLength = Number(request.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      request.resume();
      rejectBody(httpError(`${label} exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB limit.`, 413));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maximumBytes) {
        settled = true;
        rejectBody(httpError(`${label} exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB limit.`, 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks, size));
    });
    request.on("aborted", () => {
      if (settled) return;
      settled = true;
      rejectBody(httpError("Upload was interrupted.", 400));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    });
  });
}

async function readJsonRequest(request) {
  const content = await readRequestBody(request, maximumJsonBytes, "JSON request");
  if (!content.length) return {};
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

async function comfyRequest(pathname, { method = "GET", body = null, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${comfyUiBaseUrl}${pathname}`, {
      method,
      headers: body === null || body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      body: body === null ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const message = payload.error?.message || payload.error || payload.message || `HTTP ${response.status}`;
      throw httpError(`ComfyUI request failed: ${message}`, response.status >= 500 ? 502 : response.status);
    }
    return payload;
  } catch (error) {
    if (error.status) throw error;
    const message = error.name === "AbortError" ? "request timed out" : error.message;
    throw httpError(`Cannot reach ComfyUI at ${comfyUiBaseUrl}: ${message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function comfyBinaryRequest(pathname, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${comfyUiBaseUrl}${pathname}`, { signal: controller.signal });
    if (!response.ok) throw httpError(`ComfyUI binary request failed with HTTP ${response.status}.`, 502);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error.status) throw error;
    const message = error.name === "AbortError" ? "request timed out" : error.message;
    throw httpError(`Cannot download the generated image from ComfyUI: ${message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

function resolveCatalogClip(payload) {
  const catalog = buildCatalog();
  const story = catalog.stories.find((candidate) => candidate.id === String(payload.story_id || ""));
  if (!story) throw httpError("Unknown story_id.", 404);
  const episode = story.episodes.find((candidate) => candidate.id === String(payload.episode_id || ""));
  if (!episode) throw httpError("Unknown episode_id.", 404);
  const clip = episode.clips.find((candidate) => candidate.id === String(payload.clip_id || ""));
  if (!clip) throw httpError("Unknown clip_id.", 404);
  if (!clip.structured_path) throw httpError("This clip does not have a structured clip record.", 400);
  const storyDirectory = safeRepositoryPath(story.path);
  const episodeDirectory = safeRepositoryPath(episode.path);
  return { catalog, story, episode, clip, storyDirectory, episodeDirectory };
}

function resolveCatalogReference(payload, { requireGeneration = true } = {}) {
  const catalog = buildCatalog();
  const story = catalog.stories.find((candidate) => candidate.id === String(payload.story_id || ""));
  if (!story) throw httpError("Unknown story_id.", 404);
  const requestedId = String(payload.reference_id || "");
  let episode = null;
  let reference = story.references.find((candidate) => candidate.id === requestedId) || null;
  if (!reference) {
    episode = story.episodes.find((candidate) => candidate.id === String(payload.episode_id || "")) || null;
    reference = episode?.references?.find((candidate) => candidate.id === requestedId) || null;
  }
  if (!reference) throw httpError("Unknown reference_id.", 404);
  if (requireGeneration && !reference.prompt_text) throw httpError("This reference does not have an image-generation prompt.", 400);
  if (!reference.generation_path) throw httpError("This reference does not declare a generated-image destination.", 400);
  const destination = safeRepositoryPath(reference.generation_path);
  if (requireGeneration && extname(destination).toLowerCase() !== ".png") {
    throw httpError("Z-Image Turbo direct generation currently requires a PNG destination.", 400);
  }
  return { catalog, story, episode, reference, destination };
}

function comfyControllerPayload(target, clipId = null) {
  const episodeRelative = relative(target.storyDirectory, target.episodeDirectory).split(sep).join("/");
  const base = {
    project_directory: target.storyDirectory,
    episode_directory: episodeRelative,
    input_subfolder: `h3_r2v/${target.story.id}/${target.episode.id}`,
    output_prefix: `video/${target.story.id}/${target.episode.id}`,
  };
  return clipId ? { ...base, clip_id: clipId } : base;
}

async function findQueuedComfyClip(target) {
  const expectedPrefix = `${comfyControllerPayload(target).output_prefix}/${target.clip.id}`;
  const queue = await comfyRequest("/queue", { timeoutMs: 5000 });
  for (const group of [queue.queue_running || [], queue.queue_pending || []]) {
    for (const entry of group) {
      const prompt = entry?.[2] || {};
      const saveNode = Object.values(prompt).find((node) => node?.class_type === "SaveVideo");
      if (saveNode?.inputs?.filename_prefix === expectedPrefix) {
        return { prompt_id: String(entry[1]), prefix: expectedPrefix };
      }
    }
  }
  return null;
}

async function findQueuedComfyImage(outputPrefix) {
  const queue = await comfyRequest("/queue", { timeoutMs: 5000 });
  for (const group of [queue.queue_running || [], queue.queue_pending || []]) {
    for (const entry of group) {
      const prompt = entry?.[2] || {};
      const saveNode = Object.values(prompt).find((node) => node?.class_type === "SaveImage");
      if (saveNode?.inputs?.filename_prefix === outputPrefix) {
        return { prompt_id: String(entry[1]), prefix: outputPrefix };
      }
    }
  }
  return null;
}

function randomSeed() {
  const high = Math.floor(Math.random() * 0x1fffff);
  const low = Math.floor(Math.random() * 0x100000000);
  return high * 0x100000000 + low;
}

function roundedImageDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(256, Math.min(2048, Math.round(number / 16) * 16));
}

function defaultReferenceImageSize(reference) {
  if (reference.kind === "character") return { width: 768, height: 1024 };
  if (reference.kind === "environment" || reference.scope === "episode") return { width: 1344, height: 768 };
  return { width: 1024, height: 1024 };
}

function buildZImageTurboPrompt(target, options = {}) {
  const defaults = defaultReferenceImageSize(target.reference);
  const width = roundedImageDimension(options.width, defaults.width);
  const height = roundedImageDimension(options.height, defaults.height);
  const seed = Number.isSafeInteger(Number(options.seed)) ? Number(options.seed) : randomSeed();
  const steps = Math.max(1, Math.min(50, Number(options.steps || 15)));
  const outputPrefix = `aiturboshow/z_image/${target.story.id}/${target.reference.slug}`;
  const prompt = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: target.reference.prompt_text, clip: ["2", 0] } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["7", 0],
        seed,
        steps,
        cfg: 1,
        sampler_name: "res_multistep",
        scheduler: "simple",
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        denoise: 1,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: outputPrefix } },
  };
  return { prompt, seed, width, height, steps, outputPrefix };
}

function h3FrameLength(durationSeconds) {
  const frames = Math.max(5, Math.round(Number(durationSeconds) * 24));
  return frames + ((5 - (frames % 17)) + 17) % 17;
}

function roundedVideoDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(256, Math.min(2048, Math.round(number / 32) * 32));
}

function h3VideoSize(options = {}) {
  return {
    width: roundedVideoDimension(options.width, 864),
    height: roundedVideoDimension(options.height, 480),
  };
}

function h3RequiresFirstFrameContinuity(references = [], generationMode = "ref2va") {
  const pictureOne = Array.isArray(references)
    ? references.find((reference) => Number(reference?.picture) === 1)
    : null;
  if (!pictureOne) return false;
  return generationMode === "i2va"
    || pictureOne.role === "first_frame_anchor"
    || (pictureOne.source?.type === "clip_artifact" && pictureOne.source?.artifact === "last_frame");
}

function withH3FirstFrameContinuity(prompt, required) {
  let normalized = String(prompt || "").trim().replace(/\r\n/g, "\n");
  if (!required || normalized.startsWith(`${h3FirstFrameContinuityInstruction}\n\n`)) return normalized;
  const lines = normalized.split("\n");
  if (/^For the target video, at .*<Picture\s+1>.*fully referenced\.?$/i.test(String(lines[0] || "").trim())) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
    normalized = lines.join("\n").trim();
  }
  return `${h3FirstFrameContinuityInstruction}\n\n${normalized}`;
}

function assertH3PromptFormat(prompt, generationMode, continuityRequired = false) {
  const normalized = String(prompt || "").trim().replace(/\r\n/g, "\n");
  if (continuityRequired && !normalized.startsWith(`${h3FirstFrameContinuityInstruction}\n\n`)) {
    throw httpError(`H3 continuity prompts must begin exactly with: ${h3FirstFrameContinuityInstruction}`, 400);
  }
  const body = continuityRequired
    ? normalized.slice(h3FirstFrameContinuityInstruction.length).trimStart()
    : normalized;
  const sections = generationMode === "ref2va"
    ? ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]
    : generationMode === "i2va"
      ? ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]
      : [];
  if (!sections.length) return;
  if (!body.startsWith(`${sections[0]}:`)) {
    throw httpError(`MiniMax H3 ${generationMode.toUpperCase()} prompts must begin with ${sections[0]}: after any required continuity line.`, 400);
  }
  let previousPosition = -1;
  for (const section of sections) {
    const match = new RegExp(`^${section}:\\s*$`, "mi").exec(body);
    if (!match) throw httpError(`MiniMax H3 ${generationMode.toUpperCase()} prompt is missing the required ${section}: section.`, 400);
    if (match.index <= previousPosition) throw httpError(`MiniMax H3 ${generationMode.toUpperCase()} prompt sections are not in the required order.`, 400);
    previousPosition = match.index;
  }
}

function buildH3R2VPrompt(job, options = {}) {
  const { width, height } = h3VideoSize(options);
  const seed = Number.isSafeInteger(Number(options.seed)) ? Number(options.seed) : randomSeed();
  const steps = Math.max(1, Math.min(100, Number(options.steps || 20)));
  const scheduler = ["simple", "beta", "normal"].includes(options.scheduler) ? options.scheduler : "simple";
  const refImageSize = options.ref_image_size === "max" ? "max" : "match";
  const prompt = {
    "1": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "2": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "3": { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" } },
    "5": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "6": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        clip: ["4", 0],
        vae: ["1", 0],
        audio_vae: ["2", 0],
        prompt: job.video_prompt,
        width,
        height,
        length: h3FrameLength(job.duration_seconds),
        ref_image_size: refImageSize,
      },
    },
    "7": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["6", 0] } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "9": { class_type: "BasicScheduler", inputs: { model: ["3", 0], scheduler, steps, denoise: 1 } },
    "10": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["5", 0], guider: ["7", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["6", 1] } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 0] } },
    "12": { class_type: "VAEDecodeAudio", inputs: { samples: ["10", 0], vae: ["2", 0] } },
    "13": { class_type: "CreateVideo", inputs: { images: ["11", 0], audio: ["12", 0], fps: 24, bit_depth: 8 } },
    "14": { class_type: "SaveVideo", inputs: { video: ["13", 0], filename_prefix: job.output_prefix, format: "auto", codec: "auto" } },
    "15": {
      class_type: "H3SaveLastFrame",
      inputs: {
        images: ["11", 0],
        project_directory: job.project_directory,
        episode_directory: job.episode_directory,
        path_base: job.path_base,
        artifact_path: job.last_frame_path,
        staging_path: job.last_frame_staging,
      },
    },
  };
  let nodeId = 100;
  for (const reference of job.references || []) {
    const id = String(nodeId++);
    prompt[id] = { class_type: "LoadImage", inputs: { image: reference.image } };
    prompt["6"].inputs[`ref_images.ref_image_${reference.picture - 1}`] = [id, 0];
  }
  return { prompt, seed, width, height, steps, scheduler, ref_image_size: refImageSize };
}

function publicGenerationJob(job) {
  const waitingVideoJobs = [...generationJobs.values()]
    .filter((candidate) => (candidate.kind || "video") === "video" && candidate.status === "waiting")
    .sort((left, right) => Number(left.queue_order || 0) - Number(right.queue_order || 0));
  const waitingIndex = waitingVideoJobs.findIndex((candidate) => candidate.id === job.id);
  const progressByStatus = {
    waiting: 5,
    preparing: 10,
    queued: 20,
    running: 55,
    finalizing: 90,
    completed: 100,
    skipped: 100,
    cancelled: 100,
    error: 100,
  };
  return {
    id: job.id,
    kind: job.kind || "video",
    prompt_id: job.prompt_id,
    story_id: job.story_id,
    episode_id: job.episode_id,
    clip_id: job.clip_id,
    clip_title: job.clip_title || null,
    sequence: job.sequence || null,
    reference_id: job.reference_id || null,
    destination: job.destination || null,
    status: job.status,
    progress_percent: progressByStatus[job.status] ?? 0,
    progress_indeterminate: job.status === "running",
    queue_position: waitingIndex >= 0 ? waitingIndex + 1 : null,
    batch_id: job.batch_id || null,
    batch_index: job.batch_index || null,
    batch_total: job.batch_total || null,
    seed: job.seed,
    width: job.width,
    height: job.height,
    queued_at: job.queued_at,
    started_at: job.started_at || null,
    completed_at: job.completed_at || null,
    error: job.error || null,
    cancellable: ["waiting", "preparing", "queued", "running"].includes(job.status),
    finalized: job.finalized || null,
  };
}

function activeVideoGenerationJob() {
  return [...generationJobs.values()].find((job) => (
    (job.kind || "video") === "video"
    && ["preparing", "queued", "running", "finalizing"].includes(job.status)
  )) || null;
}

function videoGenerationJobFor(storyId, episodeId, clipId) {
  return [...generationJobs.values()].find((job) => (
    (job.kind || "video") === "video"
    && job.story_id === storyId
    && job.episode_id === episodeId
    && job.clip_id === clipId
    && ["waiting", "preparing", "queued", "running", "finalizing"].includes(job.status)
  )) || null;
}

function missingClipReferences(clip) {
  const missing = (clip.references || []).filter((reference) => !reference.ready);
  return {
    dependencies: missing.filter((reference) => reference.dependency?.clip_id),
    fixed: missing.filter((reference) => !reference.dependency?.clip_id),
  };
}

function clipDependencyReferences(clip) {
  return (clip.references || []).filter((reference) => reference.dependency?.clip_id);
}

function enqueueVideoGenerationJob(target, payload = {}, batch = null) {
  const duplicate = videoGenerationJobFor(target.story.id, target.episode.id, target.clip.id);
  if (duplicate) return { job: duplicate, duplicate: true };
  if (target.clip.complete && payload.force !== true) {
    throw httpError("This clip already has all declared outputs. Confirm regeneration and send force: true.", 409);
  }
  if (target.clip.type === "post") throw httpError("Post-production clips cannot be queued to H3.", 400);
  if (!["ref2va", "i2va"].includes(target.clip.type)) {
    throw httpError("Direct AITurboShow generation currently supports structured I2VA and Ref2VA clips.", 400);
  }
  const job = {
    id: randomUUID(),
    kind: "video",
    story_id: target.story.id,
    episode_id: target.episode.id,
    clip_id: target.clip.id,
    clip_title: target.clip.title,
    sequence: target.clip.sequence,
    status: "waiting",
    force: payload.force === true,
    options: payload.options || {},
    ...h3VideoSize(payload.options || {}),
    queue_order: ++generationQueueSequence,
    queued_at: new Date().toISOString(),
    batch_id: batch?.id || null,
    batch_index: batch?.index || null,
    batch_total: batch?.total || null,
  };
  generationJobs.set(job.id, job);
  setTimeout(() => processVideoGenerationQueue(), 0);
  return { job, duplicate: false };
}

function enqueueVideoGenerationWithDependencies(target, payload = {}, batch = null, ancestry = new Set()) {
  const key = `${target.story.id}:${target.episode.id}:${target.clip.id}`;
  if (ancestry.has(key)) throw httpError(`Circular clip dependency detected at ${target.clip.id}.`, 400);
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(key);
  const missing = missingClipReferences(target.clip);
  if (missing.fixed.length) {
    throw httpError(`${target.clip.id} has ${missing.fixed.length} missing fixed reference image(s). Generate or upload them before queueing.`, 400);
  }
  const dependencyJobs = [];
  const dependencies = payload.include_dependency_chain === true ? clipDependencyReferences(target.clip) : missing.dependencies;
  for (const reference of dependencies) {
    const dependencyClipId = reference.dependency.clip_id;
    const dependencyTarget = resolveCatalogClip({
      story_id: target.story.id,
      episode_id: target.episode.id,
      clip_id: dependencyClipId,
    });
    const dependencyResult = enqueueVideoGenerationWithDependencies(
      dependencyTarget,
      { ...payload, force: payload.include_dependency_chain === true },
      batch,
      nextAncestry,
    );
    dependencyJobs.push(...dependencyResult.dependency_jobs, dependencyResult.job);
  }
  const result = enqueueVideoGenerationJob(target, payload, batch);
  return { ...result, dependency_jobs: dependencyJobs };
}

function collectVideoGenerationPlan(target, collected = new Map(), ancestry = new Set(), includeDependencyChain = false) {
  const key = `${target.story.id}:${target.episode.id}:${target.clip.id}`;
  if (ancestry.has(key)) throw httpError(`Circular clip dependency detected at ${target.clip.id}.`, 400);
  if (collected.has(key)) return collected;
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(key);
  const missing = missingClipReferences(target.clip);
  if (missing.fixed.length) {
    throw httpError(`${target.clip.id} has ${missing.fixed.length} missing fixed reference image(s).`, 400);
  }
  const dependencies = includeDependencyChain ? clipDependencyReferences(target.clip) : missing.dependencies;
  for (const reference of dependencies) {
    collectVideoGenerationPlan(resolveCatalogClip({
      story_id: target.story.id,
      episode_id: target.episode.id,
      clip_id: reference.dependency.clip_id,
    }), collected, nextAncestry, includeDependencyChain);
  }
  collected.set(key, target.clip);
  return collected;
}

function collectClipDependencyPlan(target, collected = new Map(), ancestry = new Set()) {
  const key = `${target.story.id}:${target.episode.id}:${target.clip.id}`;
  if (ancestry.has(key)) throw httpError(`Circular clip dependency detected at ${target.clip.id}.`, 400);
  if (collected.has(key)) return collected;
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(key);
  for (const reference of clipDependencyReferences(target.clip)) {
    collectClipDependencyPlan(resolveCatalogClip({
      story_id: target.story.id,
      episode_id: target.episode.id,
      clip_id: reference.dependency.clip_id,
    }), collected, nextAncestry);
  }
  collected.set(key, target.clip);
  return collected;
}

async function cancelComfyPrompt(promptId) {
  if (!promptId) return false;
  const queue = await comfyRequest("/queue", { timeoutMs: 5000 });
  const running = (queue.queue_running || []).some((entry) => String(entry[1]) === String(promptId));
  const pending = (queue.queue_pending || []).some((entry) => String(entry[1]) === String(promptId));
  if (running) {
    await comfyRequest("/interrupt", { method: "POST", body: {}, timeoutMs: 10000 });
    return true;
  }
  if (pending) {
    await comfyRequest("/queue", { method: "POST", body: { delete: [String(promptId)] }, timeoutMs: 10000 });
    return true;
  }
  return false;
}

async function cancelGenerationJob(job) {
  if (!["waiting", "preparing", "queued", "running"].includes(job.status)) return job;
  if (job.status === "preparing" && !job.prompt_id) {
    job.cancel_requested = true;
    return job;
  }
  await cancelComfyPrompt(job.prompt_id);
  job.status = "cancelled";
  job.completed_at = new Date().toISOString();
  if ((job.kind || "video") === "video") setTimeout(() => processVideoGenerationQueue(), 0);
  return job;
}

async function processVideoGenerationQueue() {
  if (processingVideoGenerationQueue || activeVideoGenerationJob()) return;
  const job = [...generationJobs.values()]
    .filter((candidate) => (candidate.kind || "video") === "video" && candidate.status === "waiting")
    .sort((left, right) => Number(left.queue_order || 0) - Number(right.queue_order || 0))[0];
  if (!job) return;
  processingVideoGenerationQueue = true;
  job.status = "preparing";
  job.started_at = new Date().toISOString();
  try {
    const target = resolveCatalogClip(job);
    if (target.clip.complete && job.force !== true) {
      job.status = "skipped";
      job.error = "Outputs became complete before this queued task started.";
      job.completed_at = new Date().toISOString();
      return;
    }
    const externallyQueued = await findQueuedComfyClip(target);
    if (externallyQueued) {
      throw httpError(`This clip is already queued in ComfyUI as prompt ${externallyQueued.prompt_id}.`, 409);
    }
    const prepared = await comfyRequest("/h3_r2v_director/prepare", {
      method: "POST",
      body: comfyControllerPayload(target, target.clip.id),
      timeoutMs: 30000,
    });
    if (job.cancel_requested) {
      job.status = "cancelled";
      job.completed_at = new Date().toISOString();
      return;
    }
    if (prepared.post) throw httpError("Post-production clips cannot be queued to H3.", 400);
    prepared.video_prompt = withH3FirstFrameContinuity(
      prepared.video_prompt,
      h3RequiresFirstFrameContinuity(target.clip.structured_payload?.references, target.clip.type),
    );
    const built = buildH3R2VPrompt(prepared, job.options || {});
    const queued = await comfyRequest("/prompt", {
      method: "POST",
      body: { prompt: built.prompt, client_id: `aiturboshow-${randomUUID()}` },
      timeoutMs: 30000,
    });
    if (!queued.prompt_id) {
      const details = queued.node_errors ? JSON.stringify(queued.node_errors) : "No prompt ID returned.";
      throw httpError(`ComfyUI rejected the prompt: ${details}`, 502);
    }
    if (job.cancel_requested) {
      await cancelComfyPrompt(queued.prompt_id);
      job.prompt_id = queued.prompt_id;
      job.status = "cancelled";
      job.completed_at = new Date().toISOString();
      return;
    }
    Object.assign(job, {
      prompt_id: queued.prompt_id,
      status: "queued",
      seed: built.seed,
      width: built.width,
      height: built.height,
      prepared,
      queue_number: queued.number,
    });
    setTimeout(() => monitorGenerationJob(job.id), 250);
  } catch (error) {
    job.status = "error";
    job.error = error.message || String(error);
    job.completed_at = new Date().toISOString();
  } finally {
    processingVideoGenerationQueue = false;
    if (["error", "skipped", "cancelled"].includes(job.status)) setTimeout(() => processVideoGenerationQueue(), 0);
  }
}

async function finalizeImageGeneration(job, historyEntry) {
  const images = historyEntry?.outputs?.[job.save_node_id || "10"]?.images || [];
  const image = images[0];
  if (!image?.filename) throw new Error("ComfyUI completed without returning a saved image.");
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  const content = await comfyBinaryRequest(`/view?${query.toString()}`);
  if (detectImageMime(content) !== "image/png") {
    throw new Error("Z-Image Turbo did not return a valid PNG image.");
  }
  writeImageAtomically(job.destination_absolute, content, true);
  return {
    image: job.destination,
    comfyui_image: `${image.subfolder ? `${image.subfolder}/` : ""}${image.filename}`,
  };
}

async function monitorGenerationJob(jobId) {
  const job = generationJobs.get(jobId);
  if (!job || ["completed", "error", "cancelled", "skipped"].includes(job.status)) return;
  try {
    const history = await comfyRequest(`/history/${encodeURIComponent(job.prompt_id)}`, { timeoutMs: 5000 });
    const entry = history[job.prompt_id] || Object.values(history)[0];
    if (entry) {
      const status = entry.status || {};
      const statusText = String(status.status_str || "").toLowerCase();
      if (statusText === "error" || statusText === "failed") {
        throw new Error(`ComfyUI execution failed for prompt ${job.prompt_id}.`);
      }
      if (status.completed === true || statusText === "success") {
        job.status = "finalizing";
        if (job.kind === "image") {
          job.finalized = await finalizeImageGeneration(job, entry);
        } else {
          job.finalized = await comfyRequest("/h3_r2v_director/finalize", {
            method: "POST",
            body: {
              project_directory: job.prepared.project_directory,
              episode_directory: job.prepared.episode_directory,
              clip_id: job.clip_id,
              output_prefix: job.prepared.output_prefix,
            },
            timeoutMs: 30000,
          });
        }
        job.status = "completed";
        job.completed_at = new Date().toISOString();
        if ((job.kind || "video") === "video") setTimeout(() => processVideoGenerationQueue(), 0);
        return;
      }
    }
    const queue = await comfyRequest("/queue", { timeoutMs: 5000 });
    const running = (queue.queue_running || []).some((entry) => String(entry[1]) === job.prompt_id);
    const pending = (queue.queue_pending || []).some((entry) => String(entry[1]) === job.prompt_id);
    if (!running && !pending) {
      job.missing_polls = Number(job.missing_polls || 0) + 1;
      if (job.missing_polls >= 5) throw new Error("The prompt is no longer present in the ComfyUI queue or history.");
    } else {
      job.missing_polls = 0;
    }
    job.status = running ? "running" : "queued";
    setTimeout(() => monitorGenerationJob(jobId), 2000);
  } catch (error) {
    job.status = "error";
    job.error = error.message || String(error);
    job.completed_at = new Date().toISOString();
    if ((job.kind || "video") === "video") setTimeout(() => processVideoGenerationQueue(), 0);
  }
}

async function comfyStatus() {
  try {
    const [queue, objectInfo] = await Promise.all([
      comfyRequest("/queue", { timeoutMs: 4000 }),
      comfyRequest("/object_info", { timeoutMs: 7000 }),
    ]);
    const missingNodes = comfyRequiredNodes.filter((name) => !objectInfo[name]);
    const missingModels = comfyRequiredModels
      .filter(([classType, inputName, filename]) => {
        const choices = objectInfo[classType]?.input?.required?.[inputName]?.[0];
        return !Array.isArray(choices) || !choices.includes(filename);
      })
      .map(([, , filename]) => filename);
    const missingZImageNodes = zImageRequiredNodes.filter((name) => !objectInfo[name]);
    const missingZImageModels = zImageRequiredModels
      .filter(([classType, inputName, filename]) => {
        const choices = objectInfo[classType]?.input?.required?.[inputName]?.[0];
        return !Array.isArray(choices) || !choices.includes(filename);
      })
      .map(([, , filename]) => filename);
    return {
      connected: true,
      compatible: missingNodes.length === 0 && missingModels.length === 0,
      url: comfyUiBaseUrl,
      missing_nodes: missingNodes,
      missing_models: missingModels,
      capabilities: {
        h3: {
          compatible: missingNodes.length === 0 && missingModels.length === 0,
          missing_nodes: missingNodes,
          missing_models: missingModels,
        },
        z_image_turbo: {
          compatible: missingZImageNodes.length === 0 && missingZImageModels.length === 0,
          missing_nodes: missingZImageNodes,
          missing_models: missingZImageModels,
        },
      },
      running: (queue.queue_running || []).length,
      pending: (queue.queue_pending || []).length,
    };
  } catch (error) {
    return {
      connected: false,
      compatible: false,
      url: comfyUiBaseUrl,
      missing_nodes: comfyRequiredNodes,
      missing_models: comfyRequiredModels.map(([, , filename]) => filename),
      capabilities: {
        h3: {
          compatible: false,
          missing_nodes: comfyRequiredNodes,
          missing_models: comfyRequiredModels.map(([, , filename]) => filename),
        },
        z_image_turbo: {
          compatible: false,
          missing_nodes: zImageRequiredNodes,
          missing_models: zImageRequiredModels.map(([, , filename]) => filename),
        },
      },
      running: 0,
      pending: 0,
      error: error.message || String(error),
    };
  }
}

function detectImageMime(buffer) {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function expectedImageMime(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return null;
}

function safeUnlink(path) {
  try {
    if (isFile(path)) unlinkSync(path);
  } catch {
    // Cleanup failure must not discard a successfully promoted image.
  }
}

function writeImageAtomically(path, content, overwrite) {
  mkdirSync(dirname(path), { recursive: true });
  const exists = isFile(path);
  if (exists && !overwrite) throw httpError("An image already exists at this declared destination.", 409);

  const nonce = randomUUID();
  const temporaryPath = join(dirname(path), `.${basename(path)}.${nonce}.upload`);
  const backupPath = join(dirname(path), `.${basename(path)}.${nonce}.backup`);
  let originalMoved = false;
  let promoted = false;
  try {
    writeFileSync(temporaryPath, content, { flag: "wx" });
    if (exists) {
      renameSync(path, backupPath);
      originalMoved = true;
    }
    renameSync(temporaryPath, path);
    promoted = true;
    if (originalMoved) safeUnlink(backupPath);
  } catch (error) {
    if (originalMoved && !promoted && isFile(backupPath) && !isFile(path)) {
      try {
        renameSync(backupPath, path);
      } catch (restoreError) {
        throw new Error(`Image save failed and the previous file could not be restored: ${restoreError.message}`);
      }
    }
    throw error;
  } finally {
    safeUnlink(temporaryPath);
    if (promoted) safeUnlink(backupPath);
  }
}

function writeTextAtomically(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const nonce = randomUUID();
  const temporaryPath = join(dirname(path), `.${basename(path)}.${nonce}.tmp`);
  const backupPath = join(dirname(path), `.${basename(path)}.${nonce}.backup`);
  const exists = isFile(path);
  let originalMoved = false;
  let promoted = false;
  try {
    writeFileSync(temporaryPath, String(text), { encoding: "utf8", flag: "wx" });
    if (exists) {
      renameSync(path, backupPath);
      originalMoved = true;
    }
    renameSync(temporaryPath, path);
    promoted = true;
    if (originalMoved) safeUnlink(backupPath);
  } catch (error) {
    if (originalMoved && !promoted && isFile(backupPath) && !isFile(path)) renameSync(backupPath, path);
    throw error;
  } finally {
    safeUnlink(temporaryPath);
    if (promoted) safeUnlink(backupPath);
  }
}

function writeJsonAtomically(path, payload) {
  writeTextAtomically(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function requiredSlug(value, label = "slug") {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw httpError(`${label} must contain lowercase letters, numbers, and single hyphens only.`, 400);
  }
  return slug;
}

function markdownDocument(title, summary = "") {
  const heading = String(title || "Untitled").trim().replace(/[\r\n]+/g, " ");
  const body = String(summary || "").trim();
  return `# ${heading}\n${body ? `\n${body}\n` : ""}`;
}

function resolveCatalogStory(payload) {
  const catalog = buildCatalog();
  const story = catalog.stories.find((candidate) => candidate.id === String(payload.story_id || ""));
  if (!story) throw httpError("Unknown story_id.", 404);
  return { catalog, story, storyDirectory: safeRepositoryPath(story.path) };
}

function resolveCatalogEpisode(payload) {
  const target = resolveCatalogStory(payload);
  const episode = target.story.episodes.find((candidate) => candidate.id === String(payload.episode_id || ""));
  if (!episode) throw httpError("Unknown episode_id.", 404);
  return { ...target, episode, episodeDirectory: safeRepositoryPath(episode.path) };
}

function assertContainedPath(base, value, label) {
  if (typeof value !== "string" || !value.trim()) throw httpError(`${label} must be a non-empty path.`, 400);
  if (isAbsolute(value)) throw httpError(`${label} must be relative.`, 400);
  const candidate = resolve(base, value);
  const rel = relative(base, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw httpError(`${label} must stay inside its declared base directory.`, 400);
  return candidate;
}

function validateStructuredClipPayload(candidate, original, storyDirectory, episodeDirectory) {
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
      ? repositoryRoot
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

function structuredRecords(episodeDirectory) {
  const loaded = loadStructuredClips(episodeDirectory);
  return [...loaded.byId.values()].sort((left, right) => left.payload.sequence - right.payload.sequence);
}

function saveClipSequences(records) {
  records.forEach((record, index) => {
    const sequence = index + 1;
    if (record.payload.sequence === sequence && isFile(record.path)) return;
    record.payload.sequence = sequence;
    writeJsonAtomically(record.path, record.payload);
  });
}

function createStoryContent(payload) {
  const slug = requiredSlug(payload.slug, "Story slug");
  const title = String(payload.title || "").trim();
  if (!title) throw httpError("Story title is required.", 400);
  const storyDirectory = resolve(repositoryRoot, slug);
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

function updateStoryContent(payload) {
  const target = resolveCatalogStory(payload);
  const outlinePath = target.story.outline_path
    ? safeRepositoryPath(target.story.outline_path)
    : join(target.storyDirectory, "outline.md");
  const outline = String(payload.outline_text ?? "");
  if (!outline.trim()) throw httpError("Story outline cannot be empty.", 400);
  writeTextAtomically(outlinePath, outline.endsWith("\n") ? outline : `${outline}\n`);
  return { story_id: target.story.id, outline_path: relativePath(outlinePath) };
}

function createEpisodeContent(payload) {
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

function updateEpisodeContent(payload) {
  const target = resolveCatalogEpisode(payload);
  const outlinePath = target.episode.outline_path
    ? safeRepositoryPath(target.episode.outline_path)
    : join(target.episodeDirectory, "outline.md");
  const outline = String(payload.outline_text ?? "");
  if (!outline.trim()) throw httpError("Episode outline cannot be empty.", 400);
  writeTextAtomically(outlinePath, outline.endsWith("\n") ? outline : `${outline}\n`);
  return { story_id: target.story.id, episode_id: target.episode.id, outline_path: relativePath(outlinePath) };
}

function manualClipReferences(target, records, insertionIndex, mode, payload) {
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

function manualClipPlaceholderPrompt(mode, references) {
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

function createClipContent(payload) {
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

function updateClipContent(payload) {
  const target = resolveCatalogClip(payload);
  const path = safeRepositoryPath(target.clip.structured_path);
  const original = readJson(path);
  if (!original) throw httpError("The structured clip file could not be read.", 400);
  const updated = validateStructuredClipPayload(payload.clip, original, target.storyDirectory, target.episodeDirectory);
  writeJsonAtomically(path, updated);
  return { story_id: target.story.id, episode_id: target.episode.id, clip_id: updated.clip_id, sequence: updated.sequence };
}

function moveClipContent(payload) {
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

function createReferenceContent(payload) {
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

function updateReferenceContent(payload) {
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

function limitedText(value, maximum = 12000) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[truncated]`;
}

function validateDeepSeekBaseUrl(value) {
  const raw = String(value || defaultDeepSeekBaseUrl).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError("DeepSeek base URL must be a valid HTTPS URL.", 400);
  }
  if (parsed.protocol !== "https:") throw httpError("DeepSeek base URL must use HTTPS.", 400);
  return raw;
}

function readAgentConfig() {
  const stored = readJson(agentConfigPath) || {};
  const storedKey = String(stored.api_key || "").trim();
  const environmentKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  const apiKey = storedKey || environmentKey;
  const baseUrl = validateDeepSeekBaseUrl(stored.base_url || process.env.DEEPSEEK_BASE_URL || defaultDeepSeekBaseUrl);
  const model = String(stored.model || process.env.DEEPSEEK_MODEL || defaultDeepSeekModel).trim() || defaultDeepSeekModel;
  return {
    api_key: apiKey,
    api_key_source: storedKey ? "config.local.json" : environmentKey ? "environment" : "none",
    base_url: baseUrl,
    model,
  };
}

function publicAgentConfig() {
  const config = readAgentConfig();
  const key = config.api_key;
  const maskedKey = key ? `${key.slice(0, Math.min(7, key.length))}${"•".repeat(Math.min(8, Math.max(4, key.length - 7)))}` : null;
  return {
    configured: Boolean(key),
    api_key_source: config.api_key_source,
    masked_api_key: maskedKey,
    base_url: config.base_url,
    model: config.model,
    config_path: relativePath(agentConfigPath),
  };
}

function saveAgentConfig(payload) {
  const existing = readJson(agentConfigPath) || {};
  const next = {
    base_url: validateDeepSeekBaseUrl(payload.base_url ?? existing.base_url ?? defaultDeepSeekBaseUrl),
    model: String(payload.model ?? existing.model ?? defaultDeepSeekModel).trim(),
  };
  if (!next.model || next.model.length > 120 || !/^[a-zA-Z0-9._:/-]+$/.test(next.model)) {
    throw httpError("DeepSeek model name is invalid.", 400);
  }
  if (payload.clear_api_key === true) next.api_key = "";
  else if (String(payload.api_key || "").trim()) {
    const key = String(payload.api_key).trim();
    if (key.length > 512) throw httpError("DeepSeek API key is too long.", 400);
    next.api_key = key;
  } else next.api_key = String(existing.api_key || "").trim();
  writeJsonAtomically(agentConfigPath, next);
  return publicAgentConfig();
}

function deepSeekChatUrl(baseUrl) {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

async function deepSeekComplete(messages, { maximumTokens = 4096, temperature = 0.7, jsonMode = false } = {}) {
  const config = readAgentConfig();
  if (!config.api_key) throw httpError("DeepSeek is not configured. Open DeepSeek settings and enter an API key.", 400);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(deepSeekChatUrl(config.base_url), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maximumTokens,
        stream: false,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try {
        result = JSON.parse(responseText);
      } catch {
        result = { raw: responseText };
      }
    }
    if (!response.ok) {
      const message = result.error?.message || result.message || result.raw || `HTTP ${response.status}`;
      if (/insufficient\s+balance|balance\s+is\s+insufficient/i.test(String(message))) {
        throw httpError("DeepSeek account has insufficient balance. Add API credits in the DeepSeek account, then retry.", 402);
      }
      throw httpError(`DeepSeek request failed: ${limitedText(message, 500)}`, response.status === 401 || response.status === 403 ? 401 : 502);
    }
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw httpError("DeepSeek returned an empty response.", 502);
    return {
      content: content.trim().replace(/^```(?:[a-z0-9_-]+)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim(),
      model: result.model || config.model,
      usage: result.usage || null,
    };
  } catch (error) {
    if (error.status) throw error;
    if (error.name === "AbortError") throw httpError("DeepSeek request timed out after 120 seconds.", 504);
    throw httpError(`Could not reach DeepSeek at ${config.base_url}: ${error.message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

function compactReference(reference) {
  return {
    id: reference.id,
    name: reference.name,
    kind: reference.kind,
    scope: reference.scope,
    prompt: limitedText(reference.prompt_text, 1200),
    ready: Boolean(reference.ready),
  };
}

function compactClip(clip) {
  return {
    id: clip.id,
    sequence: clip.sequence,
    title: clip.title,
    duration_seconds: clip.duration,
    generation_mode: clip.type,
    summary: clip.summary,
    video_prompt: limitedText(clip.structured_payload?.video_prompt || clip.prompt_text, 1800),
  };
}

function buildAgentContext(payload) {
  const catalog = buildCatalog();
  const story = catalog.stories.find((candidate) => candidate.id === String(payload.story_id || "")) || null;
  const episode = story?.episodes?.find((candidate) => candidate.id === String(payload.episode_id || "")) || null;
  const clip = episode?.clips?.find((candidate) => candidate.id === String(payload.clip_id || "")) || null;
  const requestedClipIds = Array.isArray(payload.clip_ids) ? [...new Set(payload.clip_ids.map((value) => String(value)))] : [];
  const selectedClips = requestedClipIds.map((clipId) => episode?.clips?.find((candidate) => candidate.id === clipId)).filter(Boolean);
  const allowedFields = [
    "title", "summary", "outline_text", "duration_seconds", "generation_mode", "video_prompt",
    "first_frame_image_prompt", "post_production_instructions", "references", "outputs", "kind", "scope", "slug", "prompt_text",
    "max_clips", "prefer_previous_frame",
  ];
  const fields = {};
  for (const name of allowedFields) {
    if (payload.fields?.[name] === undefined) continue;
    fields[name] = ["number", "boolean"].includes(typeof payload.fields[name])
      ? payload.fields[name]
      : limitedText(payload.fields[name], name === "references" ? 14000 : 8000);
  }
  return {
    request: {
      action: payload.action,
      extra_direction: limitedText(payload.instruction, 4000),
      current_editor_fields: fields,
    },
    story: story ? {
      id: story.id,
      title: story.title,
      summary: story.summary,
      outline: limitedText(story.outline_text, 12000),
      references: (story.references || []).slice(0, 30).map(compactReference),
      episodes: (story.episodes || []).slice(0, 40).map((candidate) => ({
        id: candidate.id,
        number: candidate.number,
        title: candidate.title,
        summary: candidate.summary,
        clip_count: candidate.clip_count,
      })),
    } : null,
    episode: episode ? {
      id: episode.id,
      title: episode.title,
      summary: episode.summary,
      outline: limitedText(episode.outline_text, 12000),
      references: (episode.references || []).slice(0, 30).map(compactReference),
      clips: (episode.clips || []).slice(0, 40).map(compactClip),
    } : null,
    selected_clip: clip ? {
      ...compactClip(clip),
      structured_payload: clip.structured_payload ? {
        ...clip.structured_payload,
        video_prompt: limitedText(clip.structured_payload.video_prompt, 8000),
      } : null,
    } : null,
    selected_clips: selectedClips.map((candidate) => ({
      ...compactClip(candidate),
      structured_payload: candidate.structured_payload ? {
        ...candidate.structured_payload,
        video_prompt: limitedText(candidate.structured_payload.video_prompt, 10000),
      } : null,
    })),
  };
}

function agentReferenceSockets(context) {
  const editorReferences = context.request.current_editor_fields.references;
  if (Array.isArray(editorReferences)) return editorReferences;
  if (typeof editorReferences === "string" && editorReferences.trim()) {
    try {
      const parsed = JSON.parse(editorReferences);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Saving the editor will report malformed reference JSON separately.
    }
  }
  return Array.isArray(context.selected_clip?.structured_payload?.references)
    ? context.selected_clip.structured_payload.references
    : [];
}

function agentActionInstruction(action, context) {
  const title = context.request.current_editor_fields.title || context.episode?.title || context.story?.title || "Untitled";
  const mode = context.request.current_editor_fields.generation_mode || context.selected_clip?.generation_mode || "ref2va";
  const requestedDuration = Number(context.request.current_editor_fields.duration_seconds || context.selected_clip?.duration_seconds || 10);
  const duration = Number.isFinite(requestedDuration) && requestedDuration > 0 ? Math.min(requestedDuration, 15) : 10;
  const referenceSockets = agentReferenceSockets(context);
  const pictureNumbers = [...new Set(referenceSockets.map((reference) => Number(reference?.picture)).filter(Number.isInteger))].sort((a, b) => a - b);
  const continuityRequired = h3RequiresFirstFrameContinuity(referenceSockets, mode);
  const pictureRule = pictureNumbers.length
    ? `Use every and only these available picture sockets: ${pictureNumbers.map((number) => `<Picture ${number}>`).join(", ")}.`
    : "No picture sockets are currently declared. Do not invent any <Picture N> labels.";
  const promptBatchClipIds = (context.selected_clips || []).map((clip) => clip.id);
  const instructions = {
    story_summary: "Write a concise production-ready story summary in one to three paragraphs. Establish the premise, world, central characters, conflict, and trajectory. Return only the summary without a heading.",
    story_outline: `Write or revise the complete Markdown story outline. The first line must be \"# ${title}\". Include premise, themes, world rules, major characters, story arc, and episode direction. Preserve useful supplied facts and improve incomplete areas. Return only Markdown.`,
    episode_summary: "Write a concise episode summary in one to three paragraphs. State the opening situation, main escalation, turning point, ending state, and continuity into adjacent episodes. Return only the summary without a heading.",
    episode_outline: `Write or revise the complete Markdown episode outline. The first line must be \"# ${title}\". This is a production plan, not prose-only treatment: after a concise Episode Goal and Continuity section, include a heading exactly named \"## Clip allocation\". Under it, provide every planned clip in playback order with one Markdown subheading per clip, using \"### Clip 01 — <short title>\" (use an existing clip ID such as \"### clip-01 — <short title>\" when known). For every clip state: **Duration** (normally 10 seconds, never over 15), **What happens** (the exact story action or dialogue), **Visual / camera beat** (the view, movement, and transition), **Audio / dialogue**, **Purpose** (what this clip advances), and **Continuity** (how it begins from or hands off to adjacent clips). Include enough clips to cover the full episode, split any longer scene, speech, or action across sequential clips, and never leave a beat as an unallocated paragraph. Then include \"## Production requirements\" with the characters, environments, objects, and references needed. Preserve existing clip IDs, facts, and known continuity when present. Return only Markdown.`,
    clip_prompt: mode === "ref2va"
      ? `Write a MiniMax H3 Ref2VA prompt for a ${duration}-second clip. ${continuityRequired ? `The first line MUST be exactly: ${h3FirstFrameContinuityInstruction} Put one blank line after it.` : "Do not add a first-frame alignment line unless the supplied reference sockets declare a first-frame anchor."} Then use exactly these six colon-terminated fields in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Do not write a preface, \"six-section structure:\", or bracketed section headings. Keep labels consistent, explicitly begin [Shot 1] from <Picture 1> when continuity is required, describe shots in playback order, and fit all timing inside ${duration} seconds. ${pictureRule} Return only the final prompt.`
      : mode === "i2va"
        ? `Write a MiniMax H3 I2VA prompt for a ${duration}-second clip. ${pictureNumbers.includes(1) ? `The first line MUST be exactly: ${h3FirstFrameContinuityInstruction} Put one blank line after it.` : "Because no first-frame socket is declared, do not invent an alignment instruction or picture label."} Then use exactly the colon-terminated fields integrated_multimodal_description, overall_soundscape, and non_diegetic_music in that order. Explicitly begin [Shot 1] from <Picture 1>, preserve its complete visible state at 0.00 seconds, and develop forward continuously. Fit every cut time inside ${duration} seconds. ${pictureRule} Return only the final prompt.`
        : mode === "t2va" || mode === "t2v"
          ? `Write a MiniMax H3 T2VA prompt for a ${duration}-second text-to-video clip. Use exactly these colon-terminated fields in order: integrated_multimodal_description, overall_soundscape, non_diegetic_music. Build a complete audiovisual timeline with shot composition, subjects, actions, camera, dialogue, and diegetic sound. Fit every cut time inside ${duration} seconds. Do not include picture labels or alignment instructions. Return only the final prompt.`
          : "Write precise post-production instructions for this clip, covering source inputs, edit operations, timing, transitions, audio, and required outputs. Return only the instructions.",
    clip_prompt_batch: `Rewrite the MiniMax H3 video_prompt for every supplied selected_clips entry and return only valid JSON with this exact shape: {"clips":[{"clip_id":"clip-01","video_prompt":"..."}]}. Return exactly these clip IDs once each and no others: ${promptBatchClipIds.join(", ")}. Preserve each clip's generation_mode, duration_seconds, reference order, literal <Picture N> socket set, story facts, dialogue language, and continuity relationship. Each video_prompt must be one complete replacement, not the old prompt followed by a revision. For Ref2VA use the exact six-field format from the skill. For I2VA use its exact three-field format. Whenever Picture 1 is a first-frame anchor or previous clip last frame, begin with the exact 0.00-second continuity sentence required by the skill. Do not change clip IDs, titles, references, outputs, or return any fields other than clip_id and video_prompt.`,
    first_frame_prompt: "Write a single production-ready image-generation prompt for the clip's opening frame. Specify composition, subjects, identity anchors, wardrobe, environment, lighting, lens/camera angle, and exact starting action state. Avoid motion that cannot exist in a still image. Return only the prompt.",
    post_production_instructions: "Write precise post-production instructions covering source inputs, edit operations, order, timing, transitions, typography if any, sound treatment, and output requirements. Return only the instructions.",
    reference_image_prompt: "Write a production-ready Z-Image Turbo reference-image prompt. Isolate and clearly describe the requested character, environment, or object; specify form, materials, colors, identity anchors, lighting, camera, and a clean useful composition. Avoid unnecessary borders, mockup frames, captions, watermarks, and unrelated objects. Return only the prompt.",
    episode_clip_batch: `Create the next production clips that are not already covered by the episode's existing clips. Return only valid JSON with this exact top-level shape: {"new_references":[],"clips":[]}.
Create no more than ${Math.max(1, Math.min(8, Number(context.request.current_editor_fields.max_clips) || 6))} clips. Each clip object must contain title, duration_seconds, generation_mode, use_previous_frame, reference_ids, video_prompt, first_frame_image_prompt, and post_production_instructions. generation_mode must be ref2va, i2va, or post. Prefer 10 seconds and never exceed 15 seconds. Split longer dialogue or actions across sequential clips.
First reuse equivalent references from the supplied story and episode reference lists. Only when a needed character, environment, object, or episode-specific visual does not already have an equivalent reference, propose it in new_references. Propose no more than 12 references and do not propose unused references. Each new reference must contain scope, kind, slug, and prompt_text. Use scope "story" for persistent reusable references and kind "character", "environment", or "object". Use scope "episode" and kind "episode reference" for visuals needed only by this episode. slug must use lowercase letters, numbers, and single hyphens. prompt_text must be a complete production-ready Z-Image Turbo prompt with a clean useful composition and no captions, watermarks, mockup borders, or unrelated objects.
Every clip reference_ids entry must be either an exact supplied reference ID or one of these deterministic proposed IDs: story:character:<slug>, story:environment:<slug>, story:object:<slug>, episode:episode reference:<slug>. For an episode-scoped visual, always use episode:episode reference:<slug> even when the visual depicts a character, environment, or object; never use episode:environment:<slug>, episode:character:<slug>, or episode:object:<slug>. If a clip needs an ID that is not in the supplied lists, add the matching complete entry to new_references instead of returning an unknown ID. Before returning JSON, verify that every reference_ids value resolves to either a supplied reference or a new_references deterministic ID. Attach every proposed reference to at least one clip. Proposed references create prompt records only; do not assume their PNG images already exist.
Use at most 9 picture inputs total. If use_previous_frame is true, <Picture 1> is reserved for the preceding clip's last frame and selected reference IDs begin at <Picture 2>. ${context.request.current_editor_fields.prefer_previous_frame === false ? "Use previous-frame continuity only when essential." : "Prefer previous-frame continuity between sequential clips when it is compatible with the scene."} For every non-post clip whose use_previous_frame is true, including Ref2VA, video_prompt MUST begin with this exact line: ${h3FirstFrameContinuityInstruction} Put exactly one blank line after it, and make [Shot 1] begin from the complete visible state of <Picture 1>. For I2VA, use exactly one picture input—either the previous frame or one reference ID, but not both—and always use that exact first-frame line. For Ref2VA, use exactly the colon-terminated fields subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, and non_diegetic_music in that order; never use bracketed headings or a \"six-section structure:\" preface. Use every declared <Picture N> exactly. Cite every literal <Picture N> token in subject_definitions and again where that reference takes effect in detailed_description. For I2VA, follow the first-frame line with exactly integrated_multimodal_description, overall_soundscape, and non_diegetic_music. Before returning JSON, count the previous-frame input plus reference_ids in each non-post clip and verify that video_prompt contains every and only the corresponding literal <Picture 1> through <Picture N> tags. For post mode, video_prompt must be null and post_production_instructions must be detailed. Continue from existing clips without duplicating their content.`,
  };
  return instructions[action];
}

async function generateAgentContent(payload) {
  const action = String(payload.action || "");
  if (!agentActions.has(action)) throw httpError("Unknown agent action.", 400);
  const context = buildAgentContext({ ...payload, action });
  const system = [
    "You are the AITurboShow production-writing agent.",
    "Use only the supplied production context plus reasonable creative elaboration that does not contradict it.",
    "MiniMax H3 has a hard maximum duration of 15 seconds for one generated clip, and its preferred sweet spot is approximately 10 seconds. Never propose or describe one H3 clip longer than 15 seconds. Split longer story beats, dialogue, and actions into sequential clips, normally targeting 10 seconds each.",
    "Honor the requested language when the extra direction asks for one; otherwise follow the language already used in the project, while MiniMax H3 structural field names remain English.",
    "Return only the requested deliverable. Do not add analysis, explanations, preambles, quotations around the whole result, or Markdown code fences.",
    action === "clip_prompt" ? "Return one complete replacement prompt for the target video_prompt field. The existing prompt is context only: do not repeat it and then append a second version, do not provide before/after variants, and do not return multiple candidate prompts." : "",
    ["clip_prompt", "clip_prompt_batch", "episode_clip_batch"].includes(action) ? `Apply this MiniMax H3 prompt-writing skill exactly:\n\n${deepSeekH3PromptSkill}` : "",
    agentActionInstruction(action, context),
  ].filter(Boolean).join("\n");
  const contextForUser = action === "clip_prompt_batch" && context.episode
    ? {
        ...context,
        episode: {
          ...context.episode,
          clips: (context.episode.clips || []).map(({ video_prompt, ...clipSummary }) => clipSummary),
        },
      }
    : context;
  const contextLimit = action === "clip_prompt_batch" ? 140000 : 50000;
  const user = `Production context:\n${limitedText(JSON.stringify(contextForUser, null, 2), contextLimit)}`;
  const result = await deepSeekComplete([
    { role: "system", content: system },
    { role: "user", content: user },
  ], {
    maximumTokens: ["episode_clip_batch", "clip_prompt_batch"].includes(action) ? 8192 : action === "clip_prompt" || action.endsWith("outline") ? 4096 : 2048,
    temperature: ["episode_clip_batch", "clip_prompt_batch"].includes(action) ? 0.2 : 0.7,
    jsonMode: ["episode_clip_batch", "clip_prompt_batch"].includes(action),
  });
  if (action === "clip_prompt") {
    const mode = context.request.current_editor_fields.generation_mode || context.selected_clip?.generation_mode || "ref2va";
    if (["ref2va", "i2va"].includes(mode)) {
      const referenceSockets = agentReferenceSockets(context);
      const continuityRequired = h3RequiresFirstFrameContinuity(referenceSockets, mode);
      const content = withH3FirstFrameContinuity(result.content, continuityRequired);
      assertH3PromptFormat(content, mode, continuityRequired);
      const pictureNumbers = [...new Set(referenceSockets.map((reference) => Number(reference?.picture)).filter(Number.isInteger))].sort((a, b) => a - b);
      const usedPictures = [...new Set([...content.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1])))].sort((a, b) => a - b);
      if (JSON.stringify(usedPictures) !== JSON.stringify(pictureNumbers)) {
        throw httpError(`DeepSeek prompt picture tags ${JSON.stringify(usedPictures)} do not match reference sockets ${JSON.stringify(pictureNumbers)}.`, 502);
      }
      return { action, ...result, content };
    }
  }
  return { action, ...result };
}

function parseAgentJsonObject(content) {
  const text = String(content || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        // Fall through to a useful API error below.
      }
    }
  }
  throw httpError("DeepSeek returned an invalid clip-plan JSON document. Retry the batch or reduce the requested clip count.", 502);
}

async function generateBatchClipPromptPreview(payload) {
  const target = resolveCatalogEpisode(payload);
  const requestedIds = Array.isArray(payload.clip_ids) ? [...new Set(payload.clip_ids.map((value) => String(value)))] : [];
  if (!requestedIds.length) throw httpError("Select at least one clip for batch prompt regeneration.", 400);
  const clipsById = new Map((target.episode.clips || []).map((clip) => [clip.id, clip]));
  const requestedClips = requestedIds.map((clipId) => {
    const clip = clipsById.get(clipId);
    if (!clip) throw httpError(`Unknown clip_id for prompt regeneration: ${clipId}`, 404);
    if (!clip.structured_payload || !["ref2va", "i2va"].includes(clip.type)) {
      throw httpError(`${clipId} is not a structured Ref2VA or I2VA clip.`, 400);
    }
    return clip;
  });
  const plannedClips = new Map();
  for (const clip of requestedClips) {
    const clipTarget = resolveCatalogClip({ story_id: target.story.id, episode_id: target.episode.id, clip_id: clip.id });
    if (payload.include_dependency_chain === true) collectClipDependencyPlan(clipTarget, plannedClips);
    else plannedClips.set(`${target.story.id}:${target.episode.id}:${clip.id}`, clip);
  }
  const planned = [...plannedClips.values()].sort((left, right) => left.sequence - right.sequence);
  if (planned.length > 8) throw httpError("Batch prompt regeneration supports at most 8 clips at once. Choose an earlier target or regenerate the chain in sections.", 400);
  const expandedClipIds = planned.map((clip) => clip.id);
  const previews = [];
  const models = new Set();
  const usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  for (const [index, clip] of planned.entries()) {
    const original = clip.structured_payload;
    let generated = null;
    let previousError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const correction = previousError
        ? `The previous replacement prompt was rejected by deterministic validation: ${previousError.message}\nReturn one corrected complete replacement prompt only.`
        : "";
      try {
        generated = await generateAgentContent({
          action: "clip_prompt",
          story_id: target.story.id,
          episode_id: target.episode.id,
          clip_id: clip.id,
          instruction: [
            `This is clip ${index + 1} of ${planned.length} in dependency-expanded batch ${expandedClipIds.join(" -> ")}.`,
            correction,
            payload.instruction,
          ].filter(Boolean).join("\n\n"),
          fields: {
            generation_mode: clip.type,
            duration_seconds: clip.duration,
            video_prompt: original.video_prompt,
            references: JSON.stringify(original.references, null, 2),
          },
        });
        const continuityRequired = h3RequiresFirstFrameContinuity(original.references, original.generation_mode);
        const videoPrompt = withH3FirstFrameContinuity(generated.content, continuityRequired);
        const updated = validateStructuredClipPayload(
          { ...original, video_prompt: videoPrompt },
          original,
          target.storyDirectory,
          target.episodeDirectory,
        );
        previews.push({
          clip_id: clip.id,
          sequence: clip.sequence,
          title: clip.title,
          generation_mode: clip.type,
          duration_seconds: clip.duration,
          video_prompt: updated.video_prompt,
        });
        if (generated.model) models.add(generated.model);
        for (const key of Object.keys(usage)) usage[key] += Number(generated.usage?.[key] || 0);
        previousError = null;
        break;
      } catch (error) {
        previousError = error;
        if (attempt === 2 || ![400, 502].includes(Number(error.status))) throw error;
      }
    }
    if (previousError) throw previousError;
  }
  return {
    story_id: target.story.id,
    episode_id: target.episode.id,
    include_dependency_chain: payload.include_dependency_chain === true,
    requested_clip_ids: requestedIds,
    expanded_clip_ids: previews.map((clip) => clip.clip_id),
    prompt_count: previews.length,
    clips: previews,
    model: [...models].join(", "),
    usage,
  };
}

function updateClipPromptsContent(payload) {
  const target = resolveCatalogEpisode(payload);
  if (!Array.isArray(payload.prompts) || !payload.prompts.length) throw httpError("prompts must be a non-empty array.", 400);
  if (payload.prompts.length > 8) throw httpError("At most 8 clip prompts can be saved at once.", 400);
  const recordsById = new Map(structuredRecords(target.episodeDirectory).map((record) => [record.payload.clip_id, record]));
  const seen = new Set();
  const validated = payload.prompts.map((entry) => {
    const clipId = String(entry?.clip_id || "");
    if (!clipId || seen.has(clipId)) throw httpError("Each prompt entry requires a unique clip_id.", 400);
    seen.add(clipId);
    const record = recordsById.get(clipId);
    if (!record) throw httpError(`Unknown structured clip_id: ${clipId}`, 404);
    const original = readJson(record.path);
    if (!original || !["ref2va", "i2va"].includes(original.generation_mode)) {
      throw httpError(`${clipId} does not support an H3 video prompt.`, 400);
    }
    const continuityRequired = h3RequiresFirstFrameContinuity(original.references, original.generation_mode);
    const videoPrompt = withH3FirstFrameContinuity(String(entry.video_prompt || "").trim(), continuityRequired);
    return {
      path: record.path,
      payload: validateStructuredClipPayload(
        { ...original, video_prompt: videoPrompt },
        original,
        target.storyDirectory,
        target.episodeDirectory,
      ),
    };
  });
  validated.forEach((record) => writeJsonAtomically(record.path, record.payload));
  return {
    story_id: target.story.id,
    episode_id: target.episode.id,
    updated_count: validated.length,
    clip_ids: validated.map((record) => record.payload.clip_id),
  };
}

function normalizedReferenceSlug(value, fallback) {
  const slug = String(value || fallback || "reference")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug || "reference";
}

function proposedReferenceRecord(target, entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw httpError(`DeepSeek new reference ${index + 1} is invalid.`, 502);
  }
  const scope = String(entry.scope || "").trim();
  const slug = requiredSlug(entry.slug, `DeepSeek new reference ${index + 1} slug`);
  const promptText = String(entry.prompt_text || "").trim();
  if (!promptText) throw httpError(`DeepSeek new reference ${index + 1} is missing prompt_text.`, 502);

  let kind;
  let base;
  if (scope === "story") {
    const directoryByKind = { character: "characters", environment: "environments", object: "objects" };
    kind = String(entry.kind || "").trim();
    if (!directoryByKind[kind]) {
      throw httpError(`DeepSeek new story reference ${index + 1} kind must be character, environment, or object.`, 502);
    }
    base = join(target.storyDirectory, directoryByKind[kind]);
  } else if (scope === "episode") {
    const requestedKind = String(entry.kind || "").trim();
    if (!["episode reference", "character", "environment", "object"].includes(requestedKind)) {
      throw httpError(`DeepSeek new episode reference ${index + 1} kind must be episode reference, character, environment, or object.`, 502);
    }
    kind = "episode reference";
    base = join(target.episodeDirectory, "reference-images");
  } else {
    throw httpError(`DeepSeek new reference ${index + 1} scope must be story or episode.`, 502);
  }

  const promptPath = join(base, "prompts", `${slug}.prompt`);
  const generationDirectory = scope === "episode" ? join(base, "generated") : join(base, "images");
  const generationPath = join(generationDirectory, `${slug}.png`);
  return {
    id: `${scope}:${kind}:${slug}`,
    slug,
    name: slug.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    kind,
    scope,
    prompt_path: relativePath(promptPath),
    prompt_text: promptText,
    generation_path: relativePath(generationPath),
    upload_path: relativePath(generationPath),
    images: [],
    ready: false,
    upload_ready: false,
  };
}

function createAgentClipBatch(payload, generatedContent, commit = true) {
  const target = resolveCatalogEpisode(payload);
  const requestedMaximum = Number(payload.max_clips || 6);
  const maximumClips = Number.isInteger(requestedMaximum) && requestedMaximum >= 1 && requestedMaximum <= 8 ? requestedMaximum : 6;
  const parsed = parseAgentJsonObject(generatedContent);
  if (!Array.isArray(parsed.clips) || !parsed.clips.length) throw httpError("DeepSeek returned no clips.", 502);
  if (parsed.clips.length > maximumClips) throw httpError(`DeepSeek returned more than the requested ${maximumClips} clips.`, 502);
  const proposedEntries = parsed.new_references === undefined ? [] : parsed.new_references;
  if (!Array.isArray(proposedEntries)) throw httpError("DeepSeek new_references must be an array.", 502);
  if (proposedEntries.length > 12) throw httpError("DeepSeek returned more than 12 new references.", 502);

  const records = structuredRecords(target.episodeDirectory);
  const numericIds = records.map((record) => Number(String(record.payload.clip_id).match(/\d+/)?.[0])).filter(Number.isFinite);
  const firstNumericId = Math.max(0, ...numericIds) + 1;
  const episodeRelative = relative(target.storyDirectory, target.episodeDirectory).split(sep).join("/");
  const availableReferences = [...(target.story.references || []), ...(target.episode.references || [])];
  const referenceById = new Map(availableReferences.map((reference) => [reference.id, reference]));
  const proposedById = new Map();
  const referencesToCreate = [];
  for (const [index, entry] of proposedEntries.entries()) {
    const proposed = proposedReferenceRecord(target, entry, index);
    const duplicateProposal = proposedById.get(proposed.id);
    if (duplicateProposal) {
      if (duplicateProposal.prompt_text.trim() !== proposed.prompt_text.trim()) {
        throw httpError(`DeepSeek proposed conflicting prompt text for reference_id: ${proposed.id}`, 502);
      }
      continue;
    }
    proposedById.set(proposed.id, proposed);
    const existing = referenceById.get(proposed.id);
    if (existing) {
      if (String(existing.prompt_text || "").trim() !== proposed.prompt_text.trim()) {
        throw httpError(`DeepSeek proposed reference_id ${proposed.id}, but that reference already exists with different prompt text.`, 502);
      }
      continue;
    }
    if (isFile(safeRepositoryPath(proposed.prompt_path))) {
      throw httpError(`Reference prompt already exists outside the current catalog: ${proposed.prompt_path}`, 409);
    }
    referenceById.set(proposed.id, proposed);
    referencesToCreate.push(proposed);
  }
  const referencesToCreateIds = new Set(referencesToCreate.map((reference) => reference.id));
  const planned = [];
  const usedProposedReferenceIds = new Set();

  for (const [index, entry] of parsed.clips.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw httpError(`DeepSeek clip ${index + 1} is invalid.`, 502);
    const clipId = `clip-${String(firstNumericId + index).padStart(2, "0")}`;
    const mode = String(entry.generation_mode || "ref2va").trim();
    if (!["ref2va", "i2va", "post"].includes(mode)) throw httpError(`DeepSeek clip ${index + 1} has an unsupported generation mode.`, 502);
    const duration = Number(entry.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 15) {
      throw httpError(`DeepSeek clip ${index + 1} must be greater than 0 and no more than 15 seconds.`, 502);
    }
    const title = String(entry.title || "").trim();
    if (!title) throw httpError(`DeepSeek clip ${index + 1} is missing a title.`, 502);
    const referenceIds = Array.isArray(entry.reference_ids) ? [...new Set(entry.reference_ids.map((value) => String(value)))] : [];
    const selectedReferences = referenceIds.map((id) => {
      let reference = referenceById.get(id);
      if (!reference) {
        const aliasMatch = id.match(/^(story|episode):[^:]+:([a-z0-9]+(?:-[a-z0-9]+)*)$/);
        if (aliasMatch) {
          const matches = [...proposedById.values()].filter((candidate) => candidate.scope === aliasMatch[1] && candidate.slug === aliasMatch[2]);
          if (matches.length === 1) reference = referenceById.get(matches[0].id) || matches[0];
        }
      }
      if (!reference) throw httpError(`DeepSeek clip ${index + 1} selected unknown reference_id: ${id}`, 502);
      if (referencesToCreateIds.has(reference.id)) usedProposedReferenceIds.add(reference.id);
      return reference;
    });
    const usePreviousFrame = entry.use_previous_frame === true;
    const previousClipId = index > 0 ? `clip-${String(firstNumericId + index - 1).padStart(2, "0")}` : records.at(-1)?.payload.clip_id || null;
    if (usePreviousFrame && !previousClipId) throw httpError(`DeepSeek clip ${index + 1} requested a previous frame but no preceding structured clip exists.`, 502);
    const pictureCount = (usePreviousFrame ? 1 : 0) + selectedReferences.length;
    if (pictureCount > 9) throw httpError(`DeepSeek clip ${index + 1} exceeds MiniMax H3's 9-picture limit.`, 502);
    if (mode === "i2va" && pictureCount !== 1) throw httpError(`DeepSeek I2VA clip ${index + 1} must have exactly one first-frame picture.`, 502);
    if (mode !== "post" && pictureCount < 1) throw httpError(`DeepSeek clip ${index + 1} requires at least one available reference image or previous-frame dependency.`, 502);

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
    const usedReferenceSlugs = new Set(references.map((reference) => reference.id));
    for (const [referenceIndex, reference] of selectedReferences.entries()) {
      let id = normalizedReferenceSlug(reference.slug, `reference-${referenceIndex + 1}`);
      let suffix = 2;
      while (usedReferenceSlugs.has(id)) id = `${normalizedReferenceSlug(reference.slug, "reference").slice(0, 64)}-${suffix++}`;
      usedReferenceSlugs.add(id);
      const imagePath = relative(target.storyDirectory, safeRepositoryPath(reference.generation_path)).split(sep).join("/");
      const promptPath = relative(target.storyDirectory, safeRepositoryPath(reference.prompt_path)).split(sep).join("/");
      references.push({
        picture: mode === "post" ? null : nextPicture++,
        id,
        role: reference.kind || "visual_reference",
        description: generatedReferenceDescription(reference),
        source: { type: "file", path: imagePath, prompt_path: promptPath },
      });
    }

    const continuityRequired = mode !== "post" && (mode === "i2va" || usePreviousFrame);
    const videoPrompt = mode === "post"
      ? null
      : withH3FirstFrameContinuity(String(entry.video_prompt || "").trim(), continuityRequired);
    if (mode !== "post") assertH3PromptFormat(videoPrompt, mode, continuityRequired);
    const clipPayload = {
      $schema: "../../AITurboShow/schemas/clip.schema.json",
      schema_version: 1,
      clip_id: clipId,
      sequence: records.length + index + 1,
      title,
      path_base: "story",
      generation_mode: mode,
      duration_seconds: duration,
      video_prompt: videoPrompt,
      first_frame_image_prompt: String(entry.first_frame_image_prompt || "").trim() || null,
      post_production_instructions: String(entry.post_production_instructions || "").trim() || null,
      references,
      outputs: {
        video: { path: `${episodeRelative}/generated/clips/${clipId}.mp4`, artifact_id: `${clipId}:video` },
        last_frame: { path: `${episodeRelative}/generated/frames/${clipId}-last.png`, artifact_id: `${clipId}:last_frame` },
      },
    };
    planned.push({
      path: join(target.episodeDirectory, `${clipId}.json`),
      payload: validateStructuredClipPayload(clipPayload, null, target.storyDirectory, target.episodeDirectory),
    });
  }

  const unusedProposals = referencesToCreate.filter((reference) => !usedProposedReferenceIds.has(reference.id));
  if (unusedProposals.length) {
    throw httpError(`DeepSeek proposed unused references: ${unusedProposals.map((reference) => reference.id).join(", ")}`, 502);
  }

  if (commit) {
    for (const reference of referencesToCreate) {
      const promptPath = safeRepositoryPath(reference.prompt_path);
      if (isFile(promptPath)) throw httpError(`A reference prompt already uses ${reference.id}.`, 409);
    }
    referencesToCreate.forEach((reference) => writeTextAtomically(safeRepositoryPath(reference.prompt_path), `${reference.prompt_text}\n`));
    planned.forEach((record) => writeJsonAtomically(record.path, record.payload));
  }
  return {
    story_id: target.story.id,
    episode_id: target.episode.id,
    created_count: commit ? planned.length : 0,
    preview_count: planned.length,
    created_reference_count: commit ? referencesToCreate.length : 0,
    preview_reference_count: referencesToCreate.length,
    references: referencesToCreate.map((reference) => ({
      reference_id: reference.id,
      scope: reference.scope,
      kind: reference.kind,
      prompt_path: reference.prompt_path,
      generation_path: reference.generation_path,
    })),
    clips: planned.map((record) => ({
      clip_id: record.payload.clip_id,
      sequence: record.payload.sequence,
      title: record.payload.title,
      duration_seconds: record.payload.duration_seconds,
      generation_mode: record.payload.generation_mode,
      reference_count: record.payload.references.length,
    })),
  };
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
]);

function sendJson(response, payload, status = 200) {
  const content = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  response.end(content);
}

function sendFile(request, response, path, cacheControl = "private, max-age=30") {
  if (resolve(path).toLowerCase() === resolve(agentConfigPath).toLowerCase()) {
    sendJson(response, { error: "Forbidden." }, 403);
    return;
  }
  if (!isFile(path)) {
    sendJson(response, { error: "File not found." }, 404);
    return;
  }
  const size = statSync(path).size;
  const headers = {
    "Content-Type": mimeTypes.get(extname(path).toLowerCase()) || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
  };
  const range = String(request.headers.range || "").trim();
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
        response.end();
        return;
      }
      start = Math.max(0, size - suffixLength);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    end = Math.min(end, size - 1);
    response.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "Content-Length": size });
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
}

function extractApiToken(request, url) {
  const header = String(request.headers.authorization || "");
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  const query = url.searchParams.get("token");
  if (query) return query;
  return "";
}

function apiTokenAuthorized(request, url) {
  if (!apiToken) return true;
  const remote = request.socket?.remoteAddress || "";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLoopback) return true;
  const provided = extractApiToken(request, url);
  if (!provided) return false;
  const expected = Buffer.from(apiToken);
  const candidate = Buffer.from(provided);
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}

function createApplicationServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/") && !apiTokenAuthorized(request, url)) {
        sendJson(response, { error: "Unauthorized. Provide the AITurboShow token." }, 401);
        return;
      }
      if (url.pathname === "/api/health") {
        sendJson(response, { ok: true, name: "AITurboShow" });
        return;
      }
      if (url.pathname === "/api/catalog") {
        sendJson(response, buildCatalog());
        return;
      }
      if (url.pathname === "/api/content/story") {
        if (!["POST", "PUT"].includes(request.method)) {
          response.setHeader("Allow", "POST, PUT");
          sendJson(response, { error: "Use POST to create or PUT to update a story." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const result = request.method === "POST" ? createStoryContent(payload) : updateStoryContent(payload);
        sendJson(response, { ok: true, ...result }, request.method === "POST" ? 201 : 200);
        return;
      }
      if (url.pathname === "/api/content/episode") {
        if (!["POST", "PUT"].includes(request.method)) {
          response.setHeader("Allow", "POST, PUT");
          sendJson(response, { error: "Use POST to create or PUT to update an episode." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const result = request.method === "POST" ? createEpisodeContent(payload) : updateEpisodeContent(payload);
        sendJson(response, { ok: true, ...result }, request.method === "POST" ? 201 : 200);
        return;
      }
      if (url.pathname === "/api/content/clip") {
        if (!["POST", "PUT"].includes(request.method)) {
          response.setHeader("Allow", "POST, PUT");
          sendJson(response, { error: "Use POST to create or PUT to update a clip." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const result = request.method === "POST" ? createClipContent(payload) : updateClipContent(payload);
        sendJson(response, { ok: true, ...result }, request.method === "POST" ? 201 : 200);
        return;
      }
      if (url.pathname === "/api/content/clip-prompts") {
        if (request.method !== "PUT") {
          response.setHeader("Allow", "PUT");
          sendJson(response, { error: "Use PUT to save reviewed clip prompt replacements." }, 405);
          return;
        }
        sendJson(response, { ok: true, ...updateClipPromptsContent(await readJsonRequest(request)) });
        return;
      }
      if (url.pathname === "/api/content/clip/move") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to move a clip." }, 405);
          return;
        }
        sendJson(response, { ok: true, ...moveClipContent(await readJsonRequest(request)) });
        return;
      }
      if (url.pathname === "/api/content/reference") {
        if (!["POST", "PUT"].includes(request.method)) {
          response.setHeader("Allow", "POST, PUT");
          sendJson(response, { error: "Use POST to create or PUT to update a reference." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const result = request.method === "POST" ? createReferenceContent(payload) : updateReferenceContent(payload);
        sendJson(response, { ok: true, ...result }, request.method === "POST" ? 201 : 200);
        return;
      }
      if (url.pathname === "/api/agent/config") {
        if (request.method === "GET") {
          sendJson(response, publicAgentConfig());
          return;
        }
        if (request.method === "PUT") {
          sendJson(response, { ok: true, ...saveAgentConfig(await readJsonRequest(request)) });
          return;
        }
        response.setHeader("Allow", "GET, PUT");
        sendJson(response, { error: "Use GET to inspect or PUT to save DeepSeek configuration." }, 405);
        return;
      }
      if (url.pathname === "/api/agent/test") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to test the DeepSeek connection." }, 405);
          return;
        }
        const result = await deepSeekComplete([
          { role: "system", content: "Reply with exactly: AITurboShow DeepSeek agent ready" },
          { role: "user", content: "Connection test" },
        ], { maximumTokens: 32, temperature: 0 });
        sendJson(response, { ok: true, model: result.model, message: result.content, usage: result.usage });
        return;
      }
      if (url.pathname === "/api/agent/generate") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to generate production content." }, 405);
          return;
        }
        sendJson(response, { ok: true, ...(await generateAgentContent(await readJsonRequest(request))) });
        return;
      }
      if (url.pathname === "/api/lab/rewrite") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, { error: "Use POST to rewrite a lab prompt." }, 405); return; }
        const payload = await readJsonRequest(request);
        const mode = String(payload.mode || "image");
        const prompt = String(payload.prompt || "").trim();
        if (!prompt) throw httpError("A prompt is required.", 400);
        const action = mode === "video" ? "clip_prompt" : "reference_image_prompt";
        const video = mode === "video" ? labVideoInputs(payload) : null;
        const result = await generateAgentContent({ action, instruction: String(payload.instruction || ""), fields: {
          title: "Standalone generation test", generation_mode: video?.mode || "t2va",
          duration_seconds: video?.duration || 6, prompt_text: prompt, ...(video ? { video_prompt: prompt } : {}),
          references: JSON.stringify(video?.references || []),
        }});
        sendJson(response, { ok: true, mode, content: result.content, model: result.model, usage: result.usage });
        return;
      }
      if (url.pathname === "/api/lab/history") {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); sendJson(response, { error: "Use GET to read lab history." }, 405); return; }
        const items = readLabHistory().map((item) => ({ ...item, preview_urls: item.preview_urls || (item.outputs || []).map((output) => `/api/lab/output?prompt_id=${encodeURIComponent(item.prompt_id)}&filename=${encodeURIComponent(output.filename)}&subfolder=${encodeURIComponent(output.subfolder || "")}&type=${encodeURIComponent(output.type || "output")}`) }));
        sendJson(response, { ok: true, items });
        return;
      }
      if (url.pathname === "/api/lab/references") {
        if (request.method === "GET") { sendJson(response, { ok: true, items: readLabReferences() }); return; }
        if (request.method !== "POST" && request.method !== "DELETE") { response.setHeader("Allow", "GET, POST, DELETE"); sendJson(response, { error: "Use GET, POST, or DELETE for lab references." }, 405); return; }
        const payload = await readJsonRequest(request); const items = readLabReferences();
        if (request.method === "POST") {
          const name = String(payload.name || "Reference").trim(); const image = String(payload.image || "").trim();
          if (!image) throw httpError("Reference image path is required.", 400);
          labReferencePath(image);
          if (items.length >= 100) throw httpError("The reference library is full. Remove a reference before adding another.", 400);
          const item = { id: randomUUID(), name: name || "Reference", image, created_at: new Date().toISOString() }; items.push(item); saveLabReferences(items); sendJson(response, { ok: true, item }, 201); return;
        }
        const remaining = items.filter((item) => item.id !== String(payload.id || "")); saveLabReferences(remaining); sendJson(response, { ok: true, items: remaining }); return;
      }
      if (url.pathname === "/api/lab/history/sync") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, { error: "Use POST to sync lab history." }, 405); return; }
        sendJson(response, { ok: true, items: await syncLabHistory() });
        return;
      }
      if (url.pathname === "/api/lab/output") {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); sendJson(response, { error: "Use GET to preview a lab output." }, 405); return; }
        const promptId = url.searchParams.get("prompt_id"); const filename = url.searchParams.get("filename");
        if (!promptId || !filename) throw httpError("Missing output identifiers.", 400);
        const run = readLabHistory().find((item) => item.prompt_id === promptId);
        if (!run?.outputs?.some((output) => output.filename === filename && (output.subfolder || "") === (url.searchParams.get("subfolder") || "") && (output.type || "output") === (url.searchParams.get("type") || "output"))) throw httpError("Output does not belong to a saved lab run.", 404);
        const binary = await comfyBinaryRequest(`/view?${new URLSearchParams({ filename, subfolder: url.searchParams.get("subfolder") || "", type: url.searchParams.get("type") || "output" })}`);
        const ext = extname(filename).toLowerCase(); const contentType = ({ ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" })[ext] || "application/octet-stream";
        response.writeHead(200, { "Content-Type": contentType, "Content-Length": binary.length, "Cache-Control": "public, max-age=31536000" }); response.end(binary); return;
      }
      if (url.pathname === "/api/lab/generate-video") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, { error: "Use POST to queue a lab video." }, 405); return; }
        const payload = await readJsonRequest(request);
        const videoPrompt = String(payload.video_prompt || "").trim();
        if (!videoPrompt) throw httpError("video_prompt is required.", 400);
        const video = labVideoInputs(payload);
        const { duration } = video;
        const options = labOptions(payload.options || {}, true);
        const usedPictures = [...new Set([...videoPrompt.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1])))].sort((a, b) => a - b);
        if (JSON.stringify(usedPictures) !== JSON.stringify(video.references.map((ref) => ref.picture))) throw httpError("Prompt Picture tags must match the selected references. Rewrite the prompt after changing references.", 400);
        const references = await uploadLabReferences(video.references);
        const labId = randomUUID();
        const built = buildH3R2VPrompt({ video_prompt: videoPrompt, duration_seconds: duration, references, ref_image_size: "match", output_prefix: `aiturboshow/lab/video/${labId}`, project_directory: toolDirectory, episode_directory: toolDirectory, path_base: "story", last_frame_path: `lab/${labId}-last.png`, last_frame_staging: `aiturboshow-lab/${labId}-last.png` }, options);
        const queued = await comfyRequest("/prompt", { method: "POST", body: { prompt: built.prompt, client_id: `aiturboshow-lab-${randomUUID()}` }, timeoutMs: 30000 });
        if (!queued.prompt_id) throw httpError("ComfyUI rejected the lab video prompt.", 502);
        const entry = appendLabHistory({ id: randomUUID(), kind: "video", prompt_id: queued.prompt_id, prompt: videoPrompt, video_mode: video.mode, references: video.references, duration_seconds: duration, width: built.width, height: built.height, steps: built.steps, seed: built.seed, created_at: new Date().toISOString(), status: "queued" });
        sendJson(response, { ok: true, ...entry }, 202);
        return;
      }
      if (url.pathname === "/api/lab/generate-image") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, { error: "Use POST to queue a lab image." }, 405); return; }
        const payload = await readJsonRequest(request);
        const promptText = String(payload.prompt || "").trim();
        if (!promptText) throw httpError("prompt is required.", 400);
        const { width, height, seed, steps } = labOptions(payload);
        const outputPrefix = `aiturboshow/lab/${randomUUID()}`;
        const prompt = { "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } }, "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } }, "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } }, "4": { class_type: "CLIPTextEncode", inputs: { text: promptText, clip: ["2", 0] } }, "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } }, "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } }, "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } }, "8": { class_type: "KSampler", inputs: { model: ["7", 0], seed, steps, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], denoise: 1 } }, "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } }, "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: outputPrefix } } };
        const queued = await comfyRequest("/prompt", { method: "POST", body: { prompt, client_id: `aiturboshow-lab-image-${randomUUID()}` }, timeoutMs: 30000 });
        if (!queued.prompt_id) throw httpError("ComfyUI rejected the lab image prompt.", 502);
        const entry = appendLabHistory({ id: randomUUID(), kind: "image", prompt_id: queued.prompt_id, prompt: promptText, width, height, seed, steps, created_at: new Date().toISOString(), status: "queued" });
        sendJson(response, { ok: true, ...entry }, 202);
        return;
      }
      if (url.pathname === "/api/agent/regenerate-prompts") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to preview regenerated clip prompts." }, 405);
          return;
        }
        sendJson(response, { ok: true, ...(await generateBatchClipPromptPreview(await readJsonRequest(request))) });
        return;
      }
      if (url.pathname === "/api/agent/create-clips") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to generate and create an automatic clip batch." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const maximum = Number(payload.max_clips || 6);
        if (!Number.isInteger(maximum) || maximum < 1 || maximum > 8) throw httpError("max_clips must be an integer from 1 to 8.", 400);
        const target = resolveCatalogEpisode(payload);
        const batchKey = `${target.story.id}:${target.episode.id}`;
        if (activeAgentClipBatches.has(batchKey)) throw httpError("An automatic clip batch is already running for this episode.", 409);
        activeAgentClipBatches.add(batchKey);
        try {
          const committed = payload.preview_only !== true;
          let generated;
          let batch;
          const validationErrors = [];
          const maximumAttempts = 3;
          let attempts = 0;
          for (; attempts < maximumAttempts; attempts += 1) {
            const previousValidationError = validationErrors.at(-1);
            const correction = previousValidationError
              ? `Your previous clip-batch JSON was rejected by deterministic server validation: ${previousValidationError.message}\nRegenerate the entire JSON document from scratch and return JSON only. If the error identifies an unknown reference_id, either replace it with an exact supplied reference ID or add a complete matching new_references entry containing scope, kind, slug, and a production-ready Z-Image Turbo prompt_text, then use its canonical deterministic ID. Never return an undeclared reference ID. For every non-post clip, count use_previous_frame plus reference_ids, then include every and only the resulting literal <Picture 1> through <Picture N> tags in video_prompt. Whenever use_previous_frame is true, including Ref2VA, begin video_prompt exactly with: ${h3FirstFrameContinuityInstruction} Then put one blank line before the required prompt fields. In Ref2VA prompts, cite each tag in subject_definitions and detailed_description while preserving all six required colon-terminated sections in order.`
              : "";
            generated = await generateAgentContent({
              action: "episode_clip_batch",
              story_id: target.story.id,
              episode_id: target.episode.id,
              instruction: [correction, payload.instruction].filter(Boolean).join("\n\n"),
              fields: {
                max_clips: maximum,
                prefer_previous_frame: payload.prefer_previous_frame !== false,
              },
            });
            try {
              batch = createAgentClipBatch(payload, generated.content, committed);
              break;
            } catch (error) {
              const canRetry = attempts < maximumAttempts - 1 && [400, 502].includes(Number(error.status));
              if (!canRetry) throw error;
              validationErrors.push(error);
            }
          }
          if (!batch) throw validationErrors.at(-1) || httpError("DeepSeek did not return a valid automatic clip batch.", 502);
          sendJson(response, {
            ok: true,
            preview_only: !committed,
            model: generated.model,
            usage: generated.usage,
            agent_attempts: attempts + 1,
            validation_recovered: validationErrors.length > 0,
            validation_recovery_count: validationErrors.length,
            ...batch,
          }, committed ? 201 : 200);
        } finally {
          activeAgentClipBatches.delete(batchKey);
        }
        return;
      }
      if (url.pathname === "/api/comfy/status") {
        sendJson(response, await comfyStatus());
        return;
      }
      if (url.pathname === "/api/comfy/jobs") {
        const jobs = [...generationJobs.values()]
          .sort((left, right) => right.queued_at.localeCompare(left.queued_at))
          .map(publicGenerationJob);
        const summary = {
          waiting: jobs.filter((job) => job.status === "waiting").length,
          active: jobs.filter((job) => ["preparing", "queued", "running", "finalizing"].includes(job.status)).length,
          completed: jobs.filter((job) => job.status === "completed").length,
          errors: jobs.filter((job) => job.status === "error").length,
        };
        sendJson(response, { jobs, summary });
        return;
      }
      if (url.pathname === "/api/comfy/jobs/cancel") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to cancel a generation task." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const job = generationJobs.get(String(payload.job_id || ""));
        if (!job) throw httpError("Unknown generation job_id.", 404);
        await cancelGenerationJob(job);
        sendJson(response, { ok: true, job: publicGenerationJob(job) });
        return;
      }
      if (url.pathname === "/api/comfy/validate") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to validate a clip." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const target = resolveCatalogClip(payload);
        const validation = await comfyRequest("/h3_r2v_director/validate", {
          method: "POST",
          body: comfyControllerPayload(target),
          timeoutMs: 30000,
        });
        const clip = validation.clips?.find((candidate) => candidate.clip_id === target.clip.id);
        if (!clip) throw httpError("ComfyUI validation did not return the selected clip.", 502);
        sendJson(response, { ok: true, clip, project: validation });
        return;
      }
      if (url.pathname === "/api/comfy/generate") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to queue an H3 clip." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const target = resolveCatalogClip(payload);
        const result = enqueueVideoGenerationWithDependencies(target, payload);
        const automaticDependencies = [...new Map(result.dependency_jobs.map((job) => [job.id, job])).values()];
        sendJson(response, {
          job: publicGenerationJob(result.job),
          duplicate: result.duplicate,
          automatic_dependency_count: automaticDependencies.filter((job) => job.clip_id !== target.clip.id).length,
          automatic_dependencies: automaticDependencies.map(publicGenerationJob),
        }, 202);
        return;
      }
      if (url.pathname === "/api/comfy/generate-batch") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to queue multiple H3 clips." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const target = resolveCatalogEpisode(payload);
        const requestedIds = payload.whole_episode === true
          ? (target.episode.clips || []).map((clip) => clip.id)
          : Array.isArray(payload.clip_ids)
            ? [...new Set(payload.clip_ids.map((value) => String(value)))]
            : [];
        if (!requestedIds.length) throw httpError("Select at least one clip or use whole_episode: true.", 400);
        if (requestedIds.length > 100) throw httpError("A batch can contain at most 100 clips.", 400);
        const clipsById = new Map((target.episode.clips || []).map((clip) => [clip.id, clip]));
        const selected = requestedIds.map((clipId) => {
          const clip = clipsById.get(clipId);
          if (!clip) throw httpError(`Unknown clip_id in batch: ${clipId}`, 404);
          return clip;
        }).sort((left, right) => left.sequence - right.sequence);
        const batchId = randomUUID();
        const queuedJobs = [];
        const duplicates = [];
        const skipped = [];
        const queueable = selected.filter((clip) => {
          if (!clip.structured_path || !["ref2va", "i2va"].includes(clip.type)) {
            skipped.push({ clip_id: clip.id, reason: clip.type === "post" ? "Post-production clip" : "Unsupported or unstructured clip" });
            return false;
          }
          if (clip.complete && payload.force !== true) {
            skipped.push({ clip_id: clip.id, reason: "Outputs already complete" });
            return false;
          }
          const missing = missingClipReferences(clip);
          if (missing.fixed.length) {
            skipped.push({ clip_id: clip.id, reason: `${missing.fixed.length} fixed reference image(s) missing` });
            return false;
          }
          return true;
        });
        if (payload.preview_only === true) {
          const plannedClips = new Map();
          for (const clip of queueable) {
            collectVideoGenerationPlan(resolveCatalogClip({
              story_id: target.story.id,
              episode_id: target.episode.id,
              clip_id: clip.id,
            }), plannedClips, new Set(), payload.include_dependency_chain === true);
          }
          const planned = [...plannedClips.values()].sort((left, right) => left.sequence - right.sequence);
          sendJson(response, {
            ok: true,
            preview_only: true,
            include_dependency_chain: payload.include_dependency_chain === true,
            requested_count: selected.length,
            selected_queueable_count: queueable.length,
            queueable_count: planned.length,
            automatic_dependency_count: Math.max(0, planned.length - queueable.length),
            skipped_count: skipped.length,
            clips: planned.map((clip) => ({
              clip_id: clip.id,
              sequence: clip.sequence,
              title: clip.title,
              generation_mode: clip.type,
              duration_seconds: clip.duration,
              complete: clip.complete,
              ready: clip.ready,
            })),
            skipped,
          });
          return;
        }
        const jobIdsBeforeBatch = new Set(generationJobs.keys());
        for (const [index, clip] of queueable.entries()) {
          const clipTarget = resolveCatalogClip({ story_id: target.story.id, episode_id: target.episode.id, clip_id: clip.id });
          const result = enqueueVideoGenerationWithDependencies(clipTarget, payload, { id: batchId, index: index + 1, total: queueable.length });
          if (result.duplicate) duplicates.push(publicGenerationJob(result.job));
        }
        const createdBatchJobs = [...generationJobs.values()]
          .filter((job) => !jobIdsBeforeBatch.has(job.id) && job.batch_id === batchId)
          .sort((left, right) => Number(left.queue_order || 0) - Number(right.queue_order || 0));
        createdBatchJobs.forEach((job, index) => {
          job.batch_index = index + 1;
          job.batch_total = createdBatchJobs.length;
          queuedJobs.push(publicGenerationJob(job));
        });
        sendJson(response, {
          ok: true,
          batch_id: batchId,
          requested_count: selected.length,
          queued_count: queuedJobs.length,
          duplicate_count: duplicates.length,
          skipped_count: skipped.length,
          jobs: queuedJobs,
          duplicates,
          skipped,
        }, 202);
        return;
      }
      if (url.pathname === "/api/comfy/image/validate") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to validate a reference image." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const target = resolveCatalogReference(payload);
        const status = await comfyStatus();
        const capability = status.capabilities?.z_image_turbo;
        if (!status.connected) throw httpError(status.error || "ComfyUI is offline.", 502);
        if (!capability?.compatible) {
          const missing = [...(capability?.missing_nodes || []), ...(capability?.missing_models || [])];
          throw httpError(`Z-Image Turbo setup is incomplete: ${missing.join(", ")}`, 400);
        }
        sendJson(response, {
          ok: true,
          reference: {
            id: target.reference.id,
            prompt_path: target.reference.prompt_path,
            destination: target.reference.generation_path,
            ready: target.reference.ready,
            default_size: defaultReferenceImageSize(target.reference),
          },
        });
        return;
      }
      if (url.pathname === "/api/comfy/image/generate") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to queue a Z-Image Turbo reference image." }, 405);
          return;
        }
        const payload = await readJsonRequest(request);
        const target = resolveCatalogReference(payload);
        const status = await comfyStatus();
        const capability = status.capabilities?.z_image_turbo;
        if (!status.connected) throw httpError(status.error || "ComfyUI is offline.", 502);
        if (!capability?.compatible) {
          const missing = [...(capability?.missing_nodes || []), ...(capability?.missing_models || [])];
          throw httpError(`Z-Image Turbo setup is incomplete: ${missing.join(", ")}`, 400);
        }
        const active = [...generationJobs.values()].find((job) => (
          job.kind === "image"
          && job.story_id === target.story.id
          && job.reference_id === target.reference.id
          && ["queued", "running", "finalizing"].includes(job.status)
        ));
        if (active) {
          sendJson(response, { job: publicGenerationJob(active), duplicate: true }, 202);
          return;
        }
        if (target.reference.ready && payload.force !== true) {
          throw httpError("This reference already has a generated image. Confirm regeneration and send force: true.", 409);
        }
        const built = buildZImageTurboPrompt(target, payload.options || {});
        const externallyQueued = await findQueuedComfyImage(built.outputPrefix);
        if (externallyQueued) {
          throw httpError(`This reference is already queued in ComfyUI as prompt ${externallyQueued.prompt_id}.`, 409);
        }
        const queued = await comfyRequest("/prompt", {
          method: "POST",
          body: { prompt: built.prompt, client_id: `aiturboshow-image-${randomUUID()}` },
          timeoutMs: 30000,
        });
        if (!queued.prompt_id) {
          const details = queued.node_errors ? JSON.stringify(queued.node_errors) : "No prompt ID returned.";
          throw httpError(`ComfyUI rejected the image prompt: ${details}`, 502);
        }
        const job = {
          id: randomUUID(),
          kind: "image",
          prompt_id: queued.prompt_id,
          story_id: target.story.id,
          episode_id: target.episode?.id || null,
          reference_id: target.reference.id,
          destination: target.reference.generation_path,
          destination_absolute: target.destination,
          save_node_id: "10",
          status: "queued",
          seed: built.seed,
          width: built.width,
          height: built.height,
          queued_at: new Date().toISOString(),
        };
        generationJobs.set(job.id, job);
        setTimeout(() => monitorGenerationJob(job.id), 250);
        sendJson(response, { job: publicGenerationJob(job), queue_number: queued.number }, 202);
        return;
      }
      if (url.pathname === "/api/upload-image") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, { error: "Use POST to upload an image." }, 405);
          return;
        }
        const requestedPath = url.searchParams.get("path");
        if (!requestedPath) throw httpError("Missing declared image destination.", 400);
        const catalog = buildCatalog();
        const targetPath = collectUploadTargets(catalog).get(requestedPath);
        if (!targetPath) throw httpError("This path is not a declared image destination in the structured clip data.", 403);

        const content = await readRequestBody(request, maximumUploadBytes, "Image");
        if (!content.length) throw httpError("The uploaded image is empty.", 400);
        const detectedMime = detectImageMime(content);
        if (!detectedMime) throw httpError("Only valid PNG, JPEG, and WebP images can be uploaded.", 415);
        const expectedMime = expectedImageMime(targetPath);
        if (detectedMime !== expectedMime) {
          throw httpError(`The image data must match the declared ${extname(targetPath).toLowerCase()} destination.`, 415);
        }
        const suppliedMime = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        if (suppliedMime && suppliedMime !== "application/octet-stream" && suppliedMime !== detectedMime) {
          throw httpError("The upload content type does not match the image data.", 415);
        }

        const overwrite = url.searchParams.get("overwrite") === "1";
        writeImageAtomically(targetPath, content, overwrite);
        sendJson(response, {
          ok: true,
          path: requestedPath,
          size: content.length,
          asset: assetRecord(targetPath),
        }, 201);
        return;
      }
      if (url.pathname === "/api/asset") {
        const value = url.searchParams.get("path");
        if (!value) {
          sendJson(response, { error: "Missing path." }, 400);
          return;
        }
        sendFile(request, response, safeRepositoryPath(value));
        return;
      }
      const staticName = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[/\\]+/, "");
      const staticPath = resolve(toolDirectory, staticName);
      const rel = relative(toolDirectory, staticPath);
      if (rel.startsWith("..")) {
        sendJson(response, { error: "Forbidden." }, 403);
        return;
      }
      sendFile(request, response, staticPath, "no-cache");
    } catch (error) {
      console.error(error);
      sendJson(response, { error: error.message || String(error) }, Number(error.status) || 500);
    }
  });
}

const args = process.argv.slice(2);
let host = "127.0.0.1";
let port = 8765;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--host" && args[index + 1]) host = args[++index];
  else if (args[index] === "--port" && args[index + 1]) port = Number(args[++index]);
  else if (args[index] === "--comfy-url" && args[index + 1]) comfyUiBaseUrl = String(args[++index]).replace(/\/+$/, "");
  else if (args[index] === "--token" && args[index + 1]) apiToken = String(args[++index]).trim();
}

const server = createApplicationServer();
server.listen(port, host, () => {
  console.log(`AITurboShow is available at http://${host}:${port}`);
  console.log(`Scanning story projects under ${repositoryRoot}`);
  console.log(`ComfyUI backend: ${comfyUiBaseUrl}`);
  console.log(apiToken ? "API token required for non-loopback clients." : "No API token set; loopback-only binding recommended.");
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
