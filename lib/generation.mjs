import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { backends, runtime, generationJobs } from "./state.mjs";
import { buildH3R2VPrompt, comfyControllerPayload, h3RequiresFirstFrameContinuity, h3VideoSize, withH3FirstFrameContinuity, findQueuedComfyClip, resolveCatalogClip } from "./comfy.mjs";
import { detectImageMime, writeImageAtomically } from "./files.mjs";
import { httpError } from "./http.mjs";

export function publicGenerationJob(job) {
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

export function activeVideoGenerationJob() {
  return [...generationJobs.values()].find((job) => (
    (job.kind || "video") === "video"
    && ["preparing", "queued", "running", "finalizing"].includes(job.status)
  )) || null;
}

export function videoGenerationJobFor(storyId, episodeId, clipId) {
  return [...generationJobs.values()].find((job) => (
    (job.kind || "video") === "video"
    && job.story_id === storyId
    && job.episode_id === episodeId
    && job.clip_id === clipId
    && ["waiting", "preparing", "queued", "running", "finalizing"].includes(job.status)
  )) || null;
}

export function missingClipReferences(clip) {
  const missing = (clip.references || []).filter((reference) => !reference.ready);
  return {
    dependencies: missing.filter((reference) => reference.dependency?.clip_id),
    fixed: missing.filter((reference) => !reference.dependency?.clip_id),
  };
}

export function clipDependencyReferences(clip) {
  return (clip.references || []).filter((reference) => reference.dependency?.clip_id);
}

export function enqueueVideoGenerationJob(target, payload = {}, batch = null) {
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
    queue_order: ++runtime.generationQueueSequence,
    queued_at: new Date().toISOString(),
    batch_id: batch?.id || null,
    batch_index: batch?.index || null,
    batch_total: batch?.total || null,
  };
  generationJobs.set(job.id, job);
  setTimeout(() => processVideoGenerationQueue(), 0);
  return { job, duplicate: false };
}

export function enqueueVideoGenerationWithDependencies(target, payload = {}, batch = null, ancestry = new Set()) {
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

export function collectVideoGenerationPlan(target, collected = new Map(), ancestry = new Set(), includeDependencyChain = false) {
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

export function collectClipDependencyPlan(target, collected = new Map(), ancestry = new Set()) {
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

export async function cancelComfyPrompt(promptId) {
  if (!promptId) return false;
  const queue = await backends.comfyRequest("/queue", { timeoutMs: 5000 });
  const running = (queue.queue_running || []).some((entry) => String(entry[1]) === String(promptId));
  const pending = (queue.queue_pending || []).some((entry) => String(entry[1]) === String(promptId));
  if (running) {
    await backends.comfyRequest("/interrupt", { method: "POST", body: {}, timeoutMs: 10000 });
    return true;
  }
  if (pending) {
    await backends.comfyRequest("/queue", { method: "POST", body: { delete: [String(promptId)] }, timeoutMs: 10000 });
    return true;
  }
  return false;
}

export async function cancelGenerationJob(job) {
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

export async function processVideoGenerationQueue() {
  if (runtime.processingVideoGenerationQueue || activeVideoGenerationJob()) return;
  const job = [...generationJobs.values()]
    .filter((candidate) => (candidate.kind || "video") === "video" && candidate.status === "waiting")
    .sort((left, right) => Number(left.queue_order || 0) - Number(right.queue_order || 0))[0];
  if (!job) return;
  runtime.processingVideoGenerationQueue = true;
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
    const prepared = await backends.comfyRequest("/h3_r2v_director/prepare", {
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
    const queued = await backends.comfyRequest("/prompt", {
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
    runtime.processingVideoGenerationQueue = false;
    if (["error", "skipped", "cancelled"].includes(job.status)) setTimeout(() => processVideoGenerationQueue(), 0);
  }
}

export async function finalizeImageGeneration(job, historyEntry) {
  const images = historyEntry?.outputs?.[job.save_node_id || "10"]?.images || [];
  const image = images[0];
  if (!image?.filename) throw new Error("ComfyUI completed without returning a saved image.");
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  const content = await backends.comfyBinaryRequest(`/view?${query.toString()}`);
  if (detectImageMime(content) !== "image/png") {
    throw new Error("Z-Image Turbo did not return a valid PNG image.");
  }
  writeImageAtomically(job.destination_absolute, content, true);
  return {
    image: job.destination,
    comfyui_image: `${image.subfolder ? `${image.subfolder}/` : ""}${image.filename}`,
  };
}

export async function monitorGenerationJob(jobId) {
  const job = generationJobs.get(jobId);
  if (!job || ["completed", "error", "cancelled", "skipped"].includes(job.status)) return;
  try {
    const history = await backends.comfyRequest(`/history/${encodeURIComponent(job.prompt_id)}`, { timeoutMs: 5000 });
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
          job.finalized = await backends.comfyRequest("/h3_r2v_director/finalize", {
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
    const queue = await backends.comfyRequest("/queue", { timeoutMs: 5000 });
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
