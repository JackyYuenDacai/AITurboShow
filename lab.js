const $ = (id) => document.getElementById(id);
const isVideo = location.pathname.includes("video-lab");
const kind = isVideo ? "video" : "image";
const draftKey = `aiturboshow.lab.${kind}.v2`;
const fieldIds = ["prompt", "instruction", "width", "height", "steps", "seed", ...(isVideo ? ["mode", "duration"] : [])];
let references = [];
let selectedIds = new Set();
let history = [];
let historySignature = "";
let refreshing = false;
let busy = false;
let undoPrompt = null;
let previewFocus = null;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const status = (message, type = "") => { $("status").textContent = message; $("status").className = `lab-status ${type}`; };

async function request(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(path, {
    method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function saveDraft() {
  try { localStorage.setItem(draftKey, JSON.stringify({ fields: Object.fromEntries(fieldIds.map((id) => [id, $(id).value])), selected: [...selectedIds], references: references.filter((ref) => selectedIds.has(ref.id)), output: $("output").value })); } catch { /* Private browsing may disable storage. */ }
}
function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey) || "null");
    if (!draft) return;
    for (const id of fieldIds) if (draft.fields?.[id] !== undefined) $(id).value = draft.fields[id];
    selectedIds = new Set(draft.selected || []);
    references = draft.references || [];
    $("output").value = draft.output || "";
  } catch { /* Ignore an obsolete or unavailable draft. */ }
}
function updateSettings() {
  const size = `${$("width").value}x${$("height").value}`;
  $("sizePreset").value = [...$("sizePreset").options].some((option) => option.value === size) ? size : "custom";
  $("settingsSummary").textContent = `${$("width").value} × ${$("height").value} · ${$("steps").value} steps${isVideo ? ` · ${$("duration").value}s / 24 fps` : ""}`;
  $("promptCount").textContent = `${$("prompt").value.length.toLocaleString()} characters`;
  $("copyPrompt").disabled = !$("output").value;
  $("usePrompt").disabled = !$("output").value || busy;
  $("undoPrompt").disabled = undoPrompt === null || busy;
}
function setBusy(value) {
  busy = value;
  $("labForm").setAttribute("aria-busy", String(value));
  $("rewrite").disabled = $("generate").disabled = value;
  $("generate").textContent = value ? "Working…" : isVideo ? "Queue video" : "Generate image";
  updateSettings();
}
function selectedReferences() {
  if (!isVideo || $("mode").value === "t2va") return [];
  return references.filter((ref) => selectedIds.has(ref.id)).map((ref, i) => ({ picture: i + 1, image: ref.image, description: ref.name }));
}
function validate() {
  if (!$("prompt").value.trim()) { $("prompt").focus(); throw new Error("Describe what you want to create first."); }
  for (const id of ["width", "height", "steps", "seed", ...(isVideo ? ["duration"] : [])]) {
    if (!$(id).reportValidity()) throw new Error(`Check the ${id} setting.`);
  }
  const refs = selectedReferences();
  if (isVideo && $("mode").value === "i2va" && refs.length !== 1) throw new Error("Image to video needs exactly one selected reference.");
  if (isVideo && $("mode").value === "ref2va" && (refs.length < 1 || refs.length > 9)) throw new Error("Reference to video needs between 1 and 9 selected images.");
  return refs;
}
function renderReferences() {
  if (!isVideo) return;
  const mode = $("mode").value;
  $("referenceLibrary").classList.toggle("hidden", mode === "t2va");
  $("modeHint").textContent = { t2va: "Build a scene from words, with motion and sound.", i2va: "Animate one image. Select exactly one first-frame reference.", ref2va: "Keep characters and scenes consistent with 1–9 reference images." }[mode];
  let socket = 0;
  $("referenceList").innerHTML = references.length ? references.map((ref) => {
    const checked = selectedIds.has(ref.id);
    return `<div class="global-ref"><label><input type="checkbox" data-select-ref="${escapeHtml(ref.id)}" ${checked ? "checked" : ""}><span><b>${escapeHtml(ref.name)}</b><small>${escapeHtml(ref.image)}</small></span></label><span class="count-pill">${checked ? `Picture ${++socket}` : "Unused"}</span><button class="text-button" type="button" data-remove-ref="${escapeHtml(ref.id)}" aria-label="Remove ${escapeHtml(ref.name)}">Remove</button></div>`;
  }).join("") : '<p class="lab-hint">No references yet. Add an image from your repository below.</p>';
  $("referenceCount").textContent = `${socket} selected`;
}
async function loadReferences() {
  try {
    const library = (await request("/api/lab/references")).items || [];
    references = [...references, ...library.filter((ref) => !references.some((saved) => saved.id === ref.id))];
    renderReferences();
  }
  catch (error) { status(`Could not load references: ${error.message}`, "error"); }
}
if (isVideo) {
  $("mode").addEventListener("change", renderReferences);
  $("referenceList").addEventListener("change", (event) => {
    const id = event.target.dataset.selectRef;
    if (!id) return;
    if (event.target.checked) selectedIds.add(id); else selectedIds.delete(id);
    renderReferences(); saveDraft();
  });
  $("referenceList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-ref]");
    if (!button) return;
    button.disabled = true;
    try {
      references = (await request("/api/lab/references", { id: button.dataset.removeRef }, "DELETE")).items;
      selectedIds.delete(button.dataset.removeRef); renderReferences(); saveDraft();
    } catch (error) { button.disabled = false; status(error.message, "error"); }
  });
  $("addReference").addEventListener("click", async () => {
    const image = $("referenceImage").value.trim();
    if (!image) { status("Enter a repository image path.", "error"); $("referenceImage").focus(); return; }
    $("addReference").disabled = true;
    try {
      const { item } = await request("/api/lab/references", { name: $("referenceName").value.trim(), image });
      references.push(item); selectedIds.add(item.id);
      $("referenceName").value = $("referenceImage").value = "";
      renderReferences(); saveDraft(); status("Reference added.", "success");
    } catch (error) { status(error.message, "error"); }
    finally { $("addReference").disabled = false; }
  });
}

