import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { backends, runtime, labHistoryPath, labReferencesPath } from "./state.mjs";
import { isFile, safeRepositoryPath, readJson } from "./fs-utils.mjs";
import { writeJsonAtomically } from "./files.mjs";
import { randomSeed } from "./comfy.mjs";
import { httpError } from "./http.mjs";
import { imageExtensions, videoExtensions, maximumUploadBytes } from "./constants.mjs";

export function readLabHistory() { return readJson(labHistoryPath) || []; }

export function saveLabHistory(history) { writeJsonAtomically(labHistoryPath, history.slice(-100)); }

export function appendLabHistory(entry) { const history = backends.readLabHistory(); history.push(entry); backends.saveLabHistory(history); return entry; }

export function readLabReferences() { return readJson(labReferencesPath) || []; }

export function saveLabReferences(items) { writeJsonAtomically(labReferencesPath, items.slice(0, 100)); }

export function labNumber(value, fallback, min, max, name, step = 1) {
  const number = value === undefined ? fallback : Number(value);
  if (value === null || value === "" || !Number.isSafeInteger(number) || number < min || number > max || number % step !== 0) {
    throw httpError(`${name} must be an integer from ${min} to ${max}${step > 1 ? ` in multiples of ${step}` : ""}.`, 400);
  }
  return number;
}

export function labOptions(payload, video = false) {
  const result = {
    width: labNumber(payload.width, video ? 864 : 1024, 256, 2048, "Width", video ? 32 : 16),
    height: labNumber(payload.height, video ? 480 : 1024, 256, 2048, "Height", video ? 32 : 16),
    steps: labNumber(payload.steps, video ? 20 : 15, 1, video ? 100 : 50, "Steps"),
    seed: payload.seed === undefined ? randomSeed() : labNumber(payload.seed, 0, 0, Number.MAX_SAFE_INTEGER, "Seed"),
  };
  return result;
}

export function labReferencePath(image) {
  let path;
  try { path = safeRepositoryPath(image); } catch { throw httpError("Reference image must be inside the repository.", 400); }
  if (!imageExtensions.has(extname(path).toLowerCase()) || !isFile(path)) throw httpError("Reference must point to an existing repository image.", 400);
  if (statSync(path).size > maximumUploadBytes) throw httpError("Reference image exceeds the 50 MB limit.", 400);
  return path;
}

export function labVideoInputs(payload) {
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

export async function uploadLabReferences(references) {
  const staged = [];
  for (const reference of references) {
    const path = labReferencePath(reference.image);
    const form = new FormData();
    form.append("image", new Blob([readFileSync(path)]), `${randomUUID()}${extname(path)}`);
    form.append("type", "input");
    form.append("subfolder", "aiturboshow-lab");
    const uploaded = await backends.comfyRequest("/upload/image", { method: "POST", body: form, timeoutMs: 30000 });
    if (!uploaded.name) throw httpError("ComfyUI did not accept the reference image.", 502);
    staged.push({ ...reference, image: [uploaded.subfolder, uploaded.name].filter(Boolean).join("/") });
  }
  return staged;
}

export async function syncLabHistory() {
  if (runtime.labHistorySync) return runtime.labHistorySync;
  runtime.labHistorySync = (async () => {
    if (!backends.readLabHistory().some((item) => ["queued", "running"].includes(item.status))) return backends.readLabHistory();
    const [completed, queue] = await Promise.all([
      backends.comfyRequest("/history", { timeoutMs: 5000 }), backends.comfyRequest("/queue", { timeoutMs: 5000 }),
    ]);
    // Read again after the network calls so newly queued runs are preserved.
    const history = backends.readLabHistory();
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
    if (changed) backends.saveLabHistory(history);
    return history;
  })();
  try { return await runtime.labHistorySync; } finally { runtime.labHistorySync = null; }
}
