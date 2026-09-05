const state = {
  catalog: null,
  storyId: null,
  episodeId: null,
  selection: null,
  inspectorTab: "overview",
  query: "",
  comfy: null,
  agent: null,
  generationJobs: [],
  taskQueueOpen: false,
  collapsedStories: new Set(),
  collapsedEpisodes: new Set(),
  episodePlaylist: null,
  editorSubmit: null,
  agentDraftBackups: new Map(),
  lastEpisodes: {},
  viewPositions: {},
  navigationInitialized: false,
};

const dom = {
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  scanStatus: document.querySelector("#scanStatus"),
  comfyStatus: document.querySelector("#comfyStatus"),
  taskQueueButton: document.querySelector("#taskQueueButton"),
  taskQueueCount: document.querySelector("#taskQueueCount"),
  taskQueuePanel: document.querySelector("#taskQueuePanel"),
  taskQueueSummary: document.querySelector("#taskQueueSummary"),
  taskQueueList: document.querySelector("#taskQueueList"),
  closeTaskQueue: document.querySelector("#closeTaskQueue"),
  agentButton: document.querySelector("#agentButton"),
  newStoryButton: document.querySelector("#newStoryButton"),
  storyCount: document.querySelector("#storyCount"),
  storyTree: document.querySelector("#storyTree"),
  emptyState: document.querySelector("#emptyState"),
  storyView: document.querySelector("#storyView"),
  storyTitle: document.querySelector("#storyTitle"),
  storySummary: document.querySelector("#storySummary"),
  storyPath: document.querySelector("#storyPath"),
  storyStats: document.querySelector("#storyStats"),
  editStoryButton: document.querySelector("#editStoryButton"),
  referenceSummary: document.querySelector("#referenceSummary"),
  storyReferences: document.querySelector("#storyReferences"),
  newReferenceButton: document.querySelector("#newReferenceButton"),
  episodeTitle: document.querySelector("#episodeTitle"),
  episodeTabs: document.querySelector("#episodeTabs"),
  episodeSummary: document.querySelector("#episodeSummary"),
  episodePreview: document.querySelector("#episodePreview"),
  episodeReferenceLibrary: document.querySelector("#episodeReferenceLibrary"),
  episodeReferenceSummary: document.querySelector("#episodeReferenceSummary"),
  episodeReferences: document.querySelector("#episodeReferences"),
  graphMeta: document.querySelector("#graphMeta"),
  clipViewport: document.querySelector("#clipViewport"),
  clipFlow: document.querySelector("#clipFlow"),
  fitGraphButton: document.querySelector("#fitGraphButton"),
  editEpisodeButton: document.querySelector("#editEpisodeButton"),
  newEpisodeButton: document.querySelector("#newEpisodeButton"),
  newClipButton: document.querySelector("#newClipButton"),
  aiClipsButton: document.querySelector("#aiClipsButton"),
  rewritePromptsButton: document.querySelector("#rewritePromptsButton"),
  regenerateChainButton: document.querySelector("#regenerateChainButton"),
  queueEpisodeButton: document.querySelector("#queueEpisodeButton"),
  batchReferenceButton: document.querySelector("#batchReferenceButton"),
  inspector: document.querySelector("#inspector"),
  inspectorEmpty: document.querySelector("#inspectorEmpty"),
  inspectorContent: document.querySelector("#inspectorContent"),
  inspectorEyebrow: document.querySelector("#inspectorEyebrow"),
  inspectorTitle: document.querySelector("#inspectorTitle"),
  inspectorBadges: document.querySelector("#inspectorBadges"),
  inspectorTabs: document.querySelector("#inspectorTabs"),
  inspectorBody: document.querySelector("#inspectorBody"),
  closeInspector: document.querySelector("#closeInspector"),
  toast: document.querySelector("#toast"),
  imageLightbox: document.querySelector("#imageLightbox"),
  imageLightboxImage: document.querySelector("#imageLightboxImage"),
  imageLightboxCaption: document.querySelector("#imageLightboxCaption"),
  editorModal: document.querySelector("#editorModal"),
  editorForm: document.querySelector("#editorForm"),
  editorModalTitle: document.querySelector("#editorModalTitle"),
  editorBody: document.querySelector("#editorBody"),
  editorSubmitButton: document.querySelector("#editorSubmitButton"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const navigationStorageKey = "aiturboshow.studio.navigation.v1";
let navigationReady = false;
let renderedLocation = null;
let savedTreeScroll = 0;
const locationKey = () => `${state.storyId}:${state.episodeId}`;
const scrollValue = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

function restoreNavigation() {
  try {
    const saved = JSON.parse(localStorage.getItem(navigationStorageKey) || "null");
    if (!saved || typeof saved !== "object") return;
    state.storyId = typeof saved.storyId === "string" ? saved.storyId : null;
    state.episodeId = typeof saved.episodeId === "string" ? saved.episodeId : null;
    state.selection = saved.selection && ["clip", "reference"].includes(saved.selection.type) ? saved.selection : null;
    state.inspectorTab = ["overview", "prompt", "images", "references", "files"].includes(saved.inspectorTab) ? saved.inspectorTab : "overview";
    state.collapsedStories = new Set(Array.isArray(saved.collapsedStories) ? saved.collapsedStories.filter((id) => typeof id === "string") : []);
    state.collapsedEpisodes = new Set(Array.isArray(saved.collapsedEpisodes) ? saved.collapsedEpisodes.filter((id) => typeof id === "string") : []);
    state.lastEpisodes = saved.lastEpisodes && typeof saved.lastEpisodes === "object" && !Array.isArray(saved.lastEpisodes) ? saved.lastEpisodes : {};
    state.viewPositions = saved.viewPositions && typeof saved.viewPositions === "object" && !Array.isArray(saved.viewPositions) ? saved.viewPositions : {};
    savedTreeScroll = scrollValue(saved.treeScroll);
    state.navigationInitialized = true;
  } catch { /* Invalid or unavailable browser storage must not prevent startup. */ }
}

function saveNavigation() {
  if (!navigationReady || !state.catalog) return;
  try {
    localStorage.setItem(navigationStorageKey, JSON.stringify({
      storyId: state.storyId, episodeId: state.episodeId, selection: state.selection, inspectorTab: state.inspectorTab,
      collapsedStories: [...state.collapsedStories], collapsedEpisodes: [...state.collapsedEpisodes],
      lastEpisodes: state.lastEpisodes, viewPositions: state.viewPositions, treeScroll: dom.storyTree.scrollTop,
    }));
  } catch { /* Navigation still works when browser storage is disabled. */ }
}

function capturePosition() {
  if (!navigationReady || renderedLocation !== locationKey()) return;
  state.viewPositions[locationKey()] = {
    workspace: document.querySelector(".workspace").scrollTop,
    graph: dom.clipViewport.scrollLeft, inspector: dom.inspectorBody.scrollTop,
  };
}

function revealCurrentLocation() {
  state.collapsedStories.delete(state.storyId);
  state.collapsedEpisodes.delete(`${state.storyId}:${state.episodeId}`);
}

function openProduction(storyId, episodeId = null) {
  capturePosition();
  state.storyId = storyId;
  const story = currentStory();
  const requested = episodeId || state.lastEpisodes[storyId];
  state.episodeId = story?.episodes?.find((episode) => episode.id === requested)?.id || story?.episodes?.[0]?.id || null;
  state.selection = null;
  state.inspectorTab = "overview";
  revealCurrentLocation();
  renderAll();
}

function formatDuration(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const number = Number(value);
  return Number.isInteger(number) ? `${number}s` : `${number.toFixed(1)}s`;
}

function formatTotalDuration(seconds) {
  const rounded = Math.round(Number(seconds || 0));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
}

function typeLabel(type) {
  const labels = {
    ref2va: "H3 Ref2VA",
    i2va: "H3 I2VA",
    fl2va: "H3 FL2VA",
    h3: "H3 video",
    post: "Post-production",
  };
  return labels[type] || type || "Clip";
}

function clipQueueReadiness(clip) {
  const missing = (clip.references || []).filter((reference) => !reference.ready);
  const dependencies = missing.filter((reference) => reference.dependency?.clip_id);
  const fixed = missing.filter((reference) => !reference.dependency?.clip_id);
  return {
    missing,
    dependencies,
    fixed,
    dependencyOnly: dependencies.length > 0 && fixed.length === 0,
    queueable: missing.length === 0 || fixed.length === 0,
    dependencyClipIds: [...new Set(dependencies.map((reference) => reference.dependency.clip_id))],
  };
}

function fullClipDependencyChain(episode, clipId, collected = new Map(), visiting = new Set()) {
  if (!episode || visiting.has(clipId)) return collected;
  const clip = (episode.clips || []).find((candidate) => candidate.id === clipId);
  if (!clip || collected.has(clipId)) return collected;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(clipId);
  for (const reference of clip.references || []) {
    if (reference.dependency?.clip_id) fullClipDependencyChain(episode, reference.dependency.clip_id, collected, nextVisiting);
  }
  collected.set(clip.id, clip);
  return collected;
}

function clipStatus(clip) {
  if (clip.type === "post") return "post";
  if (clipQueueReadiness(clip).dependencyOnly) return "dependency";
  return clip.issues?.length ? "partial" : "ready";
}

function currentStory() {
  return state.catalog?.stories?.find((story) => story.id === state.storyId) || null;
}

function currentEpisode() {
  const story = currentStory();
  return story?.episodes?.find((episode) => episode.id === state.episodeId) || story?.episodes?.[0] || null;
}

function findReferenceById(referenceId) {
  const story = currentStory();
  const episode = currentEpisode();
  return [...(story?.references || []), ...(episode?.references || [])].find((reference) => reference.id === referenceId) || null;
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => dom.toast.classList.remove("visible"), 2200);
}

function openImagePreview(image, alt = "Reference image") {
  if (!image?.url || !dom.imageLightbox) return;
  dom.imageLightboxImage.src = image.url;
  dom.imageLightboxImage.alt = alt;
  dom.imageLightboxCaption.textContent = image.path || image.name || alt;
  dom.imageLightbox.classList.remove("hidden");
}

function closeImagePreview() {
  if (!dom.imageLightbox) return;
  dom.imageLightbox.classList.add("hidden");
  dom.imageLightboxImage.removeAttribute("src");
}

const activeGenerationStatuses = new Set(["waiting", "preparing", "queued", "running", "finalizing"]);

const h3ResolutionPresets = [
  ["608x352", "0.2 MP · 608×352"],
  ["736x416", "0.3 MP · 736×416"],
  ["864x480", "0.4 MP · 864×480"],
  ["960x544", "0.5 MP · 960×544"],
  ["1056x608", "0.6 MP · 1056×608"],
  ["1344x768", "0.98 MP · 1344×768"],
];

function h3ResolutionOptions(selected = "864x480") {
  return h3ResolutionPresets.map(([value, label]) => (
    `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
  )).join("");
}

function generationStatusLabel(status) {
  return ({
    waiting: "Waiting in AITurboShow",
    preparing: "Preparing inputs",
    queued: "Queued in ComfyUI",
    running: "Generating",
    finalizing: "Saving outputs",
    completed: "Completed",
    skipped: "Skipped",
    cancelled: "Cancelled",
    error: "Error",
  })[status] || status || "Unknown";
}

function renderTaskQueue() {
  if (!dom.taskQueuePanel) return;
  const jobs = state.generationJobs || [];
  const activeJobs = jobs.filter((job) => activeGenerationStatuses.has(job.status));
  const completed = jobs.filter((job) => job.status === "completed").length;
  const errors = jobs.filter((job) => job.status === "error").length;
  dom.taskQueuePanel.classList.toggle("hidden", !state.taskQueueOpen);
  dom.taskQueueCount.textContent = activeJobs.length;
  dom.taskQueueButton.classList.toggle("active", state.taskQueueOpen);
  dom.taskQueueButton.classList.toggle("busy", activeJobs.length > 0);
  const overallProgress = jobs.length
    ? Math.round(jobs.reduce((sum, job) => sum + Number(job.progress_percent || 0), 0) / jobs.length)
    : 0;
  dom.taskQueueSummary.innerHTML = `
    <div class="task-summary-grid">
      <div><b>${activeJobs.length}</b><span>Active</span></div>
      <div><b>${jobs.filter((job) => job.status === "waiting").length}</b><span>Waiting</span></div>
      <div><b>${completed}</b><span>Completed</span></div>
      <div><b>${errors}</b><span>Errors</span></div>
    </div>
    <div class="task-overall-progress"><span style="width:${overallProgress}%"></span></div>`;
  if (!jobs.length) {
    dom.taskQueueList.innerHTML = '<div class="no-content">No generation tasks in this server session.</div>';
    return;
  }
  dom.taskQueueList.innerHTML = jobs.slice(0, 50).map((job) => {
    const title = job.kind === "image"
      ? job.reference_id || "Reference image"
      : job.clip_title || job.clip_id || "H3 clip";
    const identity = job.kind === "image" ? "Z-Image Turbo" : `${job.clip_id || "H3"}${job.sequence ? ` · sequence ${job.sequence}` : ""}`;
    const detail = job.error
      || (job.status === "waiting" && job.queue_position ? `Queue position ${job.queue_position}` : "")
      || (job.batch_total ? `Batch ${job.batch_index}/${job.batch_total}` : "")
      || (job.prompt_id ? `Prompt ${job.prompt_id}` : "Awaiting submission");
    const progress = Math.max(0, Math.min(100, Number(job.progress_percent || 0)));
    return `
      <article class="task-item ${escapeHtml(job.status)}">
        <div class="task-item-top">
          <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(identity)}</span></div>
          <b>${escapeHtml(generationStatusLabel(job.status))}</b>
        </div>
        <div class="task-progress ${job.progress_indeterminate ? "indeterminate" : ""}"><span style="width:${progress}%"></span></div>
        <div class="task-item-footer">
          <div class="task-item-detail">${escapeHtml(detail)}</div>
          ${job.cancellable ? `<button class="task-cancel-button" type="button" data-cancel-job="${escapeHtml(job.id)}">Cancel</button>` : ""}
        </div>
      </article>`;
  }).join("");
}

function generationJobFor(clip) {
  return state.generationJobs.find((job) => (
    job.story_id === state.storyId
    && job.episode_id === state.episodeId
    && job.clip_id === clip.id
  )) || null;
}

function referenceGenerationJobFor(reference) {
  return state.generationJobs.find((job) => (
    job.kind === "image"
    && job.story_id === state.storyId
    && job.reference_id === reference.id
  )) || null;
}

function setComfyStatus(status) {
  state.comfy = status;
  if (!dom.comfyStatus) return;
  const waiting = Number(status?.local_waiting || 0);
  const busy = Number(status?.running || 0) + Number(status?.pending || 0) + waiting;
  const className = !status?.connected || !status?.compatible ? "error" : busy ? "busy" : "ready";
  const label = !status?.connected
    ? "Offline"
    : !status?.compatible
      ? "Setup required"
      : busy
        ? `${status.running || 0} running · ${Number(status.pending || 0) + waiting} queued`
        : "Ready";
  dom.comfyStatus.className = `comfy-status ${className}`;
  dom.comfyStatus.title = status?.error || status?.url || "ComfyUI backend status";
  dom.comfyStatus.innerHTML = `<span></span><div><b>ComfyUI</b><small>${escapeHtml(label)}</small></div>`;
}

function setAgentStatus(config) {
  state.agent = config;
  if (!dom.agentButton) return;
  const configured = Boolean(config?.configured);
  dom.agentButton.className = `agent-status ${configured ? "ready" : "setup"}`;
  dom.agentButton.title = configured
    ? `DeepSeek ${config.model} · ${config.api_key_source}`
    : "Configure the DeepSeek production-writing agent";
  dom.agentButton.querySelector("small").textContent = configured ? config.model : "Setup";
}

async function refreshAgentConfig() {
  try {
    const response = await fetch(`/api/agent/config?_=${Date.now()}`, { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Agent configuration request failed with ${response.status}`);
    setAgentStatus(result);
    return result;
  } catch (error) {
    console.error(error);
    setAgentStatus({ configured: false, model: "Unavailable" });
    return null;
  }
}