$("rewrite").addEventListener("click", async () => {
  try {
    const refs = validate();
    const original = $("prompt").value;
    setBusy(true); status("DeepSeek is drafting your prompt…");
    const data = await request("/api/lab/rewrite", { mode: kind, video_mode: isVideo ? $("mode").value : "", prompt: original.trim(), instruction: $("instruction").value, duration: isVideo ? Number($("duration").value) : 6, references: refs });
    $("output").value = data.content;
    if ($("prompt").value === original) { undoPrompt = original; $("prompt").value = data.content; }
    status(`Drafted with ${data.model}. Review or edit before generating.`, "success"); saveDraft();
  } catch (error) { status(error.message, "error"); }
  finally { setBusy(false); }
});
$("labForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  try {
    const refs = validate();
    const options = Object.fromEntries(["width", "height", "steps"].map((id) => [id, Number($(id).value)]));
    if ($("seed").value !== "") options.seed = Number($("seed").value);
    setBusy(true); status("Sending to ComfyUI…"); saveDraft();
    const body = isVideo ? { video_mode: $("mode").value, video_prompt: $("prompt").value.trim(), duration: Number($("duration").value), references: refs, options } : { prompt: $("prompt").value.trim(), ...options };
    const data = await request(`/api/lab/generate-${kind}`, body);
    history.push(data); renderHistory();
    status("Queued in ComfyUI. Follow this run in Tasks or Saved runs.", "success");
    toggleTasks(true);
    void refresh();
  } catch (error) { status(error.message, "error"); }
  finally { setBusy(false); }
});
$("undoPrompt").addEventListener("click", () => { if (undoPrompt === null) return; $("prompt").value = undoPrompt; undoPrompt = null; saveDraft(); updateSettings(); status("Previous prompt restored."); });
$("usePrompt").addEventListener("click", () => { undoPrompt = $("prompt").value; $("prompt").value = $("output").value; saveDraft(); updateSettings(); status("Draft applied to the prompt.", "success"); });
$("copyPrompt").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("output").value); status("Draft copied.", "success"); }
  catch { status("Copy unavailable. Select the draft text and copy it manually.", "error"); }
});
$("sizePreset").addEventListener("change", () => {
  if ($("sizePreset").value === "custom") return;
  [$("width").value, $("height").value] = $("sizePreset").value.split("x");
  updateSettings(); saveDraft();
});
for (const id of fieldIds) $(id).addEventListener("input", () => { updateSettings(); saveDraft(); });
$("output").addEventListener("input", () => { updateSettings(); saveDraft(); });
$("agentButton").addEventListener("click", () => { saveDraft(); location.href = "/?agent=settings"; });

