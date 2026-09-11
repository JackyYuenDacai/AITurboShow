import { createServer } from "node:http";
import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { env, backends, generationJobs, activeAgentClipBatches } from "./state.mjs";
import { maximumUploadBytes, h3FirstFrameContinuityInstruction } from "./constants.mjs";
import { sendJson, sendFile, readJsonRequest, readRequestBody, apiTokenAuthorized, collectUploadTargets, httpError } from "./http.mjs";
import { buildCatalog, assetRecord } from "./catalog.mjs";
import { buildH3R2VPrompt, buildZImageTurboPrompt, comfyControllerPayload, comfyStatus, resolveCatalogClip, resolveCatalogReference, findQueuedComfyImage, defaultReferenceImageSize } from "./comfy.mjs";
import { publicGenerationJob, cancelGenerationJob, enqueueVideoGenerationWithDependencies, collectVideoGenerationPlan, missingClipReferences, monitorGenerationJob } from "./generation.mjs";
import { createStoryContent, updateStoryContent, createEpisodeContent, updateEpisodeContent, createClipContent, updateClipContent, moveClipContent, createReferenceContent, updateReferenceContent, resolveCatalogEpisode } from "./content.mjs";
import { publicAgentConfig, saveAgentConfig, deepSeekComplete, generateBatchClipPromptPreview, createAgentClipBatch, updateClipPromptsContent } from "./agent.mjs";
import { appendLabHistory, labOptions, labReferencePath, labVideoInputs, syncLabHistory, uploadLabReferences } from "./lab.mjs";
import { writeImageAtomically, detectImageMime, expectedImageMime } from "./files.mjs";
import { safeRepositoryPath } from "./fs-utils.mjs";

export function createApplicationServer() {
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
        sendJson(response, { ok: true, ...(await backends.generateAgentContent(await readJsonRequest(request))) });
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
        const result = await backends.generateAgentContent({ action, instruction: String(payload.instruction || ""), fields: {
          title: "Standalone generation test", generation_mode: video?.mode || "t2va",
          duration_seconds: video?.duration || 6, prompt_text: prompt, ...(video ? { video_prompt: prompt } : {}),
          references: JSON.stringify(video?.references || []),
        }});
        sendJson(response, { ok: true, mode, content: result.content, model: result.model, usage: result.usage });
        return;
      }
      if (url.pathname === "/api/lab/history") {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); sendJson(response, { error: "Use GET to read lab history." }, 405); return; }
        const items = backends.readLabHistory().map((item) => ({ ...item, preview_urls: item.preview_urls || (item.outputs || []).map((output) => `/api/lab/output?prompt_id=${encodeURIComponent(item.prompt_id)}&filename=${encodeURIComponent(output.filename)}&subfolder=${encodeURIComponent(output.subfolder || "")}&type=${encodeURIComponent(output.type || "output")}`) }));
        sendJson(response, { ok: true, items });
        return;
      }
      if (url.pathname === "/api/lab/references") {
        if (request.method === "GET") { sendJson(response, { ok: true, items: backends.readLabReferences() }); return; }
        if (request.method !== "POST" && request.method !== "DELETE") { response.setHeader("Allow", "GET, POST, DELETE"); sendJson(response, { error: "Use GET, POST, or DELETE for lab references." }, 405); return; }
        const payload = await readJsonRequest(request); const items = backends.readLabReferences();
        if (request.method === "POST") {
          const name = String(payload.name || "Reference").trim(); const image = String(payload.image || "").trim();
          if (!image) throw httpError("Reference image path is required.", 400);
          labReferencePath(image);
          if (items.length >= 100) throw httpError("The reference library is full. Remove a reference before adding another.", 400);
          const item = { id: randomUUID(), name: name || "Reference", image, created_at: new Date().toISOString() }; items.push(item); backends.saveLabReferences(items); sendJson(response, { ok: true, item }, 201); return;
        }
        const remaining = items.filter((item) => item.id !== String(payload.id || "")); backends.saveLabReferences(remaining); sendJson(response, { ok: true, items: remaining }); return;
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
        const run = backends.readLabHistory().find((item) => item.prompt_id === promptId);
        if (!run?.outputs?.some((output) => output.filename === filename && (output.subfolder || "") === (url.searchParams.get("subfolder") || "") && (output.type || "output") === (url.searchParams.get("type") || "output"))) throw httpError("Output does not belong to a saved lab run.", 404);
        const binary = await backends.comfyBinaryRequest(`/view?${new URLSearchParams({ filename, subfolder: url.searchParams.get("subfolder") || "", type: url.searchParams.get("type") || "output" })}`);
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
        const built = buildH3R2VPrompt({ video_prompt: videoPrompt, duration_seconds: duration, references, ref_image_size: "match", output_prefix: `aiturboshow/lab/video/${labId}`, project_directory: env.toolDirectory, episode_directory: env.toolDirectory, path_base: "story", last_frame_path: `lab/${labId}-last.png`, last_frame_staging: `aiturboshow-lab/${labId}-last.png` }, options);
        const queued = await backends.comfyRequest("/prompt", { method: "POST", body: { prompt: built.prompt, client_id: `aiturboshow-lab-${randomUUID()}` }, timeoutMs: 30000 });
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
        const queued = await backends.comfyRequest("/prompt", { method: "POST", body: { prompt, client_id: `aiturboshow-lab-image-${randomUUID()}` }, timeoutMs: 30000 });
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
            generated = await backends.generateAgentContent({
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
        const validation = await backends.comfyRequest("/h3_r2v_director/validate", {
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
        if (payload.options?.use_sol_h3 === true) {
          const status = await comfyStatus();
          const capability = status.capabilities?.sol_h3;
          if (!status.connected) throw httpError(status.error || "ComfyUI is offline.", 502);
          if (!capability?.compatible) throw httpError("Sol-H3 is not installed in ComfyUI. Install BSAI-ComfyUI-Sol-H3 and restart ComfyUI.", 400);
        }
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
        const queued = await backends.comfyRequest("/prompt", {
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
      const staticPath = resolve(env.toolDirectory, staticName);
      const rel = relative(env.toolDirectory, staticPath);
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