function refreshInspectorLivePanel() {
  const selection = selectionData();
  const currentPanel = dom.inspectorBody.querySelector("[data-live-panel]");
  if (!selection || !currentPanel) return;
  const html = selection.type === "clip"
    ? renderGenerationPanel(selection.item)
    : renderReferenceGenerationPanel(selection.item);
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const replacement = template.content.firstElementChild;
  if (replacement) currentPanel.replaceWith(replacement);
}

async function refreshComfyState({ render = true } = {}) {
  const previous = new Map(state.generationJobs.map((job) => [job.id, job.status]));
  const previousJobs = JSON.stringify(state.generationJobs);
  const previousComfy = JSON.stringify(state.comfy);
  try {
    const [statusResponse, jobsResponse] = await Promise.all([
      fetch(`/api/comfy/status?_=${Date.now()}`, { cache: "no-store" }),
      fetch(`/api/comfy/jobs?_=${Date.now()}`, { cache: "no-store" }),
    ]);
    if (!statusResponse.ok) throw new Error(`ComfyUI status request failed with ${statusResponse.status}`);
    if (!jobsResponse.ok) throw new Error(`ComfyUI jobs request failed with ${jobsResponse.status}`);
    const statusPayload = await statusResponse.json();
    const jobsPayload = await jobsResponse.json();
    state.generationJobs = jobsPayload.jobs || [];
    setComfyStatus({ ...statusPayload, local_waiting: state.generationJobs.filter((job) => job.status === "waiting").length });
    renderTaskQueue();
    const generationChanged = previousJobs !== JSON.stringify(state.generationJobs);
    const comfyChanged = previousComfy !== JSON.stringify(state.comfy);
    const newlyCompleted = state.generationJobs.some((job) => job.status === "completed" && previous.get(job.id) !== "completed");
    if (newlyCompleted) await loadCatalog();
    else if (render) {
      if (currentEpisode()) renderClipFlow(currentEpisode().clips || []);
      if (state.selection && (generationChanged || comfyChanged)) refreshInspectorLivePanel();
    }
  } catch (error) {
    setComfyStatus({ connected: false, compatible: false, error: error.message });
    renderTaskQueue();
    if (render && state.selection) refreshInspectorLivePanel();
  }
}

async function postJson(path, payload) {
  return requestJson(path, payload, "POST");
}