function previewUrl(item) {
  const urls = item.preview_urls || [];
  if (item.kind !== "video") return urls[0];
  return urls.find((url) => /\.(mp4|webm|mov|mkv)(?:&|$)/i.test(decodeURIComponent(url))) || (item.outputs?.length ? null : urls[0]);
}
function renderHistory() {
  const items = history.filter((item) => item.kind === kind).slice().reverse();
  $("historyCount").textContent = items.length;
  const signature = JSON.stringify(items);
  if (signature !== historySignature) {
    historySignature = signature;
    $("history").innerHTML = items.length ? items.map((item) => {
      const url = previewUrl(item);
      const media = url ? (item.kind === "image" ? `<button class="lab-preview-button" type="button" data-preview="${escapeHtml(item.id)}" aria-label="Expand generated image"><img class="lab-preview" src="${escapeHtml(url)}" alt="Generated image" loading="lazy"></button>` : `<video class="lab-preview" src="${escapeHtml(url)}" controls playsinline preload="metadata"></video>`) : '<div class="lab-run-placeholder">' + (item.status === "error" ? "Generation failed" : item.status === "completed" ? "Preview unavailable" : "Your result will appear here") + '</div>';
      return `<article class="lab-history-item"><div class="lab-run-heading"><b>${item.kind === "image" ? "Image" : "Video"}</b><span class="lab-run-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></div>${media}<p class="lab-run-prompt">${escapeHtml(item.prompt)}</p><small>${escapeHtml(new Date(item.created_at).toLocaleString())} · ${item.width || "—"} × ${item.height || "—"}</small>${item.error ? `<p class="lab-status error">${escapeHtml(item.error)}</p>` : ""}<div class="lab-actions"><button type="button" class="text-button" data-reuse="${escapeHtml(item.id)}">Reuse settings</button>${url ? `<a class="text-button" href="${escapeHtml(url)}" download>Download</a>` : ""}</div></article>`;
    }).join("") : '<div class="lab-history-empty"><div class="inspector-icon">◇</div><h3>Your next idea starts here</h3><p>Generate an ' + (isVideo ? 'H3 clip' : 'image') + ' to see its preview and settings here.</p></div>';
  }
  renderTasks();
}
function renderTasks() {
  const active = history.filter((item) => ["queued", "running"].includes(item.status));
  $("taskQueueCount").textContent = active.length;
  $("taskQueueSummary").textContent = `${active.length} active · ${history.filter((item) => item.status === "completed").length} completed · All lab runs`;
  $("taskQueueList").innerHTML = history.length ? history.slice().reverse().map((item) => `<article class="lab-task"><div class="lab-run-heading"><b>${item.kind === "image" ? "Image" : "Video"}</b><span class="lab-run-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></div><p class="lab-run-prompt">${escapeHtml(item.prompt)}</p>${item.error ? `<p class="lab-status error">${escapeHtml(item.error)}</p>` : ""}<small>${escapeHtml(new Date(item.created_at).toLocaleString())}</small></article>`).join("") : '<p class="lab-hint">No generation tasks yet.</p>';
}
$("history").addEventListener("click", (event) => {
  const reuse = event.target.closest("[data-reuse]");
  const preview = event.target.closest("[data-preview]");
  const item = history.find((entry) => entry.id === (reuse?.dataset.reuse || preview?.dataset.preview));
  if (!item) return;
  if (reuse) {
    if (busy) return;
    undoPrompt = $("prompt").value;
    $("prompt").value = item.prompt || "";
    for (const id of ["width", "height", "steps", "seed"]) if (item[id] !== undefined) $(id).value = item[id]; else if (id === "seed") $(id).value = "";
    if (isVideo) {
      $("mode").value = item.video_mode || "t2va";
      $("duration").value = item.duration_seconds || 6;
      selectedIds = new Set();
      const restored = [];
      for (const ref of item.references || []) {
        let existing = references.find((candidate) => candidate.image === ref.image);
        if (!existing) { existing = { id: `run-${item.id}-${ref.picture}`, name: ref.description || `Picture ${ref.picture}`, image: ref.image }; references.push(existing); }
        selectedIds.add(existing.id);
        restored.push(existing);
      }
      references = [...restored, ...references.filter((ref) => !selectedIds.has(ref.id))];
      renderReferences();
    }
    updateSettings(); saveDraft(); $("prompt").focus(); status("Run settings restored. Review the prompt and references before generating.", "success");
  } else {
    previewFocus = event.target.closest("button");
    $("imageLightboxImage").src = previewUrl(item); $("imageLightboxImage").alt = item.prompt || "Generated image";
    $("imageLightboxCaption").textContent = `${item.width} × ${item.height}`;
    $("imageLightbox").classList.remove("hidden"); $("imageLightbox").querySelector("button").focus();
  }
});
function closePreview() { $("imageLightbox").classList.add("hidden"); $("imageLightboxImage").removeAttribute("src"); previewFocus?.focus(); }
document.querySelectorAll("[data-image-close]").forEach((element) => element.addEventListener("click", closePreview));
function toggleTasks(open) {
  $("taskQueuePanel").classList.toggle("hidden", !open); $("taskQueueButton").setAttribute("aria-expanded", String(open));
  if (open) $("closeTaskQueue").focus(); else $("taskQueueButton").focus();
}
$("taskQueueButton").addEventListener("click", () => toggleTasks($("taskQueuePanel").classList.contains("hidden")));
$("closeTaskQueue").addEventListener("click", () => toggleTasks(false));
document.addEventListener("keydown", (event) => {
  if (!$("imageLightbox").classList.contains("hidden")) {
    if (event.key === "Escape") closePreview();
    if (event.key === "Tab") { event.preventDefault(); $("imageLightbox").querySelector("button").focus(); }
    return;
  }
  if (event.key === "Escape" && !$("taskQueuePanel").classList.contains("hidden")) toggleTasks(false);
  if (event.key.toLowerCase() === "r" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest("input, textarea, select, [contenteditable]")) { event.preventDefault(); void refresh(true); }
});

