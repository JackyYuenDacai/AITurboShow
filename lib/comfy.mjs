import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { backends, runtime } from "./state.mjs";
import { buildCatalog } from "./catalog.mjs";
import { comfyRequiredNodes, comfyRequiredModels, zImageRequiredNodes, zImageRequiredModels, h3FirstFrameContinuityInstruction } from "./constants.mjs";
import { httpError } from "./http.mjs";
import { safeRepositoryPath } from "./fs-utils.mjs";

export async function comfyRequest(pathname, { method = "GET", body = null, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${runtime.comfyUiBaseUrl}${pathname}`, {
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
    throw httpError(`Cannot reach ComfyUI at ${runtime.comfyUiBaseUrl}: ${message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function comfyBinaryRequest(pathname, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${runtime.comfyUiBaseUrl}${pathname}`, { signal: controller.signal });
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

export function resolveCatalogClip(payload) {
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

export function resolveCatalogReference(payload, { requireGeneration = true } = {}) {
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

export function comfyControllerPayload(target, clipId = null) {
  const episodeRelative = relative(target.storyDirectory, target.episodeDirectory).split(sep).join("/");
  const base = {
    project_directory: target.storyDirectory,
    episode_directory: episodeRelative,
    input_subfolder: `h3_r2v/${target.story.id}/${target.episode.id}`,
    output_prefix: `video/${target.story.id}/${target.episode.id}`,
  };
  return clipId ? { ...base, clip_id: clipId } : base;
}

export async function findQueuedComfyClip(target) {
  const expectedPrefix = `${comfyControllerPayload(target).output_prefix}/${target.clip.id}`;
  const queue = await backends.comfyRequest("/queue", { timeoutMs: 5000 });
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

export async function findQueuedComfyImage(outputPrefix) {
  const queue = await backends.comfyRequest("/queue", { timeoutMs: 5000 });
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

export function randomSeed() {
  const high = Math.floor(Math.random() * 0x1fffff);
  const low = Math.floor(Math.random() * 0x100000000);
  return high * 0x100000000 + low;
}

export function roundedImageDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(256, Math.min(2048, Math.round(number / 16) * 16));
}

export function defaultReferenceImageSize(reference) {
  if (reference.kind === "character") return { width: 768, height: 1024 };
  if (reference.kind === "environment" || reference.scope === "episode") return { width: 1344, height: 768 };
  return { width: 1024, height: 1024 };
}

export function buildZImageTurboPrompt(target, options = {}) {
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

export function h3FrameLength(durationSeconds) {
  const frames = Math.max(5, Math.round(Number(durationSeconds) * 24));
  return frames + ((5 - (frames % 17)) + 17) % 17;
}

export function roundedVideoDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(256, Math.min(2048, Math.round(number / 32) * 32));
}

export function h3VideoSize(options = {}) {
  return {
    width: roundedVideoDimension(options.width, 864),
    height: roundedVideoDimension(options.height, 480),
  };
}

export function h3SolOptions(options = {}) {
  return {
    use_sol_h3: options.use_sol_h3 === true,
    sol_tau: Number.isFinite(Number(options.sol_tau)) ? Math.max(0.1, Math.min(4, Number(options.sol_tau))) : 1.3,
    sol_start_percent: Number.isFinite(Number(options.sol_start_percent)) ? Math.max(0, Math.min(1, Number(options.sol_start_percent))) : 0.2,
    sol_end_percent: Number.isFinite(Number(options.sol_end_percent)) ? Math.max(0, Math.min(1, Number(options.sol_end_percent))) : 0.9,
    sol_min_tokens: Number.isFinite(Number(options.sol_min_tokens)) ? Math.max(256, Math.min(262144, Math.round(Number(options.sol_min_tokens) / 256) * 256)) : 12288,
    sol_sink_conditioning: ["exact_kv", "exact_kv_and_rows", "off"].includes(options.sol_sink_conditioning) ? options.sol_sink_conditioning : "exact_kv",
    sol_morton: options.sol_morton === true,
    sol_centroid_tail: options.sol_centroid_tail !== false,
    sol_routed_cap_percent: Number.isFinite(Number(options.sol_routed_cap_percent)) ? Math.max(0, Math.min(100, Math.round(Number(options.sol_routed_cap_percent) / 5) * 5)) : 0,
    sol_reuse_qkv_memory: options.sol_reuse_qkv_memory === true,
    sol_dense_blocks: String(options.sol_dense_blocks || "").slice(0, 200),
  };
  return video ? { ...result, ...h3SolOptions(payload) } : result;
}

export function h3RequiresFirstFrameContinuity(references = [], generationMode = "ref2va") {
  const pictureOne = Array.isArray(references)
    ? references.find((reference) => Number(reference?.picture) === 1)
    : null;
  if (!pictureOne) return false;
  return generationMode === "i2va"
    || pictureOne.role === "first_frame_anchor"
    || (pictureOne.source?.type === "clip_artifact" && pictureOne.source?.artifact === "last_frame");
}

export function withH3FirstFrameContinuity(prompt, required) {
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

export function assertH3PromptFormat(prompt, generationMode, continuityRequired = false) {
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

export function buildH3R2VPrompt(job, options = {}) {
  const { width, height } = h3VideoSize(options);
  const seed = Number.isSafeInteger(Number(options.seed)) ? Number(options.seed) : randomSeed();
  const steps = Math.max(1, Math.min(100, Number(options.steps || 20)));
  const scheduler = ["simple", "beta", "normal"].includes(options.scheduler) ? options.scheduler : "simple";
  const refImageSize = options.ref_image_size === "max" ? "max" : "match";
  const sol = h3SolOptions(options);
  const prompt = {
    "1": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "2": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "3": sol.use_sol_h3
      ? { class_type: "BSAI_SolH3_Loader", inputs: {
          model_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", precision: "default", sol_attn: true,
          tau_start: 0.5, tau_end: 1.0, sink_conditioning: sol.sol_sink_conditioning, int8_qk: true,
          fused_modulation: true, chunk_ff: true, chunk_size: 2, fast_h3_steps: "50步 原生高质量", sampler: "euler",
          cfg: 4.0, shift: 8.0, audio_shift: 3.0, min_tokens: sol.sol_min_tokens, sol_tau: sol.sol_tau,
          start_percent: sol.sol_start_percent, end_percent: sol.sol_end_percent, morton: sol.sol_morton,
          morton_curve: "2d_frame", centroid_tail: sol.sol_centroid_tail, routed_cap_percent: sol.sol_routed_cap_percent,
          reuse_qkv_memory: sol.sol_reuse_qkv_memory, verbose: false, dense_blocks: sol.sol_dense_blocks,
          tau_profile: "", lora_name: "FastH3-4step-LoRA.safetensors", lora_strength: 0,
        } }
      : { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", weight_dtype: "default" } },
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
  return { prompt, seed, width, height, steps, scheduler, ref_image_size: refImageSize, ...sol };
}

export async function comfyStatus() {
  try {
    const [queue, objectInfo] = await Promise.all([
      backends.comfyRequest("/queue", { timeoutMs: 4000 }),
      backends.comfyRequest("/object_info", { timeoutMs: 7000 }),
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
    const solH3MissingNodes = objectInfo.BSAI_SolH3_Loader ? [] : ["BSAI_SolH3_Loader"];
    return {
      connected: true,
      compatible: missingNodes.length === 0 && missingModels.length === 0,
      url: runtime.comfyUiBaseUrl,
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
        sol_h3: { compatible: solH3MissingNodes.length === 0, missing_nodes: solH3MissingNodes, missing_models: [] },
      },
      running: (queue.queue_running || []).length,
      pending: (queue.queue_pending || []).length,
    };
  } catch (error) {
    return {
      connected: false,
      compatible: false,
      url: runtime.comfyUiBaseUrl,
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
        sol_h3: { compatible: false, missing_nodes: ["BSAI_SolH3_Loader"], missing_models: [] },
      },
      running: 0,
      pending: 0,
      error: error.message || String(error),
    };
  }
}