async function requestJson(path, payload, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function closeEditor() {
  dom.editorModal.classList.add("hidden");
  dom.editorBody.innerHTML = "";
  state.editorSubmit = null;
  state.agentDraftBackups.clear();
}

function openEditor({ title, submitLabel = "Save", body, onSubmit }) {
  dom.editorModalTitle.textContent = title;
  dom.editorSubmitButton.textContent = submitLabel;
  dom.editorBody.innerHTML = body;
  state.editorSubmit = onSubmit;
  state.agentDraftBackups.clear();
  dom.editorModal.classList.remove("hidden");
  setTimeout(() => dom.editorBody.querySelector("input, textarea, select")?.focus(), 0);
}

function editorValue(name) {
  return dom.editorForm.elements.namedItem(name)?.value ?? "";
}

function parseEditorJson(name, label) {
  try {
    return JSON.parse(editorValue(name));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function agentAssist(actions, description) {
  const buttons = actions.map(({ action, target, label }) => `
    <button class="generation-button agent-draft-button" type="button" data-agent-action="${escapeHtml(action)}" data-agent-target="${escapeHtml(target)}">${escapeHtml(label)}</button>`).join("");
  return `
    <section class="agent-assist">
      <div class="agent-assist-header">
        <div>
          <div class="eyebrow">DeepSeek production agent</div>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="agent-assist-actions">${buttons}</div>
      </div>
      <label class="editor-field">
        <span>Extra direction for this draft (optional)</span>
        <textarea class="agent-instruction" name="agent_instruction" placeholder="Language, tone, plot changes, visual style, dialogue, constraints…"></textarea>
      </label>
      <div class="agent-feedback hidden" data-agent-feedback role="status" aria-live="polite"></div>
    </section>`;
}

function setAgentFeedback(element, message, type = "pending") {
  if (!element) return;
  element.textContent = message;
  element.className = `agent-feedback ${type}`;
}

function setAgentDraftFeedback(element, message, targetName) {
  setAgentFeedback(element, message, "success");
  if (!element || !state.agentDraftBackups.has(targetName)) return;
  const actions = document.createElement("div");
  actions.className = "agent-feedback-actions";
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "generation-button agent-undo-button";
  undo.dataset.agentUndo = targetName;
  undo.textContent = "Undo draft";
  actions.append(undo);
  element.append(actions);
}

function collectAgentEditorFields() {
  const allowed = [
    "title", "summary", "outline_text", "duration_seconds", "generation_mode", "video_prompt",
    "first_frame_image_prompt", "post_production_instructions", "references", "outputs", "kind", "scope", "slug", "prompt_text",
  ];
  const fields = {};
  for (const name of allowed) {
    const element = dom.editorForm.elements.namedItem(name);
    if (!element) continue;
    fields[name] = element.type === "number" ? Number(element.value) : element.value;
  }
  return fields;
}

async function saveAgentSettingsFromEditor() {
  const apiKey = editorValue("api_key").trim();
  const payload = {
    base_url: editorValue("base_url"),
    model: editorValue("model"),
  };
  if (apiKey) payload.api_key = apiKey;
  const result = await requestJson("/api/agent/config", payload, "PUT");
  setAgentStatus(result);
  return result;
}

function openAgentSettings() {
  const config = state.agent || {};
  openEditor({
    title: "DeepSeek agent settings",
    submitLabel: "Save configuration",
    body: `
      <p class="editor-help">The API key is stored only in <code>${escapeHtml(config.config_path || "AITurboShow/config.local.json")}</code>. It is never returned to the browser after saving. You can also use the DEEPSEEK_API_KEY environment variable.</p>
      <div class="editor-grid single" data-agent-settings-form>
        <label class="editor-field"><span>DeepSeek API key</span><input name="api_key" type="password" autocomplete="new-password" placeholder="${escapeHtml(config.masked_api_key ? `Configured: ${config.masked_api_key}` : "Enter API key")}"></label>
        <label class="editor-field"><span>API base URL</span><input name="base_url" type="url" required value="${escapeHtml(config.base_url || "https://api.deepseek.com")}"></label>
        <label class="editor-field"><span>Model</span><input name="model" required value="${escapeHtml(config.model || "deepseek-chat")}" placeholder="deepseek-chat"></label>
        <div class="agent-settings-actions">
          <span>${config.configured ? `Configured from ${escapeHtml(config.api_key_source || "local settings")}` : "API key not configured yet"}</span>
          <button class="generation-button" type="button" data-agent-test>Save &amp; test connection</button>
        </div>
        <div class="agent-feedback hidden" data-agent-settings-feedback role="status" aria-live="polite"></div>
      </div>`,
    onSubmit: async () => {
      await saveAgentSettingsFromEditor();
      showToast("DeepSeek configuration saved.");
    },
  });
}

async function generateAgentDraft(button) {
  const feedback = button.closest(".agent-assist")?.querySelector("[data-agent-feedback]");
  if (!state.agent?.configured) {
    const message = "DeepSeek is not configured. Close this editor, open DeepSeek settings, and enter the API key.";
    setAgentFeedback(feedback, message, "error");
    showToast(message);
    return;
  }
  const target = dom.editorForm.elements.namedItem(button.dataset.agentTarget);
  if (!target) throw new Error("The requested editor field is unavailable.");
  const story = currentStory();
  const episode = currentEpisode();
  const fields = collectAgentEditorFields();
  const action = button.dataset.agentAction;
  const creatingStory = action === "story_summary" && !fields.outline_text;
  const creatingEpisode = action === "episode_summary" && !fields.outline_text;
  const creatingClip = Boolean(dom.editorBody.querySelector("[data-new-clip-editor]"));
  const storyId = creatingStory ? null : story?.id || null;
  const episodeId = ["story_summary", "story_outline"].includes(action) || creatingEpisode
    || (action === "reference_image_prompt" && fields.scope === "story")
    ? null
    : episode?.id || null;
  const clipId = ["clip_prompt", "first_frame_prompt", "post_production_instructions"].includes(action)
    && !creatingClip
    && state.selection?.type === "clip"
    ? state.selection.clipId
    : null;
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Generating…";
  setAgentFeedback(feedback, "Sending the current production context to DeepSeek…", "pending");
  try {
    const result = await requestJson("/api/agent/generate", {
      action,
      story_id: storyId,
      episode_id: episodeId,
      clip_id: clipId,
      instruction: editorValue("agent_instruction"),
      fields,
    });
    const targetName = button.dataset.agentTarget;
    if (!state.agentDraftBackups.has(targetName)) state.agentDraftBackups.set(targetName, target.value);
    target.value = result.content;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    const tokens = result.usage?.total_tokens ? ` · ${result.usage.total_tokens} tokens` : "";
    setAgentDraftFeedback(feedback, `DeepSeek replaced ${target.labels?.[0]?.innerText || "the editor field"}${tokens}. This is only an unsaved editor draft; press Save to keep it, Undo draft to restore the original, or close the editor to discard it.`, targetName);
    showToast(`DeepSeek replaced the editor draft${tokens}. It has not been saved.`);
  } catch (error) {
    setAgentFeedback(feedback, error.message || String(error), "error");
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

function suggestedSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function upsertMarkdownSummary(outline, summary) {
  const text = String(outline || "").trimEnd();
  const cleanSummary = String(summary || "").trim();
  if (!cleanSummary) return `${text}\n`;
  const section = `## Summary\n\n${cleanSummary}`;
  const existingSection = /(^|\n)## Summary\s*\n[\s\S]*?(?=\n##\s|$)/i;
  if (existingSection.test(text)) {
    return `${text.replace(existingSection, (match, prefix) => `${prefix}${section}`)}\n`;
  }
  const headingEnd = text.indexOf("\n");
  if (headingEnd >= 0 && text.startsWith("# ")) {
    return `${text.slice(0, headingEnd)}\n\n${section}\n${text.slice(headingEnd).trimStart() ? `\n${text.slice(headingEnd).trimStart()}` : ""}\n`;
  }
  return `${section}\n\n${text}\n`;
}

function openNewStoryEditor() {
  openEditor({
    title: "Create story",
    submitLabel: "Create story",
    body: `
      <div class="editor-grid">
        <label class="editor-field"><span>Story title</span><input name="title" required placeholder="My new story"></label>
        <label class="editor-field"><span>Folder slug</span><input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="my-new-story"></label>
        <label class="editor-field full"><span>Summary</span><textarea name="summary" placeholder="What is this story about?"></textarea></label>
      </div>
      ${agentAssist([{ action: "story_summary", target: "summary", label: "Draft story summary" }], "Use the title and your direction to create a strong premise, world, conflict, and trajectory.")}`,
    onSubmit: async () => {
      const result = await requestJson("/api/content/story", {
        title: editorValue("title"),
        slug: editorValue("slug"),
        summary: editorValue("summary"),
      });
      state.storyId = result.story_id;
      state.episodeId = null;
      state.selection = null;
      await loadCatalog();
      showToast(`Story ${result.story_id} created.`);
    },
  });
  const titleInput = dom.editorForm.elements.namedItem("title");
  const slugInput = dom.editorForm.elements.namedItem("slug");
  titleInput.addEventListener("input", () => {
    if (!slugInput.dataset.edited) slugInput.value = suggestedSlug(titleInput.value);
  });
  slugInput.addEventListener("input", () => { slugInput.dataset.edited = "1"; });
}

function openEditStoryEditor() {
  const story = currentStory();
  if (!story) return;
  openEditor({
    title: `Edit ${story.title}`,
    body: `
      <p class="editor-help">The first Markdown heading controls the displayed story title. You can edit the complete story outline here.</p>
      <div class="editor-grid single">
        <label class="editor-field"><span>Story summary</span><textarea name="summary">${escapeHtml(story.summary || "")}</textarea></label>
        <label class="editor-field"><span>Story outline</span><textarea class="tall" name="outline_text" required>${escapeHtml(story.outline_text || `# ${story.title}\n`)}</textarea></label>
      </div>
      ${agentAssist([
        { action: "story_summary", target: "summary", label: "Draft story summary" },
        { action: "story_outline", target: "outline_text", label: "Draft story outline" },
      ], "DeepSeek uses the current outline, story summary, references, and your extra direction.")}`,
    onSubmit: async () => {
      await requestJson("/api/content/story", {
        story_id: story.id,
        outline_text: upsertMarkdownSummary(editorValue("outline_text"), editorValue("summary")),
      }, "PUT");
      await loadCatalog();
      showToast("Story outline saved.");
    },
  });
}

function openNewEpisodeEditor() {
  const story = currentStory();
  if (!story) return;
  openEditor({
    title: `Add episode to ${story.title}`,
    submitLabel: "Create episode",
    body: `
      <div class="editor-grid single">
        <label class="editor-field"><span>Episode title</span><input name="title" required placeholder="Episode title"></label>
        <label class="editor-field"><span>Summary</span><textarea name="summary" placeholder="Episode premise and key beats"></textarea></label>
      </div>
      ${agentAssist([{ action: "episode_summary", target: "summary", label: "Draft episode summary" }], "The agent uses the selected story outline and references to keep this episode consistent.")}`,
    onSubmit: async () => {
      const result = await requestJson("/api/content/episode", {
        story_id: story.id,
        title: editorValue("title"),
        summary: editorValue("summary"),
      });
      state.episodeId = result.episode_id;
      state.selection = null;
      await loadCatalog();
      showToast(`${result.episode_id} created.`);
    },
  });
}

function openEditEpisodeEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story || !episode) return;
  openEditor({
    title: `Edit ${episode.title}`,
    body: `
      <p class="editor-help">The first Markdown heading controls the episode title. A production-ready outline should include a <strong>Clip allocation</strong> section: one ordered entry per clip with duration, what happens, visual/camera beat, audio/dialogue, purpose, and continuity. Clip order is managed separately and uses the structured sequence values.</p>
      <div class="editor-grid single">
        <label class="editor-field"><span>Episode summary</span><textarea name="summary">${escapeHtml(episode.summary || "")}</textarea></label>
        <label class="editor-field"><span>Episode outline</span><textarea class="tall" name="outline_text" required>${escapeHtml(episode.outline_text || `# ${episode.title}\n`)}</textarea></label>
      </div>
      ${agentAssist([
        { action: "episode_summary", target: "summary", label: "Draft episode summary" },
        { action: "episode_outline", target: "outline_text", label: "Draft episode outline" },
      ], "The agent keeps existing clip IDs and known continuity, then writes a complete ordered clip allocation—not just a prose episode treatment.")}`,
    onSubmit: async () => {
      await requestJson("/api/content/episode", {
        story_id: story.id,
        episode_id: episode.id,
        outline_text: upsertMarkdownSummary(editorValue("outline_text"), editorValue("summary")),
      }, "PUT");
      await loadCatalog();
      showToast("Episode outline saved.");
    },
  });
}

function openNewClipEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story || !episode) return;
  const clips = [...(episode.clips || [])].sort((left, right) => left.sequence - right.sequence);
  const anchors = clips.map((clip) => `<option value="${escapeHtml(clip.id)}">${escapeHtml(`${clip.id} · ${clip.title}`)}</option>`).join("");
  const availableReferences = [...(story.references || []), ...(episode.references || [])];
  const referenceChoices = availableReferences.map((reference) => {
    const image = reference.images?.[0];
    const preview = image
      ? `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(reference.name)}" data-image-preview data-image-url="${escapeHtml(image.url)}" data-image-name="${escapeHtml(reference.name)}">`
      : `<div class="manual-reference-placeholder">${escapeHtml((reference.kind || "R").slice(0, 1).toUpperCase())}</div>`;
    return `
      <label class="manual-reference-choice" data-manual-reference-card>
        <input type="checkbox" name="manual_reference_id" value="${escapeHtml(reference.id)}">
        <span class="manual-reference-preview">${preview}</span>
        <span class="manual-reference-copy">
          <strong>${escapeHtml(reference.name)}</strong>
          <small>${escapeHtml(reference.scope)} · ${escapeHtml(reference.kind)} · ${reference.ready ? "Image ready" : "Prompt only"}</small>
        </span>
        <span class="manual-reference-slot" data-reference-slot></span>
      </label>`;
  }).join("");
  openEditor({
    title: `Add clip to ${episode.title}`,
    submitLabel: "Create clip",
    body: `
      <div data-new-clip-editor>
        <p class="editor-help">New clips receive a stable, unused clip ID. Select the actual image inputs here; AITurboShow assigns their ordered &lt;Picture N&gt; sockets and sends the same sockets to DeepSeek. Strict validation remains enabled so a prompt cannot silently reference the wrong image.</p>
        <div class="editor-grid">
          <label class="editor-field"><span>Title</span><input name="title" required placeholder="New clip"></label>
          <label class="editor-field"><span>Duration</span><input name="duration_seconds" type="number" min="0.1" max="15" step="0.1" value="10" required></label>
          <label class="editor-field"><span>Generation mode</span><select name="generation_mode"><option value="ref2va">Ref2VA</option><option value="i2va">I2VA</option><option value="post">Post-production</option></select></label>
          <label class="editor-field"><span>Position</span><select name="position"><option value="end">End of episode</option><option value="start">Start of episode</option><option value="before">Before selected clip</option><option value="after">After selected clip</option></select></label>
          <label class="editor-field full"><span>Anchor clip</span><select name="anchor_clip_id">${anchors || '<option value="">No existing clips</option>'}</select></label>
          <label class="editor-check full"><input type="checkbox" name="use_previous_frame"> <span data-previous-frame-label>Use the preceding clip's last frame as the first-frame continuity input</span><b class="manual-reference-slot" data-previous-frame-slot></b></label>
          <div class="editor-field full">
            <span>Reference images</span>
            <div class="manual-reference-picker">${referenceChoices || '<div class="no-content">No story or episode references exist yet. Create a reference first, then return here.</div>'}</div>
          </div>
          <label class="editor-field full"><span>Initial video prompt (optional)</span><textarea name="video_prompt" placeholder="Use DeepSeek to draft a matching prompt, write one manually, or leave blank for a socket-matched placeholder."></textarea></label>
          <div class="manual-reference-status full" data-manual-reference-status role="status" aria-live="polite"></div>
          <textarea name="references" class="hidden" aria-hidden="true"></textarea>
          <label class="editor-field full"><span>Post-production instructions (post mode)</span><textarea name="post_production_instructions" placeholder="Describe the edit, timing, transitions, audio, and outputs."></textarea></label>
        </div>
        ${agentAssist([
          { action: "clip_prompt", target: "video_prompt", label: "Draft H3 clip prompt" },
          { action: "post_production_instructions", target: "post_production_instructions", label: "Draft post notes" },
        ], "Set the title, duration, mode, insertion position, previous-frame option, and reference images first. The agent receives these exact unsaved Picture sockets.")}
      </div>`,
    onSubmit: async () => {
      const result = await requestJson("/api/content/clip", {
        story_id: story.id,
        episode_id: episode.id,
        title: editorValue("title"),
        duration_seconds: Number(editorValue("duration_seconds")),
        generation_mode: editorValue("generation_mode"),
        position: editorValue("position"),
        anchor_clip_id: editorValue("anchor_clip_id"),
        use_previous_frame: Boolean(dom.editorForm.elements.namedItem("use_previous_frame")?.checked),
        reference_ids: [...dom.editorBody.querySelectorAll('input[name="manual_reference_id"]:checked')].map((input) => input.value),
        video_prompt: editorValue("video_prompt"),
        post_production_instructions: editorValue("post_production_instructions"),
      });
      state.selection = { type: "clip", storyId: story.id, episodeId: episode.id, clipId: result.clip_id };
      await loadCatalog();
      showToast(`${result.clip_id} created at sequence ${result.sequence}.`);
    },
  });

  const referenceById = new Map(availableReferences.map((reference) => [reference.id, reference]));
  const modeInput = dom.editorForm.elements.namedItem("generation_mode");
  const positionInput = dom.editorForm.elements.namedItem("position");
  const anchorInput = dom.editorForm.elements.namedItem("anchor_clip_id");
  const previousInput = dom.editorForm.elements.namedItem("use_previous_frame");
  const promptInput = dom.editorForm.elements.namedItem("video_prompt");
  const referencesInput = dom.editorForm.elements.namedItem("references");
  const referenceInputs = [...dom.editorBody.querySelectorAll('input[name="manual_reference_id"]')];
  const promptDraftButton = dom.editorBody.querySelector('[data-agent-action="clip_prompt"]');

  const precedingClip = () => {
    let insertionIndex = clips.length;
    if (positionInput.value === "start") insertionIndex = 0;
    else if (["before", "after"].includes(positionInput.value)) {
      const anchorIndex = clips.findIndex((clip) => clip.id === anchorInput.value);
      if (anchorIndex < 0) return null;
      insertionIndex = positionInput.value === "before" ? anchorIndex : anchorIndex + 1;
    }
    return insertionIndex > 0 ? clips[insertionIndex - 1] : null;
  };

  const updateManualReferences = (changedInput = null) => {
    const mode = modeInput.value;
    promptInput.disabled = mode === "post";
    if (promptDraftButton) promptDraftButton.disabled = mode === "post";
    const previous = precedingClip();
    previousInput.disabled = !previous;
    if (!previous) previousInput.checked = false;
    dom.editorBody.querySelector("[data-previous-frame-label]").textContent = previous
      ? `Use ${previous.id}'s last frame as the first-frame continuity input`
      : "No preceding clip is available at this insertion position";

    if (mode === "i2va" && changedInput?.name === "manual_reference_id" && changedInput.checked) {
      previousInput.checked = false;
      referenceInputs.forEach((input) => { if (input !== changedInput) input.checked = false; });
    } else if (mode === "i2va" && changedInput === previousInput && previousInput.checked) {
      referenceInputs.forEach((input) => { input.checked = false; });
    } else if (mode === "i2va") {
      const checked = referenceInputs.filter((input) => input.checked);
      if (previousInput.checked) checked.forEach((input) => { input.checked = false; });
      else checked.slice(1).forEach((input) => { input.checked = false; });
    }

    const selectedInputs = referenceInputs.filter((input) => input.checked);
    const inputCount = (previousInput.checked ? 1 : 0) + selectedInputs.length;
    previousInput.disabled = !previous || (!previousInput.checked && selectedInputs.length >= 9);
    referenceInputs.forEach((input) => {
      input.disabled = !input.checked && inputCount >= 9;
      input.closest("[data-manual-reference-card]")?.classList.toggle("selected", input.checked);
      input.closest("[data-manual-reference-card]")?.classList.toggle("disabled", input.disabled);
    });

    const references = [];
    let nextPicture = 1;
    if (previousInput.checked && previous) {
      references.push({
        picture: mode === "post" ? null : nextPicture++,
        id: "previous-clip-last-frame",
        role: "first_frame_anchor",
        description: `Final frame from ${previous.id} for visual continuity`,
        source: { type: "clip_artifact", clip_id: previous.id, artifact: "last_frame" },
      });
    }
    selectedInputs.forEach((input) => {
      const reference = referenceById.get(input.value);
      if (!reference) return;
      references.push({
        picture: mode === "post" ? null : nextPicture++,
        id: reference.slug || String(reference.id || "reference").split(":").at(-1),
        role: reference.kind,
        description: `${reference.name} (${reference.kind})`,
        source: { type: "file", path: reference.generation_path || "" },
      });
    });
    referencesInput.value = JSON.stringify(references, null, 2);

    dom.editorBody.querySelector("[data-previous-frame-slot]").textContent = previousInput.checked
      ? mode === "post" ? "Source" : "Picture 1"
      : "";
    selectedInputs.forEach((input, index) => {
      const offset = previousInput.checked ? 1 : 0;
      const slot = input.closest("[data-manual-reference-card]")?.querySelector("[data-reference-slot]");
      if (slot) slot.textContent = mode === "post"
        ? `Source ${index + 1 + offset}`
        : `Picture ${index + 1 + offset}`;
    });
    referenceInputs.filter((input) => !input.checked).forEach((input) => {
      const slot = input.closest("[data-manual-reference-card]")?.querySelector("[data-reference-slot]");
      if (slot) slot.textContent = "";
    });

    const expectedPictures = references.map((reference) => reference.picture).filter(Number.isInteger);
    const usedPictures = [...new Set([...String(promptInput.value || "").matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1])))].sort((left, right) => left - right);
    const status = dom.editorBody.querySelector("[data-manual-reference-status]");
    if (mode === "post") {
      status.className = "manual-reference-status full ok";
      status.textContent = `${references.length} post-production source${references.length === 1 ? "" : "s"} selected; Picture tags are not used in post mode.`;
    } else if ((mode === "ref2va" && expectedPictures.length < 1) || (mode === "i2va" && expectedPictures.length !== 1)) {
      status.className = "manual-reference-status full error";
      status.textContent = mode === "i2va" ? "I2VA requires exactly one image input." : "Ref2VA requires at least one reference image or preceding last frame.";
    } else if (!promptInput.value.trim()) {
      status.className = "manual-reference-status full ok";
      status.textContent = `Expected sockets: ${expectedPictures.map((number) => `<Picture ${number}>`).join(", ")}. A matching placeholder will be created if you save without drafting a prompt.`;
    } else if (JSON.stringify(expectedPictures) === JSON.stringify(usedPictures)) {
      status.className = "manual-reference-status full ok";
      status.textContent = `Prompt Picture tags match the selected sockets: ${expectedPictures.map((number) => `<Picture ${number}>`).join(", ")}.`;
    } else {
      status.className = "manual-reference-status full error";
      status.textContent = `Prompt uses ${usedPictures.length ? usedPictures.map((number) => `<Picture ${number}>`).join(", ") : "no Picture tags"}, but the selected inputs require ${expectedPictures.map((number) => `<Picture ${number}>`).join(", ")}.`;
    }
  };

  modeInput.addEventListener("change", () => updateManualReferences(modeInput));
  positionInput.addEventListener("change", () => updateManualReferences(positionInput));
  anchorInput.addEventListener("change", () => updateManualReferences(anchorInput));
  previousInput.addEventListener("change", () => updateManualReferences(previousInput));
  promptInput.addEventListener("input", () => updateManualReferences(promptInput));
  referenceInputs.forEach((input) => input.addEventListener("change", () => updateManualReferences(input)));
  updateManualReferences();
}

function openAutomaticClipsEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story || !episode) return;
  const availableReferences = [...(story.references || []), ...(episode.references || [])];
  const readyReferences = availableReferences.filter((reference) => reference.ready).length;
  openEditor({
    title: `AI clips for ${episode.title}`,
    submitLabel: "Generate & create clips",
    body: `
      <p class="editor-help">DeepSeek will examine the story, episode outline, existing clips, and ${availableReferences.length} available references. It creates only the next uncovered clips, assigns stable IDs, writes complete structured H3 prompts, and appends them to this episode. When a needed character, environment, object, or episode-specific visual is missing, it can also create a prompt-only reference and wire it into the clips. Run it again to continue a long episode.</p>
      <div class="editor-grid">
        <label class="editor-field"><span>Maximum clips this batch</span><input name="max_clips" type="number" min="1" max="8" step="1" value="6" required></label>
        <label class="editor-field"><span>Previous-frame continuity</span><select name="prefer_previous_frame"><option value="true">Prefer when compatible</option><option value="false">Only when essential</option></select></label>
        <label class="editor-field full"><span>Direction for this batch</span><textarea name="batch_instruction" placeholder="Example: Continue with the launch event. Preserve all Chinese dialogue exactly and create the next six clips."></textarea></label>
      </div>
      <div class="batch-readiness">
        <span>${readyReferences}/${availableReferences.length} reference images currently ready</span>
        <span>10s preferred · 15s hard maximum · 8 clips per batch</span>
      </div>
      <p class="editor-help">New references are added to the story or episode library as <strong>Prompt only</strong>. Select each one afterward and use Z-Image Turbo to generate its PNG before generating clips that depend on it.</p>
      <div class="agent-feedback hidden" data-agent-batch-feedback role="status" aria-live="polite"></div>`,
    onSubmit: async () => {
      const feedback = dom.editorBody.querySelector("[data-agent-batch-feedback]");
      setAgentFeedback(feedback, "DeepSeek is planning, prompting, wiring references, and validating the clip batch…", "pending");
      try {
        const result = await requestJson("/api/agent/create-clips", {
          story_id: story.id,
          episode_id: episode.id,
          max_clips: Number(editorValue("max_clips")),
          prefer_previous_frame: editorValue("prefer_previous_frame") !== "false",
          instruction: editorValue("batch_instruction"),
        });
        const last = result.clips?.at(-1);
        if (last) state.selection = { type: "clip", storyId: story.id, episodeId: episode.id, clipId: last.clip_id };
        await loadCatalog();
        const referenceCount = Number(result.created_reference_count || 0);
        const referenceMessage = referenceCount
          ? ` and ${referenceCount} new reference prompt${referenceCount === 1 ? "" : "s"}`
          : "";
        const recoveryCount = Number(result.validation_recovery_count || 0);
        const recoveryMessage = recoveryCount
          ? ` DeepSeek automatically corrected ${recoveryCount} invalid draft${recoveryCount === 1 ? "" : "s"}.`
          : "";
        showToast(`${result.created_count} AI clip${result.created_count === 1 ? "" : "s"}${referenceMessage} created and validated.${recoveryMessage}`);
      } catch (error) {
        setAgentFeedback(feedback, error.message || String(error), "error");
        throw error;
      }
    },
  });
}

function eligibleEpisodeH3Clips(episode) {
  return (episode?.clips || []).filter((clip) => clip.structured_path && ["ref2va", "i2va"].includes(clip.type));
}

function preferredTargetClipId(clips) {
  const selectedId = state.selection?.type === "clip" ? state.selection.clipId : null;
  return clips.some((clip) => clip.id === selectedId) ? selectedId : clips.at(-1)?.id || "";
}

function targetClipOptions(clips, selectedId) {
  return clips.map((clip) => `<option value="${escapeHtml(clip.id)}" ${clip.id === selectedId ? "selected" : ""}>${escapeHtml(`${clip.id} · ${clip.title}`)}</option>`).join("");
}

function dependencyChainLabel(episode, clipId, includeChain = true) {
  const clips = includeChain
    ? [...fullClipDependencyChain(episode, clipId).values()].sort((left, right) => left.sequence - right.sequence)
    : (episode.clips || []).filter((clip) => clip.id === clipId);
  return clips.length ? clips.map((clip) => clip.id).join(" → ") : "No eligible clips";
}