async function refresh(manual = false) {
  if (refreshing) return;
  refreshing = true; $("refreshHistory").disabled = true;
  try {
    const [runs, comfy, agent] = await Promise.allSettled([
      request("/api/lab/history/sync", {}), request("/api/comfy/status"), request("/api/agent/config"),
    ]);
    if (runs.status === "fulfilled") { history = runs.value.items || []; renderHistory(); if (manual) status("Runs refreshed.", "success"); }
    else {
      try { history = (await request("/api/lab/history")).items || []; renderHistory(); } catch { /* Preserve the last known runs. */ }
      status(`Could not refresh runs: ${runs.reason.message}`, "error");
    }
    const backend = comfy.status === "fulfilled" ? comfy.value : {};
    const compatible = backend.capabilities?.[isVideo ? "h3" : "z_image_turbo"]?.compatible ?? backend.compatible;
    $("comfyStatus").className = `comfy-status ${!backend.connected || !compatible ? "error" : backend.running || backend.pending ? "busy" : "ready"}`;
    $("comfyStatus").querySelector("small").textContent = !backend.connected ? "Offline" : !compatible ? "Setup required" : backend.running || backend.pending ? `${backend.running || 0} running` : "Ready";
    $("comfyStatus").title = backend.error || backend.url || "ComfyUI unavailable";
    const configured = agent.status === "fulfilled" && agent.value.configured;
    $("agentButton").className = `agent-status ${configured ? "ready" : "setup"}`;
    $("agentButton").querySelector("small").textContent = configured ? agent.value.model : agent.status === "rejected" ? "Unavailable" : "Setup";
  } finally { refreshing = false; $("refreshHistory").disabled = false; }
}
$("refreshHistory").addEventListener("click", () => void refresh(true));
restoreDraft(); updateSettings(); renderReferences(); renderHistory();
if (isVideo) void loadReferences();
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