function attachDependencyPreview(episode) {
  setTimeout(() => {
    const target = dom.editorBody.querySelector("[data-chain-target]");
    const include = dom.editorBody.querySelector("[data-include-chain]");
    const preview = dom.editorBody.querySelector("[data-chain-preview]");
    if (!target || !preview) return;
    const update = () => {
      preview.textContent = dependencyChainLabel(episode, target.value, include ? include.checked : true);
    };
    target.addEventListener("change", update);
    include?.addEventListener("change", update);
    update();
  }, 0);
}

function openBatchPromptReviewEditor(result) {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story || !episode || !result?.clips?.length) return;
  openEditor({
    title: `Review ${result.clips.length} regenerated H3 prompts`,
    submitLabel: "Save prompt replacements",
    body: `
      <p class="editor-help">These are unsaved replacements. Review or edit every prompt below. Saving validates the entire batch first, then replaces only the video_prompt fields. Closing this editor discards all previews.</p>
      <div class="batch-prompt-review-list">
        ${result.clips.map((clip) => `
          <section class="batch-prompt-review-card">
            <div class="batch-prompt-review-heading">
              <strong>${escapeHtml(`${clip.clip_id} · ${clip.title}`)}</strong>
              <span>${escapeHtml(typeLabel(clip.generation_mode))} · ${escapeHtml(formatDuration(clip.duration_seconds))}</span>
            </div>
            <textarea data-batch-prompt="${escapeHtml(clip.clip_id)}">${escapeHtml(clip.video_prompt)}</textarea>
          </section>`).join("")}
      </div>`,
    onSubmit: async () => {
      const prompts = result.clips.map((clip) => ({
        clip_id: clip.clip_id,
        video_prompt: dom.editorBody.querySelector(`[data-batch-prompt="${clip.clip_id}"]`)?.value || "",
      }));
      const saved = await requestJson("/api/content/clip-prompts", {
        story_id: story.id,
        episode_id: episode.id,
        prompts,
      }, "PUT");
      await loadCatalog();
      showToast(`${saved.updated_count} H3 prompt${saved.updated_count === 1 ? "" : "s"} replaced.`);
    },
  });
}

function openBatchPromptRegenerationEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  const clips = eligibleEpisodeH3Clips(episode);
  if (!story || !episode || !clips.length) {
    showToast("This episode has no structured H3 clips to rewrite.");
    return;
  }
  const selectedId = preferredTargetClipId(clips);
  openEditor({
    title: `Batch rewrite H3 prompts for ${episode.title}`,
    submitLabel: "Generate prompt previews",
    body: `
      <p class="editor-help">Choose the last clip you want rewritten. With dependency expansion enabled, selecting clip-08 rewrites its complete previous-frame chain from the earliest required clip through clip-08. DeepSeek generates previews only; you review them in a second editor before anything is saved.</p>
      <div class="editor-grid single">
        <label class="editor-field"><span>Target clip</span><select name="prompt_target_clip" data-chain-target>${targetClipOptions(clips, selectedId)}</select></label>
        <label class="editor-check"><input type="checkbox" name="include_prompt_chain" data-include-chain checked> Include complete previous-frame dependency chain</label>
        <label class="editor-field"><span>Expanded prompt batch</span><div class="dependency-chain-preview" data-chain-preview></div></label>
        <label class="editor-field"><span>Extra direction</span><textarea name="prompt_batch_instruction" placeholder="Example: Preserve all dialogue exactly, strengthen visual continuity, and use restrained camera movement."></textarea></label>
      </div>`,
    onSubmit: async () => {
      const result = await requestJson("/api/agent/regenerate-prompts", {
        story_id: story.id,
        episode_id: episode.id,
        clip_ids: [editorValue("prompt_target_clip")],
        include_dependency_chain: Boolean(dom.editorBody.querySelector('[name="include_prompt_chain"]')?.checked),
        instruction: editorValue("prompt_batch_instruction"),
      });
      setTimeout(() => openBatchPromptReviewEditor(result), 0);
    },
  });
  attachDependencyPreview(episode);
}

function openRegenerateVideoChainEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  const clips = eligibleEpisodeH3Clips(episode);
  if (!story || !episode || !clips.length) {
    showToast("This episode has no structured H3 clips to regenerate.");
    return;
  }
  const selectedId = preferredTargetClipId(clips);
  openEditor({
    title: `Regenerate an H3 dependency chain`,
    submitLabel: "Regenerate H3 chain",
    body: `
      <p class="editor-help">Choose the final target clip. AITurboShow follows every previous-frame dependency back to the earliest required clip and force-regenerates the chain in sequence. For example, clip-08 can expand to clip-01 → … → clip-08. Existing outputs remain available until each replacement finishes successfully.</p>
      <div class="editor-grid single">
        <label class="editor-field"><span>Final target clip</span><select name="video_chain_target" data-chain-target>${targetClipOptions(clips, selectedId)}</select></label>
        <label class="editor-field"><span>Expanded video batch</span><div class="dependency-chain-preview" data-chain-preview></div></label>
        <label class="editor-field"><span>H3 resolution</span><select name="video_chain_resolution">${h3ResolutionOptions("864x480")}</select></label>
      </div>`,
    onSubmit: async () => {
      const clipId = editorValue("video_chain_target");
      const [width, height] = editorValue("video_chain_resolution").split("x").map(Number);
      const payload = {
        story_id: story.id,
        episode_id: episode.id,
        clip_ids: [clipId],
        force: true,
        include_dependency_chain: true,
        options: { width, height },
      };
      const preview = await postJson("/api/comfy/generate-batch", { ...payload, preview_only: true });
      const chain = (preview.clips || []).map((clip) => clip.clip_id).join(" → ");
      if (!window.confirm(`Regenerate ${preview.queueable_count} clip(s) in this order?\n\n${chain}\n\nExisting outputs will be replaced only after each new clip completes.`)) {
        throw new Error("Regeneration cancelled.");
      }
      const result = await postJson("/api/comfy/generate-batch", payload);
      await refreshComfyState();
      showToast(`${result.queued_count} dependency-chain clip${result.queued_count === 1 ? "" : "s"} queued at ${width}×${height}.`);
    },
  });
  attachDependencyPreview(episode);
}

function openEpisodeQueueEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story || !episode) return;
  const clips = (episode.clips || []).filter((clip) => clip.structured_path && ["ref2va", "i2va"].includes(clip.type));
  if (!clips.length) {
    showToast("This episode has no structured H3 clips to queue.");
    return;
  }
  const activeClipIds = new Set(state.generationJobs
    .filter((job) => job.story_id === story.id && job.episode_id === episode.id && activeGenerationStatuses.has(job.status))
    .map((job) => job.clip_id));
  openEditor({
    title: `Queue H3 clips for ${episode.title}`,
    submitLabel: "Add to queue",
    body: `
      <p class="editor-help">Choose several clips or select the whole episode. AITurboShow keeps them in a visible local queue and submits H3 clips to ComfyUI one at a time, allowing earlier last-frame dependencies to finish before later clips begin.</p>
      <div class="queue-selection-actions">
        <button class="generation-button" type="button" data-queue-select="unfinished">Ready unfinished</button>
        <button class="generation-button" type="button" data-queue-select="all">Whole episode</button>
        <button class="generation-button" type="button" data-queue-select="none">Clear</button>
      </div>
      <div class="batch-clip-list">
        ${clips.map((clip) => {
          const active = activeClipIds.has(clip.id);
          const readiness = clipQueueReadiness(clip);
          const checked = !active && !clip.complete && readiness.queueable;
          const stateLabel = active
            ? "Already queued"
            : clip.complete
              ? "Outputs ready"
              : readiness.dependencyOnly
                ? `Will queue ${readiness.dependencyClipIds.join(", ")} first`
                : readiness.queueable
                ? "Ready"
                : "Needs assets or an earlier dependency";
          return `
            <label class="batch-clip-row ${active ? "disabled" : ""}">
              <input type="checkbox" name="queue_clip" value="${escapeHtml(clip.id)}" ${checked ? "checked" : ""} ${active ? "disabled" : ""}>
              <span class="batch-clip-id">${escapeHtml(clip.id)}</span>
              <span class="batch-clip-copy"><strong>${escapeHtml(clip.title)}</strong><small>${escapeHtml(typeLabel(clip.type))} · ${escapeHtml(formatDuration(clip.duration))}</small></span>
              <span class="batch-clip-state ${readiness.queueable ? "ready" : "warning"}">${escapeHtml(stateLabel)}</span>
            </label>`;
        }).join("")}
      </div>
      <label class="editor-field">
        <span>H3 resolution</span>
        <select name="h3_resolution">${h3ResolutionOptions("864x480")}</select>
      </label>
      <label class="editor-check"><input type="checkbox" name="force_regeneration"> Regenerate selected clips whose outputs already exist</label>
      <p class="editor-help">Clips with missing fixed reference images can be queued, but their task will show an error when reached unless those images become ready first.</p>`,
    onSubmit: async () => {
      const selectedIds = [...dom.editorBody.querySelectorAll('input[name="queue_clip"]:checked')].map((input) => input.value);
      if (!selectedIds.length) throw new Error("Select at least one clip to queue.");
      const force = Boolean(dom.editorBody.querySelector('input[name="force_regeneration"]')?.checked);
      const [width, height] = editorValue("h3_resolution").split("x").map(Number);
      const result = await postJson("/api/comfy/generate-batch", {
        story_id: story.id,
        episode_id: episode.id,
        clip_ids: selectedIds,
        force,
        options: { width, height },
      });
      await refreshComfyState();
      const skippedMessage = result.skipped_count ? ` ${result.skipped_count} skipped.` : "";
      const duplicateMessage = result.duplicate_count ? ` ${result.duplicate_count} already queued.` : "";
      showToast(`${result.queued_count} clip${result.queued_count === 1 ? "" : "s"} added to the H3 queue.${duplicateMessage}${skippedMessage}`);
    },
  });
}

function openBatchReferenceEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story || !episode) return;
  const references = [...(story.references || []), ...(episode.references || [])]
    .filter((reference, index, all) => all.findIndex((candidate) => candidate.id === reference.id) === index);
  const candidates = references.filter((reference) => reference.prompt_text && /\.png$/i.test(reference.generation_path || ""));
  if (!candidates.length) {
    showToast("This episode has no references with generation prompts.");
    return;
  }
  const activeReferenceIds = new Set(state.generationJobs
    .filter((job) => job.kind === "image" && activeGenerationStatuses.has(job.status))
    .map((job) => job.reference_id));
  openEditor({
    title: `Batch reference images · ${episode.title}`,
    submitLabel: "Generate selected images",
    body: `
      <p class="editor-help">Generate multiple story and episode references together. Prompt-only references are selected by default; existing images can be regenerated with the option below.</p>
      <div class="queue-selection-actions">
        <button class="generation-button" type="button" data-reference-select="unfinished">Prompt-only</button>
        <button class="generation-button" type="button" data-reference-select="all">Select all</button>
        <button class="generation-button" type="button" data-reference-select="none">Clear</button>
      </div>
      <div class="batch-clip-list batch-reference-list">
        ${candidates.map((reference) => {
          const active = activeReferenceIds.has(reference.id);
          return `<label class="batch-clip-row ${active ? "disabled" : ""}">
            <input type="checkbox" name="batch_reference" value="${escapeHtml(reference.id)}" ${!active && !reference.ready ? "checked" : ""} ${active ? "disabled" : ""}>
            <span class="batch-clip-id">${escapeHtml(reference.scope === "episode" ? "EP" : "ST")}</span>
            <span class="batch-clip-copy"><strong>${escapeHtml(reference.name)}</strong><small>${escapeHtml(reference.kind)} · ${reference.ready ? "Image ready" : "Prompt only"}</small></span>
            <span class="batch-clip-state ${active ? "warning" : reference.ready ? "ready" : "warning"}">${active ? "Already running" : reference.ready ? "Ready" : "Needs image"}</span>
          </label>`;
        }).join("")}
      </div>
      <label class="editor-field"><span>Image size</span><select name="batch_reference_size">
        <option value="auto">Use each reference default</option>
        <option value="1024x1024">Square · 1024×1024</option>
        <option value="1344x768">Landscape · 1344×768</option>
        <option value="768x1024">Portrait · 768×1024</option>
      </select></label>
      <label class="editor-check"><input type="checkbox" name="batch_reference_force"> Regenerate selected images that already exist</label>`,
    onSubmit: async () => {
      const selectedIds = [...dom.editorBody.querySelectorAll('input[name="batch_reference"]:checked')].map((input) => input.value);
      if (!selectedIds.length) throw new Error("Select at least one reference image.");
      const force = Boolean(dom.editorBody.querySelector('input[name="batch_reference_force"]')?.checked);
      const size = editorValue("batch_reference_size");
      let queued = 0;
      let duplicates = 0;
      const errors = [];
      for (const referenceId of selectedIds) {
        const reference = candidates.find((candidate) => candidate.id === referenceId);
        try {
          const options = size === "auto" ? {} : (() => { const [width, height] = size.split("x").map(Number); return { width, height }; })();
          const result = await postJson("/api/comfy/image/generate", { story_id: story.id, episode_id: episode.id, reference_id: referenceId, force, options });
          if (result.duplicate) duplicates += 1;
          else queued += 1;
        } catch (error) {
          errors.push(`${reference?.name || referenceId}: ${error.message}`);
        }
      }
      await refreshComfyState();
      showToast(`${queued} reference image${queued === 1 ? "" : "s"} queued.${duplicates ? ` ${duplicates} already running.` : ""}${errors.length ? ` ${errors.length} failed.` : ""}`);
      if (errors.length) console.warn("Batch reference generation errors", errors);
    },
  });
}

function openEditClipEditor(clip) {
  const story = currentStory();
  const episode = currentEpisode();
  const payload = clip.structured_payload;
  if (!story || !episode || !payload) {
    showToast("Only structured clips can be edited here.");
    return;
  }
  openEditor({
    title: `Edit ${clip.id}`,
    body: `
      <p class="editor-help">Clip ID and sequence are stable here. Use the move controls to reorder. Picture numbers in the prompt must exactly match the ordered reference sockets.</p>
      <div class="editor-grid">
        <label class="editor-field"><span>Title</span><input name="title" required value="${escapeHtml(payload.title)}"></label>
        <label class="editor-field"><span>Duration seconds</span><input name="duration_seconds" type="number" min="0.1" max="15" step="0.1" required value="${escapeHtml(payload.duration_seconds)}"></label>
        <label class="editor-field"><span>Generation mode</span><select name="generation_mode">${["ref2va", "i2va", "post"].map((mode) => `<option value="${mode}" ${payload.generation_mode === mode ? "selected" : ""}>${typeLabel(mode)}</option>`).join("")}</select></label>
        <label class="editor-field"><span>Path base</span><select name="path_base">${["story", "episode", "repository"].map((base) => `<option value="${base}" ${payload.path_base === base ? "selected" : ""}>${base}</option>`).join("")}</select></label>
        <label class="editor-field full"><span>Video prompt</span><textarea class="tall" name="video_prompt">${escapeHtml(payload.video_prompt || "")}</textarea></label>
        <label class="editor-field full"><span>First-frame image prompt</span><textarea name="first_frame_image_prompt">${escapeHtml(payload.first_frame_image_prompt || "")}</textarea></label>
        <label class="editor-field full"><span>Post-production instructions</span><textarea name="post_production_instructions">${escapeHtml(payload.post_production_instructions || "")}</textarea></label>
        <label class="editor-field full"><span>References JSON</span><textarea class="tall" name="references">${escapeHtml(JSON.stringify(payload.references || [], null, 2))}</textarea></label>
        <label class="editor-field full"><span>Outputs JSON</span><textarea name="outputs">${escapeHtml(JSON.stringify(payload.outputs || {}, null, 2))}</textarea></label>
      </div>
      ${agentAssist([
        { action: "clip_prompt", target: "video_prompt", label: "Draft video prompt" },
        { action: "first_frame_prompt", target: "first_frame_image_prompt", label: "Draft first frame" },
        { action: "post_production_instructions", target: "post_production_instructions", label: "Draft post notes" },
      ], "The agent reads the current structured clip, reference sockets, episode flow, duration, and your unsaved editor changes.")}`,
    onSubmit: async () => {
      const mode = editorValue("generation_mode");
      const updated = {
        ...payload,
        title: editorValue("title"),
        duration_seconds: Number(editorValue("duration_seconds")),
        generation_mode: mode,
        path_base: editorValue("path_base"),
        video_prompt: mode === "post" ? null : editorValue("video_prompt"),
        first_frame_image_prompt: editorValue("first_frame_image_prompt").trim() || null,
        post_production_instructions: editorValue("post_production_instructions").trim() || null,
        references: parseEditorJson("references", "References"),
        outputs: parseEditorJson("outputs", "Outputs"),
      };
      await requestJson("/api/content/clip", {
        story_id: story.id,
        episode_id: episode.id,
        clip_id: clip.id,
        clip: updated,
      }, "PUT");
      await loadCatalog();
      showToast(`${clip.id} saved.`);
    },
  });
}

function openNewReferenceEditor() {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story) return;
  openEditor({
    title: "Create reference",
    submitLabel: "Create reference",
    body: `
      <div class="editor-grid">
        <label class="editor-field"><span>Scope</span><select name="scope"><option value="story">Story-wide</option>${episode ? '<option value="episode">Current episode</option>' : ""}</select></label>
        <label class="editor-field"><span>Kind</span><select name="kind"><option value="character">Character</option><option value="environment">Environment</option><option value="object">Object</option></select></label>
        <label class="editor-field full"><span>Reference slug</span><input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="reference-name"></label>
        <label class="editor-field full"><span>Z-Image Turbo prompt</span><textarea class="tall" name="prompt_text" required placeholder="Describe the reference image in detail."></textarea></label>
      </div>
      ${agentAssist([{ action: "reference_image_prompt", target: "prompt_text", label: "Draft image prompt" }], "Choose the scope and kind, add a useful slug, then describe the identity, design, or product requirements in the extra direction.")}`,
    onSubmit: async () => {
      const result = await requestJson("/api/content/reference", {
        story_id: story.id,
        episode_id: episode?.id || null,
        scope: editorValue("scope"),
        kind: editorValue("kind"),
        slug: editorValue("slug"),
        prompt_text: editorValue("prompt_text"),
      });
      await loadCatalog();
      selectReference(result.reference_id);
      showToast("Reference created and ready for image generation.");
    },
  });
}

function openEditReferenceEditor(reference) {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story) return;
  openEditor({
    title: `Edit ${reference.name}`,
    body: `
      <p class="editor-help">${reference.auto_discovered ? `This reference was discovered in clip inputs. Saving writes its image prompt to ${escapeHtml(reference.prompt_path)}. ` : ""}This edits the source prompt used by Z-Image Turbo. Existing generated images are preserved until you explicitly regenerate them.</p>
      <div class="editor-grid single">
        <label class="editor-field"><span>Reference prompt</span><textarea class="tall" name="prompt_text" required>${escapeHtml(reference.prompt_text || "")}</textarea></label>
      </div>
      ${agentAssist([{ action: "reference_image_prompt", target: "prompt_text", label: "Improve image prompt" }], "The agent uses the current reference prompt plus story and episode context while preserving the reference's role.")}`,
    onSubmit: async () => {
      await requestJson("/api/content/reference", {
        story_id: story.id,
        episode_id: episode?.id || null,
        reference_id: reference.id,
        prompt_text: editorValue("prompt_text"),
      }, "PUT");
      await loadCatalog();
      showToast("Reference prompt saved.");
    },
  });
}

async function moveSelectedClip(clip, direction) {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story || !episode) return;
  const result = await postJson("/api/content/clip/move", {
    story_id: story.id,
    episode_id: episode.id,
    clip_id: clip.id,
    direction,
  });
  await loadCatalog();
  showToast(`${clip.id} moved to sequence ${result.sequence}.`);
}

function uploadPresentation(reference) {
  if (!reference?.upload_path) return { className: "", attributes: "", hint: "" };
  const ready = Boolean(reference.upload_ready);
  return {
    className: `image-drop-target ${ready ? "upload-filled" : "upload-empty"}`,
    attributes: `data-upload-path="${escapeHtml(reference.upload_path)}" data-upload-ready="${ready}"`,
    hint: `<span class="drop-hint">${ready ? "Drop to replace" : "Drop generated image"}</span>`,
  };
}

function targetImageMime(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  throw new Error("This declared destination does not support image uploads.");
}

async function convertImageForTarget(file, path) {
  if (!file.type.startsWith("image/")) throw new Error("Drop a valid image file.");
  const mime = targetImageMime(path);
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not prepare this image.");
    if (mime === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.95));
    if (!blob) throw new Error("The browser could not convert this image.");
    if (blob.size > 50 * 1024 * 1024) throw new Error("The converted image exceeds the 50 MB upload limit.");
    return blob;
  } finally {
    bitmap.close();
  }
}

async function sendImageUpload(path, blob, overwrite) {
  const response = await fetch(`/api/upload-image?path=${encodeURIComponent(path)}&overwrite=${overwrite ? "1" : "0"}`, {
    method: "POST",
    headers: { "Content-Type": blob.type },
    body: blob,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Image upload failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function uploadDroppedImage(target, file) {
  const path = target.dataset.uploadPath;
  if (!path) return;
  target.classList.add("uploading");
  try {
    const blob = await convertImageForTarget(file, path);
    let overwrite = target.dataset.uploadReady === "true";
    if (overwrite && !window.confirm(`Replace the existing generated image?\n\n${path}`)) return;
    try {
      await sendImageUpload(path, blob, overwrite);
    } catch (error) {
      if (error.status !== 409 || overwrite) throw error;
      if (!window.confirm(`An image already exists at this destination. Replace it?\n\n${path}`)) return;
      overwrite = true;
      await sendImageUpload(path, blob, true);
    }
    showToast(`Saved ${path.split("/").pop()}`);
    await loadCatalog({ preserveSelection: true });
  } catch (error) {
    console.error(error);
    showToast(error.message || String(error));
  } finally {
    target.classList.remove("drag-over", "uploading");
  }
}

function setScanStatus(label, status = "") {
  dom.scanStatus.className = `scan-status ${status}`.trim();
  dom.scanStatus.innerHTML = `<span></span>${escapeHtml(label)}`;
}

async function loadCatalog({ preserveSelection = true } = {}) {
  const previousStory = preserveSelection ? state.storyId : null;
  const previousEpisode = preserveSelection ? state.episodeId : null;
  setScanStatus("Scanning");
  dom.refreshButton.disabled = true;
  try {
    const response = await fetch(`/api/catalog?_=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`);
    state.catalog = await response.json();
    const storyExists = state.catalog.stories.some((story) => story.id === previousStory);
    state.storyId = storyExists ? previousStory : state.catalog.stories[0]?.id || null;
    const story = currentStory();
    const episodeExists = story?.episodes?.some((episode) => episode.id === previousEpisode);
    state.episodeId = episodeExists ? previousEpisode : story?.episodes?.[0]?.id || null;
    if (state.selection && state.selection.storyId !== state.storyId) state.selection = null;
    if (state.selection && (state.selection.episodeId !== state.episodeId || !selectionData())) state.selection = null;
    if (!state.navigationInitialized) {
      state.collapsedStories = new Set(state.catalog.stories.filter((candidate) => candidate.id !== state.storyId).map((candidate) => candidate.id));
      state.collapsedEpisodes = new Set(state.catalog.stories.flatMap((candidate) => candidate.episodes.filter((episode) => candidate.id !== state.storyId || episode.id !== state.episodeId).map((episode) => `${candidate.id}:${episode.id}`)));
      state.navigationInitialized = true;
    }
    renderAll();
    setScanStatus("Live", "ready");
  } catch (error) {
    console.error(error);
    setScanStatus("Error", "error");
    showToast(error.message || String(error));
  } finally {
    dom.refreshButton.disabled = false;
  }
}

function renderAll() {
  const stories = state.catalog?.stories || [];
  const story = currentStory();
  const episode = currentEpisode();
  dom.storyCount.textContent = stories.length;
  dom.emptyState.classList.toggle("hidden", stories.length > 0);
  dom.storyView.classList.toggle("hidden", stories.length === 0);
  dom.editStoryButton.disabled = !story;
  dom.newEpisodeButton.disabled = !story;
  dom.newReferenceButton.disabled = !story;
  dom.editEpisodeButton.disabled = !episode;
  dom.newClipButton.disabled = !episode;
  dom.aiClipsButton.disabled = !episode;
  dom.rewritePromptsButton.disabled = !episode;
  dom.regenerateChainButton.disabled = !episode;
  dom.queueEpisodeButton.disabled = !episode;
  dom.batchReferenceButton.disabled = !episode;
  renderTree();
  if (stories.length) renderStory();
  renderInspector();
  if (state.storyId && state.episodeId) state.lastEpisodes[state.storyId] = state.episodeId;
  const key = locationKey();
  if (renderedLocation !== key) {
    const initial = renderedLocation === null;
    renderedLocation = key;
    navigationReady = false;
    requestAnimationFrame(() => {
      const position = state.viewPositions[key] || {};
      document.querySelector(".workspace").scrollTop = scrollValue(position.workspace);
      dom.clipViewport.scrollLeft = scrollValue(position.graph);
      dom.inspectorBody.scrollTop = scrollValue(position.inspector);
      if (initial) dom.storyTree.scrollTop = savedTreeScroll;
      navigationReady = true;
      saveNavigation();
    });
  } else saveNavigation();
}

function renderTree() {
  const stories = state.catalog?.stories || [];
  const query = state.query.trim().toLowerCase();
  const matches = (value) => String(value || "").toLowerCase().includes(query);
  const focused = document.activeElement?.closest("[data-tree-toggle]");
  const focusKey = focused ? { kind: focused.dataset.treeToggle, story: focused.dataset.story, episode: focused.dataset.episode } : null;
  const referenceRow = (story, episode) => {
    const refs = episode ? episode.references || [] : story.references || [];
    if (!refs.length) return "";
    return `<button class="tree-row reference-level" type="button" data-action="scroll-references" data-story="${escapeHtml(story.id)}" ${episode ? `data-episode="${escapeHtml(episode.id)}"` : ""}><span class="tree-chevron" aria-hidden="true">◇</span><span class="tree-label">${episode ? "Episode references" : "Shared references"}</span><span class="tree-count">${refs.length}</span></button>`;
  };
  const branch = (kind, story, episode, collapsed, content, children, active) => {
    const id = `tree-${kind}-${encodeURIComponent(story.id)}${episode ? "-" + encodeURIComponent(episode.id) : ""}`;
    const title = episode?.title || story.title;
    const attributes = `data-story="${escapeHtml(story.id)}"${episode ? ` data-episode="${escapeHtml(episode.id)}"` : ""}`;
    return `<div class="tree-branch ${kind}-branch"><div class="tree-branch-heading ${active ? "active" : ""}">
      <button class="tree-chevron tree-toggle ${collapsed ? "collapsed" : ""}" type="button" data-tree-toggle="${kind}" ${attributes} aria-label="${collapsed ? "Expand" : "Collapse"} ${escapeHtml(title)}" aria-expanded="${!collapsed}" aria-controls="${id}">⌄</button>
      <button class="tree-row ${kind}-level ${active ? "active" : ""}" type="button" data-action="select-${kind}" ${attributes} ${active ? 'aria-current="location"' : ""} title="${escapeHtml(title)}">${content}</button>
      </div><div id="${id}" class="tree-children ${collapsed ? "collapsed" : ""}">${children}</div></div>`;
  };
  dom.storyTree.innerHTML = stories.map((story) => {
    const storyMatch = query && matches(`${story.title} ${story.id}`);
    const episodes = (story.episodes || []).map((episode) => {
      const episodeMatch = storyMatch || (query && matches(`${episode.id} ${episode.title}`));
      const clips = (episode.clips || []).filter((clip) => !query || episodeMatch || matches(`${clip.id} ${clip.title} ${typeLabel(clip.type)}`));
      const refMatch = (episode.references || []).some((ref) => matches(`${ref.name} ${ref.slug}`));
      if (query && !episodeMatch && !clips.length && !refMatch) return "";
      const episodeActive = story.id === state.storyId && episode.id === state.episodeId;
      const clipHtml = clips.map((clip) => {
        const selected = state.selection?.type === "clip" && state.selection.clipId === clip.id && episodeActive;
        return `<button class="tree-row clip-level ${selected ? "active" : ""}" type="button" data-action="select-clip" data-story="${escapeHtml(story.id)}" data-episode="${escapeHtml(episode.id)}" data-clip="${escapeHtml(clip.id)}" ${selected ? 'aria-current="location"' : ""} title="${escapeHtml(`${clip.id} · ${clip.title}`)}"><span class="tree-status ${clipStatus(clip)}"></span><span class="tree-clip-number">${String(clip.sequence || clip.number || "").padStart(2, "0")}</span><span class="tree-label">${escapeHtml(clip.title)}</span><span class="tree-count">${escapeHtml(formatDuration(clip.duration))}</span></button>`;
      }).join("");
      return branch("episode", story, episode, !query && state.collapsedEpisodes.has(`${story.id}:${episode.id}`), `<span class="tree-label">${escapeHtml(episode.title)}</span><span class="tree-count">${episode.clip_count}</span>`, referenceRow(story, episode) + clipHtml, episodeActive);
    }).join("");
    const storyRefMatch = (story.references || []).some((ref) => matches(`${ref.name} ${ref.slug}`));
    if (query && !storyMatch && !episodes && !storyRefMatch) return "";
    return branch("story", story, null, !query && state.collapsedStories.has(story.id), `<span class="tree-icon">AI</span><span class="tree-label">${escapeHtml(story.title)}</span><span class="tree-count">${story.episode_count} ep</span>`, referenceRow(story) + episodes, story.id === state.storyId);
  }).join("") || '<div class="no-content">No productions match your search.</div>';
  if (focusKey) [...dom.storyTree.querySelectorAll("[data-tree-toggle]")].find((button) => button.dataset.treeToggle === focusKey.kind && button.dataset.story === focusKey.story && button.dataset.episode === focusKey.episode)?.focus({ preventScroll: true });
}

function renderStory() {
  const story = currentStory();
  const episode = currentEpisode();
  if (!story) return;

  dom.storyTitle.textContent = story.title;
  dom.storySummary.textContent = story.summary;
  dom.storyPath.textContent = story.path;
  const readyReferences = (story.references || []).filter((reference) => reference.ready).length;
  dom.storyStats.innerHTML = [
    [story.episode_count, "Episodes"],
    [story.clip_count, "Clips"],
    [story.references?.length || 0, "Fixed refs"],
  ].map(([value, label]) => `
    <div class="stat-card">
      <div class="stat-value">${escapeHtml(value)}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
    </div>`).join("");

  dom.referenceSummary.textContent = `${readyReferences}/${story.references?.length || 0} images available`;
  renderStoryReferences(story.references || []);

  if (!episode) {
    dom.episodeTitle.textContent = "No episodes yet";
    dom.episodeSummary.textContent = "Create the first episode to begin adding structured clips.";
    dom.episodePreview.innerHTML = "";
    dom.episodeTabs.innerHTML = "";
    dom.graphMeta.textContent = "0 nodes · 0s";
    dom.clipFlow.innerHTML = '<div class="no-content">This story has no episodes. Use + Episode to create one.</div>';
    dom.episodeReferenceLibrary.classList.add("hidden");
    dom.episodeReferences.innerHTML = "";
    return;
  }

  dom.episodeTitle.textContent = episode.title;
  dom.episodeSummary.textContent = episode.summary || "No episode summary found.";
  renderEpisodePreview(episode);
  dom.episodeTabs.innerHTML = story.episodes.map((candidate) => `
    <button class="episode-tab ${candidate.id === episode.id ? "active" : ""}" data-episode="${escapeHtml(candidate.id)}">
      ${String(candidate.number).padStart(2, "0")}
    </button>`).join("");
  const episodeActiveTasks = state.generationJobs.filter((job) => (
    job.story_id === story.id && job.episode_id === episode.id && activeGenerationStatuses.has(job.status)
  )).length;
  dom.graphMeta.textContent = `${episode.clip_count} nodes · ${formatTotalDuration(episode.duration)}${episodeActiveTasks ? ` · ${episodeActiveTasks} queued` : ""}`;
  dom.episodeReferenceLibrary.classList.remove("hidden");
  const readyEpisodeReferences = (episode.references || []).filter((reference) => reference.ready).length;
  const discoveredReferences = (episode.references || []).filter((reference) => reference.auto_discovered).length;
  dom.episodeReferenceSummary.textContent = `${readyEpisodeReferences}/${episode.references?.length || 0} images available${discoveredReferences ? ` · ${discoveredReferences} discovered in clips` : ""}`;
  renderEpisodeReferences(episode.references || []);
  renderClipFlow(episode.clips || []);
}

function renderEpisodePreview(episode) {
  if (!dom.episodePreview) return;
  const clips = (episode.clips || []).filter((clip) => clip.output_states?.video?.ready && clip.output_states.video.asset?.url);
  const key = clips.map((clip) => `${clip.id}:${clip.output_states.video.asset.url}`).join("|");
  const previousKey = dom.episodePreview.dataset.playlistKey || "";
  if (key && key === previousKey && dom.episodePreview.querySelector("video")) return;
  if (!clips.length) {
    dom.episodePreview.dataset.playlistKey = "";
    dom.episodePreview.innerHTML = `
      <div class="episode-preview-heading">
        <div><div class="eyebrow">Episode preview</div><h3>Whole episode</h3></div>
        <span class="episode-preview-count">No generated videos yet</span>
      </div>
      <div class="no-content">Generate at least one clip to preview this episode continuously.</div>`;
    state.episodePlaylist = null;
    return;
  }
  state.episodePlaylist = { key, clips, index: 0 };
  dom.episodePreview.dataset.playlistKey = key;
  dom.episodePreview.innerHTML = `
    <div class="episode-preview-heading">
      <div><div class="eyebrow">Episode preview</div><h3>Whole episode</h3></div>
      <span class="episode-preview-count" data-episode-preview-count>1 / ${clips.length} generated clips</span>
    </div>
    <div class="episode-preview-frame">
      <video class="episode-preview-video" data-episode-player controls autoplay muted playsinline preload="metadata" aria-label="Continuous preview of ${escapeHtml(episode.title)}">
        Your browser cannot preview this video format.
      </video>
    </div>
    <div class="episode-preview-footer"><span data-episode-preview-title>${escapeHtml(clips[0].title)}</span><span class="episode-preview-actions"><button class="generation-button" type="button" data-episode-preview-action="previous">Previous</button><button class="generation-button" type="button" data-episode-preview-action="next">Next</button><span>${clips.length < (episode.clips || []).length ? `${clips.length} of ${episode.clips.length} clips available` : "All clips available"}</span></span></div>`;
  setEpisodePreviewSource();
}

function setEpisodePreviewSource() {
  const playlist = state.episodePlaylist;
  const player = dom.episodePreview?.querySelector("[data-episode-player]");
  if (!playlist || !player) return;
  const clip = playlist.clips[playlist.index];
  player.onended = () => {
    playlist.index = (playlist.index + 1) % playlist.clips.length;
    setEpisodePreviewSource();
  };
  player.src = clip.output_states.video.asset.url;
  player.load();
  player.play().catch(() => {});
  const count = dom.episodePreview.querySelector("[data-episode-preview-count]");
  const title = dom.episodePreview.querySelector("[data-episode-preview-title]");
  if (count) count.textContent = `${playlist.index + 1} / ${playlist.clips.length} generated clips`;
  if (title) title.textContent = clip.title;
}

function renderReferenceCards(references, container, emptyMessage) {
  const query = state.query.trim().toLowerCase();
  const visible = references.filter((reference) => {
    return !query || `${reference.name} ${reference.kind} ${reference.slug} ${(reference.used_by || []).map((use) => `${use.clip_id} ${use.title}`).join(" ")}`.toLowerCase().includes(query);
  });
  if (!visible.length) {
    container.innerHTML = `<div class="no-content">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  container.innerHTML = visible.map((reference) => {
    const image = reference.images?.[0];
    const selected = state.selection?.type === "reference" && state.selection.referenceId === reference.id;
    const upload = uploadPresentation(reference);
    const preview = image
      ? `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(reference.name)}">`
      : `<div class="reference-placeholder">${escapeHtml(reference.kind.slice(0, 1).toUpperCase())}</div>`;
    return `
      <button class="reference-card ${selected ? "active" : ""} ${upload.className}" data-reference="${escapeHtml(reference.id)}" ${upload.attributes}>
        <div class="reference-preview">${preview}${upload.hint}</div>
        <div class="reference-card-body">
          <div class="reference-kind">${escapeHtml(reference.kind)}${reference.auto_discovered ? " · From clips" : ""}</div>
          <div class="reference-name">${escapeHtml(reference.name)}</div>
          <div class="reference-card-meta">
            <span>${reference.images?.length || 0} image${reference.images?.length === 1 ? "" : "s"}</span>
            <span class="availability ${reference.ready ? "" : "missing"}">${reference.ready ? "Ready" : reference.prompt_text ? "Prompt only" : "Missing image"}</span>
          </div>
          ${reference.used_by?.length ? `<div class="reference-usage">Used by ${escapeHtml([...new Set(reference.used_by.map((use) => use.clip_id))].join(", "))}</div>` : ""}
        </div>
      </button>`;
  }).join("");
}

function renderStoryReferences(references) {
  renderReferenceCards(references, dom.storyReferences, "No story references match the current view.");
}

function renderEpisodeReferences(references) {
  renderReferenceCards(references, dom.episodeReferences, state.query ? "No episode references match your search." : "Add an episode reference or declare an image in a clip. Clip references appear here automatically on refresh.");
}

function renderClipFlow(clips) {
  const query = state.query.trim().toLowerCase();
  if (!clips.length) {
    dom.clipFlow.innerHTML = '<div class="no-content">This episode has no clips. Use + Clip to add the first one.</div>';
    return;
  }
  dom.clipFlow.innerHTML = clips.map((clip, index) => {
    const status = clipStatus(clip);
    const selected = state.selection?.type === "clip" && state.selection.clipId === clip.id;
    const searchable = `${clip.id} ${clip.title} ${typeLabel(clip.type)} ${clip.prompt_path || ""}`.toLowerCase();
    const filtered = query && !searchable.includes(query);
    const statusText = status === "post"
      ? "Post"
      : status === "dependency"
        ? "Previous frame pending"
        : status === "partial"
          ? "Needs assets"
          : "Ready";
    const generationJob = generationJobFor(clip);
    const activeGeneration = generationJob && activeGenerationStatuses.has(generationJob.status);
    const generationText = activeGeneration ? generationStatusLabel(generationJob.status) : statusText;
    const generationProgress = activeGeneration ? Math.max(0, Math.min(100, Number(generationJob.progress_percent || 0))) : 0;
    const connector = index < clips.length - 1 ? `<div class="clip-connector"></div>` : "";
    return `
      <div class="clip-node-wrap">
        <button class="clip-node ${status} ${selected ? "active" : ""} ${filtered ? "filtered-out" : ""}" data-clip="${escapeHtml(clip.id)}">
          <div class="clip-node-top">
            <span class="clip-index">${escapeHtml(clip.id.toUpperCase())}</span>
            <span class="duration-chip">${escapeHtml(formatDuration(clip.duration))}</span>
          </div>
          <div class="clip-name">${escapeHtml(clip.title)}</div>
          <div class="clip-type">${escapeHtml(typeLabel(clip.type))}</div>
          <div class="clip-node-footer">
            <div class="node-metrics">
              <span class="node-metric"><b>${clip.ready_reference_count}</b>/${clip.reference_count} refs</span>
              <span class="node-metric"><b>${clip.images?.length || 0}</b> img</span>
            </div>
            <span class="node-status-label">${escapeHtml(generationText)}</span>
          </div>
          ${activeGeneration ? `<div class="node-task-progress ${generationJob.progress_indeterminate ? "indeterminate" : ""}"><span style="width:${generationProgress}%"></span></div>` : ""}
        </button>
        ${connector}
      </div>`;
  }).join("");
}

function selectClip(storyId, episodeId, clipId) {
  capturePosition();
  state.storyId = storyId;
  state.episodeId = episodeId;
  state.selection = { type: "clip", storyId, episodeId, clipId };
  state.inspectorTab = "overview";
  revealCurrentLocation();
  renderAll();
}

function selectReference(referenceId) {
  const reference = findReferenceById(referenceId);
  if (!reference) return;
  state.selection = { type: "reference", storyId: state.storyId, episodeId: state.episodeId, referenceId };
  state.inspectorTab = "overview";
  renderAll();
}

function selectionData() {
  if (!state.selection) return null;
  const story = currentStory();
  const episode = currentEpisode();
  if (state.selection.type === "clip") {
    const clip = episode?.clips?.find((candidate) => candidate.id === state.selection.clipId);
    return clip ? { type: "clip", story, episode, item: clip } : null;
  }
  const reference = findReferenceById(state.selection.referenceId);
  return reference ? { type: "reference", story, episode, item: reference } : null;
}

function renderInspector() {
  const selection = selectionData();
  dom.inspectorEmpty.classList.toggle("hidden", Boolean(selection));
  dom.inspectorContent.classList.toggle("hidden", !selection);
  if (!selection) return;

  const { type, item } = selection;
  if (type === "clip") {
    dom.inspectorEyebrow.textContent = `${selection.episode.title} · ${typeLabel(item.type)}`;
    dom.inspectorTitle.textContent = item.title;
    const status = clipStatus(item);
    dom.inspectorBadges.innerHTML = [
      `<span class="badge accent">${escapeHtml(formatDuration(item.duration))}</span>`,
      `<span class="badge">${item.reference_count} references</span>`,
      `<span class="badge">${item.images?.length || 0} images</span>`,
      status === "partial" ? `<span class="badge warning">${item.issues.length} issue${item.issues.length === 1 ? "" : "s"}</span>` : "",
    ].join("");
    const tabs = ["overview", "prompt", "references", "images"];
    renderInspectorTabs(tabs);
    renderClipInspectorBody(item, state.inspectorTab);
  } else {
    dom.inspectorEyebrow.textContent = `${item.scope} reference · ${item.kind}`;
    dom.inspectorTitle.textContent = item.name;
    dom.inspectorBadges.innerHTML = [
      `<span class="badge accent">${escapeHtml(item.kind)}</span>`,
      `<span class="badge ${item.ready ? "" : "warning"}">${item.ready ? "Image ready" : "Prompt only"}</span>`,
      `<span class="badge">${item.images?.length || 0} images</span>`,
    ].join("");
    const tabs = ["overview", "prompt", "images"];
    if (!tabs.includes(state.inspectorTab)) state.inspectorTab = "overview";
    renderInspectorTabs(tabs);
    renderReferenceInspectorBody(item, state.inspectorTab);
  }
}

function renderInspectorTabs(tabs) {
  dom.inspectorTabs.innerHTML = tabs.map((tab) => `
    <button class="inspector-tab ${state.inspectorTab === tab ? "active" : ""}" data-tab="${tab}">
      ${tab[0].toUpperCase() + tab.slice(1)}
    </button>`).join("");
}

function detailList(rows) {
  return `<div class="detail-list">${rows.map(([label, value, isCode = false]) => `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      ${isCode ? `<code title="${escapeHtml(value)}">${escapeHtml(value || "—")}</code>` : `<span title="${escapeHtml(value)}">${escapeHtml(value || "—")}</span>`}
    </div>`).join("")}</div>`;
}

function renderVideoPreview(clip) {
  const output = Object.entries(clip.output_states || {}).find(([name, candidate]) => (
    candidate.ready
    && candidate.asset
    && (name === "video" || [".mp4", ".mov", ".webm", ".mkv"].includes(candidate.asset.extension))
  ));
  if (!output) return "";
  const [, video] = output;
  return `
    <div class="detail-section generated-video-section">
      <div class="generated-video-heading">
        <h3>Video preview</h3>
        <span>Auto-playing muted · loops continuously</span>
      </div>
      <div class="generated-video-frame">
        <video class="generated-video-preview" src="${escapeHtml(video.asset.url)}" controls autoplay muted loop playsinline preload="metadata" aria-label="Generated video preview for ${escapeHtml(clip.title)}">
          Your browser cannot preview this video format. Open the generated video below instead.
        </video>
      </div>
    </div>`;
}

function renderClipInspectorBody(clip, tab) {
  if (tab === "prompt") {
    const primary = promptBlock(clip.prompt_path, clip.prompt_text, "Generation Prompt");
    const firstFrame = clip.first_frame_prompt_path
      ? `<div class="detail-section"><h3>First-frame image Prompt</h3>${promptBlock(clip.first_frame_prompt_path, clip.first_frame_prompt_text, "First-frame Prompt")}</div>`
      : "";
    dom.inspectorBody.innerHTML = `${primary}${firstFrame}`;
    return;
  }
  if (tab === "references") {
    dom.inspectorBody.innerHTML = renderReferenceDetails(clip.references || []);
    return;
  }
  if (tab === "images") {
    const directImages = clip.images || [];
    const referencedImages = (clip.references || []).map((reference) => reference.image).filter(Boolean);
    dom.inspectorBody.innerHTML = `
      <div class="detail-section">
        <h3>Clip-local images</h3>
        ${renderImageGallery(directImages, "No clip-local images have been generated or linked.")}
      </div>
      <div class="detail-section">
        <h3>Resolved reference images</h3>
        ${renderImageGallery(uniqueImages(referencedImages), "Reference image files are not available yet.")}
      </div>`;
    return;
  }

  const rows = [
    ["Node", clip.id.toUpperCase()],
    ["Generation mode", typeLabel(clip.type)],
    ["Duration", formatDuration(clip.duration)],
    [clip.structured_path ? "Structured clip" : "Prompt", clip.structured_path || clip.prompt_path || "Missing", true],
    ["Reference readiness", `${clip.ready_reference_count}/${clip.reference_count}`],
    ["Local images", String(clip.images?.length || 0)],
  ];
  const queueReadiness = clipQueueReadiness(clip);
  const issues = queueReadiness.dependencyOnly
    ? `<div class="detail-section"><h3>Dependency</h3><div class="issue-item dependency-info">Waiting for the last frame from ${escapeHtml(queueReadiness.dependencyClipIds.join(", "))}. This clip can be queued now; AITurboShow will automatically stage the prerequisite clip first.</div></div>`
    : clip.issues?.length
      ? `<div class="detail-section"><h3>Attention</h3><div class="issue-list">${clip.issues.map((issue) => `<div class="issue-item">${escapeHtml(issue)}</div>`).join("")}</div></div>`
    : `<div class="detail-section"><h3>Status</h3><div class="issue-item" style="color:var(--accent);border-color:rgba(113,225,195,.2);background:var(--accent-dim)">Prompt and declared assets are available for this node.</div></div>`;
  const outputs = Object.entries(clip.output_states || {}).filter(([, output]) => output.ready && output.asset);
  const outputSection = outputs.length
    ? `<div class="detail-section"><h3>Generated outputs</h3><div class="output-links">${outputs.map(([name, output]) => `
        <a class="output-link" href="${escapeHtml(output.asset.url)}" target="_blank" rel="noreferrer">
          <span>${escapeHtml(name.replaceAll("_", " "))}</span>
          <span title="${escapeHtml(output.path)}">${escapeHtml(output.path)}</span>
        </a>`).join("")}</div></div>`
    : "";
  dom.inspectorBody.innerHTML = `
    ${renderVideoPreview(clip)}
    ${renderGenerationPanel(clip)}
    ${renderClipContentPanel(clip)}
    <div class="detail-section"><h3>Node metadata</h3>${detailList(rows)}</div>
    ${issues}
    ${outputSection}
    <div class="detail-section"><h3>Source files</h3>${detailList((clip.files || []).map((path) => [path.split("/").pop(), path, true]))}</div>`;
}

function renderClipContentPanel(clip) {
  const episode = currentEpisode();
  const index = episode?.clips?.findIndex((candidate) => candidate.id === clip.id) ?? -1;
  const structured = Boolean(clip.structured_payload);
  return `
    <div class="detail-section">
      <h3>Clip editor</h3>
      <div class="content-actions">
        <button class="generation-button wide" type="button" data-content-action="edit-clip" ${structured ? "" : "disabled"}>Edit clip details</button>
        <button class="generation-button" type="button" data-content-action="move-earlier" ${structured && index > 0 ? "" : "disabled"}>Move earlier</button>
        <button class="generation-button" type="button" data-content-action="move-later" ${structured && index >= 0 && index < (episode?.clips?.length || 0) - 1 ? "" : "disabled"}>Move later</button>
        <button class="generation-button" type="button" data-content-action="move-start" ${structured && index > 0 ? "" : "disabled"}>Move to start</button>
        <button class="generation-button" type="button" data-content-action="move-end" ${structured && index >= 0 && index < (episode?.clips?.length || 0) - 1 ? "" : "disabled"}>Move to end</button>
      </div>
    </div>`;
}

function renderGenerationPanel(clip) {
  const backendReady = Boolean(state.comfy?.connected && state.comfy?.compatible);
  const supported = ["ref2va", "i2va"].includes(clip.type) && Boolean(clip.structured_path);
  const readiness = clipQueueReadiness(clip);
  const activeJob = generationJobFor(clip);
  const active = activeJob && activeGenerationStatuses.has(activeJob.status);
  const canQueue = backendReady && supported && readiness.queueable && !active;
  let label = "Not queued";
  let message = "Validate the structured clip, then queue it directly to the ComfyUI H3 backend.";
  let messageClass = "";
  if (!backendReady) {
    label = state.comfy?.connected ? "Backend incomplete" : "Backend offline";
    message = state.comfy?.error || (state.comfy?.missing_nodes?.length
      ? `Missing ComfyUI nodes: ${state.comfy.missing_nodes.join(", ")}`
      : state.comfy?.missing_models?.length
        ? `Missing H3 models: ${state.comfy.missing_models.join(", ")}`
        : "Start ComfyUI on the configured backend URL.");
    messageClass = "error";
  } else if (!supported) {
    label = "Unsupported clip";
    message = clip.type === "post"
      ? "This is a post-production clip and is not sent to H3."
      : "Direct generation currently supports structured I2VA and Ref2VA clips.";
  } else if (activeJob) {
    label = generationStatusLabel(activeJob.status);
    message = activeJob.error
      || (activeJob.status === "waiting" && activeJob.queue_position
        ? `Waiting at queue position ${activeJob.queue_position}${activeJob.batch_total ? ` · batch ${activeJob.batch_index}/${activeJob.batch_total}` : ""}`
        : `Prompt ${activeJob.prompt_id || "pending"} · seed ${activeJob.seed || "auto"} · ${activeJob.width || 864}×${activeJob.height || 480}`);
    if (activeJob.status === "error") messageClass = "error";
  } else if (readiness.dependencyOnly) {
    label = "Dependency will be queued";
    message = `The last frame from ${readiness.dependencyClipIds.join(", ")} is not ready. Queueing this clip will automatically add the prerequisite clip first.`;
  } else if (!readiness.queueable) {
    label = "Assets required";
    message = `${readiness.fixed.length} fixed reference image(s) missing. Generate or upload them before queueing.`;
    messageClass = "error";
  } else if (clip.complete) {
    label = "Outputs ready";
    message = "All declared artifacts exist. Queueing again will regenerate and replace them after completion.";
  }
  return `
    <div class="detail-section" data-live-panel="clip-generation">
      <h3>MiniMax H3 backend</h3>
      <div class="generation-card">
        <div class="generation-status"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(state.comfy?.url || "ComfyUI")}</span></div>
        <div class="generation-message ${messageClass}">${escapeHtml(message)}</div>
        <label class="generation-option">
          <span>Resolution</span>
          <select class="generation-select" data-h3-resolution ${active ? "disabled" : ""}>
            ${h3ResolutionOptions("864x480")}
          </select>
        </label>
        <div class="generation-actions">
          <button class="generation-button" type="button" data-comfy-action="validate" ${backendReady && supported ? "" : "disabled"}>Validate</button>
          <button class="generation-button primary" type="button" data-comfy-action="queue" ${canQueue ? "" : "disabled"}>${active ? "Queued" : clip.complete ? "Regenerate H3" : "Queue H3"}</button>
        </div>
      </div>
    </div>`;
}

function renderReferenceInspectorBody(reference, tab) {
  if (tab === "prompt") {
    dom.inspectorBody.innerHTML = promptBlock(reference.prompt_path, reference.prompt_text, "Reference image Prompt");
    return;
  }
  if (tab === "images") {
    dom.inspectorBody.innerHTML = renderImageGallery(reference.images || [], "The declared reference image is not available yet.");
    return;
  }
  dom.inspectorBody.innerHTML = `
    ${renderReferenceGenerationPanel(reference)}
    <div class="detail-section">
      <h3>Reference editor</h3>
      <div class="content-actions">
        <button class="generation-button wide" type="button" data-content-action="edit-reference">${reference.prompt_text ? "Edit reference prompt" : "Add reference prompt"}</button>
      </div>
    </div>
    <div class="detail-section"><h3>Reference metadata</h3>${detailList([
      ["Name", reference.name],
      ["Type", reference.kind],
      ["Scope", reference.scope],
      ["Library source", reference.auto_discovered ? "Discovered in clip inputs" : "Reference library"],
      ["Image destination", reference.generation_path || "Missing", true],
      ["Prompt", reference.prompt_path || "Missing", true],
      ...(reference.prompt_origin ? [["Prompt source", reference.prompt_origin]] : []),
      ["Generated images", String(reference.images?.length || 0)],
      ["Readiness", reference.ready ? "Ready" : reference.prompt_text ? "Prompt only" : "Missing image and prompt"],
    ])}</div>
    ${reference.used_by?.length ? `<div class="detail-section"><h3>Used by clips</h3><div class="content-actions">${reference.used_by.map((use) => `<button class="text-button" type="button" data-reference-clip="${escapeHtml(use.clip_id)}" title="${escapeHtml(use.title)}">${escapeHtml(use.clip_id)}${Number.isInteger(use.picture) ? ` · Picture ${use.picture}` : ""}</button>`).join("")}</div></div>` : ""}
    <div class="detail-section"><h3>Preview</h3>${renderImageGallery(reference.images?.slice(0, 1) || [], "Generate the reference image to make it available to clip nodes.")}</div>`;
}

function defaultReferenceSize(reference) {
  if (reference.kind === "character") return "768x1024";
  if (reference.kind === "environment" || reference.scope === "episode") return "1344x768";
  return "1024x1024";
}

function renderReferenceGenerationPanel(reference) {
  const capability = state.comfy?.capabilities?.z_image_turbo;
  const backendReady = Boolean(state.comfy?.connected && capability?.compatible);
  const activeJob = referenceGenerationJobFor(reference);
  const active = activeJob && activeGenerationStatuses.has(activeJob.status);
  const pngDestination = /\.png$/i.test(reference.generation_path || "");
  const canQueue = backendReady && Boolean(reference.prompt_text && pngDestination) && !active;
  let label = reference.ready ? "Image ready" : "Not generated";
  let message = `Generate this reference directly with Z-Image Turbo and save it to ${reference.generation_path || "its declared destination"}.`;
  let messageClass = "";
  if (!state.comfy?.connected) {
    label = "Backend offline";
    message = state.comfy?.error || "Start ComfyUI on the configured backend URL.";
    messageClass = "error";
  } else if (!capability?.compatible) {
    label = "Z-Image setup required";
    const missing = [...(capability?.missing_nodes || []), ...(capability?.missing_models || [])];
    message = missing.length ? `Missing: ${missing.join(", ")}` : "Z-Image Turbo is not available in this ComfyUI backend.";
    messageClass = "error";
  } else if (!reference.prompt_text || !reference.generation_path) {
    label = "Prompt unavailable";
    message = "This reference needs both a prompt and a generated-image destination.";
    messageClass = "error";
  } else if (!pngDestination) {
    label = "Imported image";
    message = "This image can be reused in clips. Direct generation requires a PNG destination; upload a replacement to keep its existing format.";
  } else if (activeJob) {
    label = generationStatusLabel(activeJob.status);
    message = activeJob.error
      || `Prompt ${activeJob.prompt_id || "pending"} · seed ${activeJob.seed || "auto"} · ${activeJob.width || 1024}×${activeJob.height || 1024}`;
    if (activeJob.status === "error") messageClass = "error";
  }
  const selectedSize = defaultReferenceSize(reference);
  return `
    <div class="detail-section" data-live-panel="reference-generation">
      <h3>Z-Image Turbo backend</h3>
      <div class="generation-card">
        <div class="generation-status"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(state.comfy?.url || "ComfyUI")}</span></div>
        <div class="generation-message ${messageClass}">${escapeHtml(message)}</div>
        <label class="generation-option">
          <span>Output size</span>
          <select class="generation-select" data-z-image-size>
            ${[
              ["1024x1024", "Square · 1024×1024"],
              ["1344x768", "Landscape · 1344×768"],
              ["768x1024", "Portrait · 768×1024"],
              ["1824x1024", "Wide · 1824×1024"],
            ].map(([value, text]) => `<option value="${value}" ${value === selectedSize ? "selected" : ""}>${text}</option>`).join("")}
          </select>
        </label>
        <div class="generation-actions">
          <button class="generation-button" type="button" data-image-action="validate" ${backendReady ? "" : "disabled"}>Validate</button>
          <button class="generation-button primary" type="button" data-image-action="queue" ${canQueue ? "" : "disabled"}>${active ? "Queued" : reference.ready ? "Regenerate image" : "Generate image"}</button>
        </div>
      </div>
    </div>`;
}

function promptBlock(path, text, label) {
  if (!text) return `<div class="no-content">No ${escapeHtml(label.toLowerCase())} is available.</div>`;
  return `
    <div class="prompt-toolbar">
      <span class="file-path" title="${escapeHtml(path)}">${escapeHtml(path || label)}</span>
      <button class="copy-button" type="button" data-copy="${escapeHtml(text)}">Copy</button>
    </div>
    <pre class="prompt-code">${escapeHtml(text)}</pre>`;
}

function renderReferenceDetails(references) {
  if (!references.length) return `<div class="no-content">This node does not declare reference inputs in its structured clip file.</div>`;
  return `<div class="reference-detail-list">${references.map((reference) => {
    const image = reference.image;
    const upload = uploadPresentation(reference);
    const hasPictureSocket = Number.isInteger(reference.picture);
    const slotLabel = hasPictureSocket ? `&lt;Picture ${escapeHtml(reference.picture)}&gt;` : "Post-production source";
    const preview = image
      ? `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(reference.label)}" data-image-preview data-image-url="${escapeHtml(image.url)}" data-image-name="${escapeHtml(reference.label)}">`
      : `<div class="reference-placeholder">${hasPictureSocket ? escapeHtml(String(reference.picture).padStart(2, "0")) : "SRC"}</div>`;
    const dependency = reference.dependency
      ? `<div class="reference-path" title="${escapeHtml(reference.dependency.output_path || reference.dependency.artifact_id)}">Dependency: ${escapeHtml(reference.dependency.clip_id)} → ${escapeHtml(reference.dependency.artifact)}</div>`
      : "";
    return `
      <div class="reference-detail-card ${upload.className}" ${upload.attributes} ${reference.source_id ? `data-source-reference="${escapeHtml(reference.source_id)}" role="button" tabindex="0"` : ""}>
        <div class="reference-detail-image">${preview}${upload.hint}</div>
        <div class="reference-detail-body">
          <div class="picture-label">${slotLabel}</div>
          <div class="reference-detail-title">${escapeHtml(reference.label)}</div>
          <div class="reference-detail-meta">
            <span class="mini-chip">${escapeHtml(reference.role)}</span>
            <span class="mini-chip">${escapeHtml(reference.source_type || reference.kind || "reference")}</span>
            <span class="mini-chip ${reference.ready ? "ready" : "missing"}">${reference.ready ? "Image ready" : "Missing image"}</span>
          </div>
          ${dependency}
          <div class="reference-path" title="${escapeHtml(image?.path || reference.expected)}">${escapeHtml(image?.path || reference.expected || "Unresolved")}</div>
        </div>
      </div>`;
  }).join("")}</div>`;
}

function uniqueImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    if (!image?.path || seen.has(image.path)) return false;
    seen.add(image.path);
    return true;
  });
}

function renderImageGallery(images, emptyMessage) {
  if (!images?.length) return `<div class="no-content">${escapeHtml(emptyMessage)}</div>`;
  return `<div class="image-gallery">${images.map((image) => `
    <a class="image-card" href="${escapeHtml(image.url)}" data-image-preview data-image-url="${escapeHtml(image.url)}" data-image-name="${escapeHtml(image.name)}">
      <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}" loading="lazy">
      <div class="image-card-footer">
        <div class="image-name">${escapeHtml(image.name)}</div>
        <div class="image-path" title="${escapeHtml(image.path)}">${escapeHtml(image.path)}</div>
      </div>
    </a>`).join("")}</div>`;
}

dom.refreshButton.addEventListener("click", () => loadCatalog());
dom.newStoryButton.addEventListener("click", openNewStoryEditor);
dom.agentButton.addEventListener("click", openAgentSettings);
dom.editStoryButton.addEventListener("click", openEditStoryEditor);
dom.newEpisodeButton.addEventListener("click", openNewEpisodeEditor);
dom.editEpisodeButton.addEventListener("click", openEditEpisodeEditor);
dom.newClipButton.addEventListener("click", openNewClipEditor);
dom.aiClipsButton.addEventListener("click", openAutomaticClipsEditor);
dom.rewritePromptsButton.addEventListener("click", openBatchPromptRegenerationEditor);
dom.regenerateChainButton.addEventListener("click", openRegenerateVideoChainEditor);
dom.queueEpisodeButton.addEventListener("click", openEpisodeQueueEditor);
dom.batchReferenceButton.addEventListener("click", openBatchReferenceEditor);
dom.newReferenceButton.addEventListener("click", openNewReferenceEditor);
dom.taskQueueButton.addEventListener("click", () => {
  state.taskQueueOpen = !state.taskQueueOpen;
  renderTaskQueue();
});
dom.closeTaskQueue.addEventListener("click", () => {
  state.taskQueueOpen = false;
  renderTaskQueue();
});
document.addEventListener("click", (event) => {
  if (!state.taskQueueOpen || event.target.closest("#taskQueuePanel, #taskQueueButton")) return;
  state.taskQueueOpen = false;
  renderTaskQueue();
});
dom.taskQueueList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cancel-job]");
  if (!button) return;
  button.disabled = true;
  try {
    await postJson("/api/comfy/jobs/cancel", { job_id: button.dataset.cancelJob });
    await refreshComfyState();
  } catch (error) {
    showToast(error.message || String(error));
    button.disabled = false;
  }
});
dom.fitGraphButton.addEventListener("click", () => dom.clipViewport.scrollTo({ left: 0, behavior: "smooth" }));
dom.closeInspector.addEventListener("click", () => {
  state.selection = null;
  renderAll();
});

dom.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderTree();
  const story = currentStory();
  if (story) {
    renderStoryReferences(story.references || []);
    renderEpisodeReferences(currentEpisode()?.references || []);
    renderClipFlow(currentEpisode()?.clips || []);
  }
});

dom.storyTree.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-tree-toggle]");
  if (toggle) {
    event.preventDefault();
    event.stopPropagation();
    if (toggle.dataset.treeToggle === "story") {
      const storyId = toggle.dataset.story;
      if (state.collapsedStories.has(storyId)) state.collapsedStories.delete(storyId);
      else state.collapsedStories.add(storyId);
    } else {
      const episodeKey = `${toggle.dataset.story}:${toggle.dataset.episode}`;
      if (state.collapsedEpisodes.has(episodeKey)) state.collapsedEpisodes.delete(episodeKey);
      else state.collapsedEpisodes.add(episodeKey);
    }
    renderTree();
    saveNavigation();
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "select-story") {
    openProduction(target.dataset.story);
  } else if (action === "select-episode") {
    openProduction(target.dataset.story, target.dataset.episode);
  } else if (action === "select-clip") {
    selectClip(target.dataset.story, target.dataset.episode, target.dataset.clip);
  } else if (action === "scroll-references") {
    openProduction(target.dataset.story, target.dataset.episode);
    requestAnimationFrame(() => document.querySelector(target.dataset.episode ? ".episode-reference-library" : ".reference-section")?.scrollIntoView({ behavior: "smooth" }));
  }
});

dom.storyTree.addEventListener("keydown", (event) => {
  const row = event.target.closest("button");
  if (row && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    const buttons = [...dom.storyTree.querySelectorAll("button")].filter((button) => button.getClientRects().length);
    const index = buttons.indexOf(row);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault(); buttons[next]?.focus(); return;
  }
  const toggle = event.target.closest("[data-tree-toggle]");
  if (!toggle || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  toggle.click();
});

document.querySelector("#collapseProductions").addEventListener("click", () => {
  state.query = ""; dom.searchInput.value = "";
  state.collapsedStories = new Set((state.catalog?.stories || []).map((story) => story.id));
  state.collapsedEpisodes = new Set((state.catalog?.stories || []).flatMap((story) => story.episodes.map((episode) => `${story.id}:${episode.id}`)));
  renderAll();
});
document.querySelector("#revealProduction").addEventListener("click", () => {
  state.query = ""; dom.searchInput.value = ""; revealCurrentLocation(); renderAll();
  const selected = dom.storyTree.querySelector('[data-action="select-clip"].active') || dom.storyTree.querySelector('[data-action="select-episode"].active') || dom.storyTree.querySelector('[data-action="select-story"].active');
  selected?.scrollIntoView({ block: "nearest" }); selected?.focus({ preventScroll: true });
});

dom.storyReferences.addEventListener("click", (event) => {
  const target = event.target.closest("[data-reference]");
  if (target) selectReference(target.dataset.reference);
});

dom.episodeReferences.addEventListener("click", (event) => {
  const target = event.target.closest("[data-reference]");
  if (target) selectReference(target.dataset.reference);
});

dom.episodeTabs.addEventListener("click", (event) => {
  const target = event.target.closest("[data-episode]");
  if (!target) return;
  openProduction(state.storyId, target.dataset.episode);
});

dom.episodePreview.addEventListener("click", (event) => {
  const action = event.target.closest("[data-episode-preview-action]")?.dataset.episodePreviewAction;
  const playlist = state.episodePlaylist;
  if (!action || !playlist) return;
  playlist.index = action === "previous"
    ? (playlist.index - 1 + playlist.clips.length) % playlist.clips.length
    : (playlist.index + 1) % playlist.clips.length;
  setEpisodePreviewSource();
});

dom.clipFlow.addEventListener("click", (event) => {
  const target = event.target.closest("[data-clip]");
  if (!target) return;
  selectClip(state.storyId, state.episodeId, target.dataset.clip);
});

dom.inspectorTabs.addEventListener("click", (event) => {
  const target = event.target.closest("[data-tab]");
  if (!target) return;
  state.inspectorTab = target.dataset.tab;
  renderInspector();
  saveNavigation();
});

dom.inspectorBody.addEventListener("click", async (event) => {
  const referenceClip = event.target.closest("[data-reference-clip]");
  if (referenceClip) {
    selectClip(state.storyId, state.episodeId, referenceClip.dataset.referenceClip);
    return;
  }
  const contentAction = event.target.closest("[data-content-action]");
  if (contentAction) {
    const selection = selectionData();
    if (!selection) return;
    const action = contentAction.dataset.contentAction;
    if (action === "edit-clip" && selection.type === "clip") {
      openEditClipEditor(selection.item);
      return;
    }
    if (action === "edit-reference" && selection.type === "reference") {
      openEditReferenceEditor(selection.item);
      return;
    }
    if (action.startsWith("move-") && selection.type === "clip") {
      contentAction.disabled = true;
      try {
        await moveSelectedClip(selection.item, action.replace("move-", ""));
      } catch (error) {
        console.error(error);
        showToast(error.message || String(error));
      } finally {
        contentAction.disabled = false;
      }
      return;
    }
  }
  const imageAction = event.target.closest("[data-image-action]");
  if (imageAction) {
    const selection = selectionData();
    if (selection?.type !== "reference") return;
    const payload = {
      story_id: selection.story.id,
      episode_id: selection.episode?.id || null,
      reference_id: selection.item.id,
    };
    imageAction.disabled = true;
    try {
      if (imageAction.dataset.imageAction === "validate") {
        const result = await postJson("/api/comfy/image/validate", payload);
        showToast(`${selection.item.name} is ready for Z-Image Turbo at ${result.reference.default_size.width}×${result.reference.default_size.height}.`);
      } else {
        const force = Boolean(selection.item.ready);
        if (force && !window.confirm("A generated image already exists for this reference. Replace it after Z-Image Turbo completes?")) return;
        const size = dom.inspectorBody.querySelector("[data-z-image-size]")?.value || defaultReferenceSize(selection.item);
        const [width, height] = size.split("x").map(Number);
        const result = await postJson("/api/comfy/image/generate", {
          ...payload,
          force,
          options: { width, height },
        });
        showToast(result.duplicate ? `${selection.item.name} is already queued.` : `${selection.item.name} queued in Z-Image Turbo.`);
      }
      await refreshComfyState();
    } catch (error) {
      console.error(error);
      showToast(error.message || String(error));
      await refreshComfyState();
    } finally {
      imageAction.disabled = false;
    }
    return;
  }
  const comfyAction = event.target.closest("[data-comfy-action]");
  if (comfyAction) {
    const selection = selectionData();
    if (selection?.type !== "clip") return;
    const payload = {
      story_id: selection.story.id,
      episode_id: selection.episode.id,
      clip_id: selection.item.id,
    };
    comfyAction.disabled = true;
    try {
      if (comfyAction.dataset.comfyAction === "validate") {
        const result = await postJson("/api/comfy/validate", payload);
        const missing = result.clip?.missing_references?.length || 0;
        showToast(missing ? `Validation found ${missing} missing reference(s).` : `${selection.item.id} is valid and ready.`);
      } else {
        const force = Boolean(selection.item.complete);
        if (force && !window.confirm("All declared outputs already exist. Regenerate this clip and replace them after ComfyUI completes?")) return;
        const size = dom.inspectorBody.querySelector("[data-h3-resolution]")?.value || "864x480";
        const [width, height] = size.split("x").map(Number);
        const result = await postJson("/api/comfy/generate", { ...payload, force, options: { width, height } });
        const dependencyCount = Number(result.automatic_dependency_count || 0);
        const dependencyMessage = dependencyCount
          ? ` ${dependencyCount} prerequisite clip${dependencyCount === 1 ? " was" : "s were"} added first.`
          : "";
        showToast(result.duplicate ? `${selection.item.id} is already queued.` : `${selection.item.id} added to the H3 queue.${dependencyMessage}`);
      }
      await refreshComfyState();
    } catch (error) {
      console.error(error);
      showToast(error.message || String(error));
      await refreshComfyState();
    } finally {
      comfyAction.disabled = false;
    }
    return;
  }
  const copyTarget = event.target.closest("[data-copy]");
  if (copyTarget) {
    try {
      await navigator.clipboard.writeText(copyTarget.dataset.copy);
      showToast("Prompt copied to clipboard");
    } catch {
      showToast("Clipboard access is unavailable");
    }
    return;
  }
  const sourceReference = event.target.closest("[data-source-reference]");
  if (sourceReference) selectReference(sourceReference.dataset.sourceReference);
});

dom.inspectorBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const sourceReference = event.target.closest("[data-source-reference]");
  if (sourceReference) {
    event.preventDefault();
    selectReference(sourceReference.dataset.sourceReference);
  }
});

document.addEventListener("dragenter", (event) => {
  const target = event.target.closest?.(".image-drop-target[data-upload-path]");
  if (!target) return;
  event.preventDefault();
  target.classList.add("drag-over");
});

document.addEventListener("dragover", (event) => {
  const target = event.target.closest?.(".image-drop-target[data-upload-path]");
  if (!target) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  target.classList.add("drag-over");
});

document.addEventListener("dragleave", (event) => {
  const target = event.target.closest?.(".image-drop-target[data-upload-path]");
  if (!target || target.contains(event.relatedTarget)) return;
  target.classList.remove("drag-over");
});

document.addEventListener("drop", (event) => {
  const target = event.target.closest?.(".image-drop-target[data-upload-path]");
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  target.classList.remove("drag-over");
  const file = [...(event.dataTransfer?.files || [])].find((candidate) => candidate.type.startsWith("image/"));
  if (!file) {
    showToast("Drop a PNG, JPEG, WebP, or another browser-readable image.");
    return;
  }
  uploadDroppedImage(target, file);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dom.imageLightbox && !dom.imageLightbox.classList.contains("hidden")) {
    closeImagePreview();
    return;
  }
  if (event.key.toLowerCase() === "r" && !event.ctrlKey && !event.metaKey && !/input|textarea/i.test(document.activeElement?.tagName || "")) {
    loadCatalog();
  }
  if (event.key === "Escape" && !dom.editorModal.classList.contains("hidden")) {
    closeEditor();
    return;
  }
  if (event.key === "Escape" && state.selection) {
    state.selection = null;
    renderAll();
  }
});

dom.editorModal.addEventListener("click", (event) => {
  if (event.target.closest("[data-editor-close]")) closeEditor();
});

document.addEventListener("click", (event) => {
  const close = event.target.closest("[data-image-close]");
  if (close) {
    closeImagePreview();
    return;
  }
  const preview = event.target.closest("[data-image-preview]");
  if (!preview) return;
  event.preventDefault();
  event.stopPropagation();
  openImagePreview({ url: preview.dataset.imageUrl || preview.getAttribute("href"), name: preview.dataset.imageName }, preview.dataset.imageName || "Reference image");
});

dom.editorBody.addEventListener("click", async (event) => {
  const draftButton = event.target.closest("[data-agent-action]");
  const testButton = event.target.closest("[data-agent-test]");
  const undoButton = event.target.closest("[data-agent-undo]");
  const queueSelectButton = event.target.closest("[data-queue-select]");
  const referenceSelectButton = event.target.closest("[data-reference-select]");
  if (referenceSelectButton) {
    event.preventDefault();
    const mode = referenceSelectButton.dataset.referenceSelect;
    const boxes = [...dom.editorBody.querySelectorAll('input[name="batch_reference"]:not(:disabled)')];
    boxes.forEach((box) => { box.checked = mode === "all" || (mode === "unfinished" && box.closest(".batch-clip-row")?.querySelector(".batch-clip-state")?.textContent === "Needs image"); });
    return;
  }
  if (undoButton) {
    event.preventDefault();
    const targetName = undoButton.dataset.agentUndo;
    const target = dom.editorForm.elements.namedItem(targetName);
    if (target && state.agentDraftBackups.has(targetName)) {
      target.value = state.agentDraftBackups.get(targetName);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      state.agentDraftBackups.delete(targetName);
      const feedback = undoButton.closest(".agent-assist")?.querySelector("[data-agent-feedback]");
      setAgentFeedback(feedback, "Restored the text that was in the editor before the DeepSeek draft. Nothing was saved.", "success");
      showToast("Original editor text restored. Nothing was saved.");
    }
    return;
  }
  if (queueSelectButton) {
    event.preventDefault();
    const mode = queueSelectButton.dataset.queueSelect;
    for (const input of dom.editorBody.querySelectorAll('input[name="queue_clip"]:not(:disabled)')) {
      const clip = currentEpisode()?.clips?.find((candidate) => candidate.id === input.value);
      input.checked = mode === "all" || (mode === "unfinished" && clip && !clip.complete && clipQueueReadiness(clip).queueable);
      if (mode === "none") input.checked = false;
    }
    return;
  }
  if (!draftButton && !testButton) return;
  event.preventDefault();
  const settingsFeedback = testButton?.closest("[data-agent-settings-form]")?.querySelector("[data-agent-settings-feedback]");
  try {
    if (draftButton) {
      await generateAgentDraft(draftButton);
      return;
    }
    testButton.disabled = true;
    const previousLabel = testButton.textContent;
    testButton.textContent = "Testing…";
    setAgentFeedback(settingsFeedback, "Saving the configuration and contacting DeepSeek…", "pending");
    try {
      await saveAgentSettingsFromEditor();
      const result = await postJson("/api/agent/test", {});
      setAgentFeedback(settingsFeedback, `${result.message} · ${result.model}`, "success");
      showToast(`${result.message} · ${result.model}`);
    } finally {
      testButton.disabled = false;
      testButton.textContent = previousLabel;
    }
  } catch (error) {
    console.error(error);
    setAgentFeedback(settingsFeedback, error.message || String(error), "error");
    showToast(error.message || String(error));
  }
});

dom.editorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.editorSubmit) return;
  dom.editorSubmitButton.disabled = true;
  const previousLabel = dom.editorSubmitButton.textContent;
  dom.editorSubmitButton.textContent = previousLabel.toLowerCase().includes("queue")
    ? "Queueing…"
    : previousLabel.includes("Generate")
      ? "Generating…"
      : "Saving…";
  try {
    await state.editorSubmit();
    closeEditor();
  } catch (error) {
    console.error(error);
    showToast(error.message || String(error));
  } finally {
    dom.editorSubmitButton.disabled = false;
    dom.editorSubmitButton.textContent = previousLabel;
  }
});

restoreNavigation();
for (const element of [dom.storyTree, document.querySelector(".workspace"), dom.clipViewport, dom.inspectorBody]) {
  element.addEventListener("scroll", () => { capturePosition(); clearTimeout(saveNavigation.timer); saveNavigation.timer = setTimeout(saveNavigation, 150); }, { passive: true });
}
window.addEventListener("pagehide", () => { capturePosition(); saveNavigation(); });
loadCatalog().then(() => Promise.all([refreshComfyState(), refreshAgentConfig()]).then(() => {
  if (new URLSearchParams(location.search).get("agent") === "settings") openAgentSettings();
}));
setInterval(() => refreshComfyState(), 10000);
