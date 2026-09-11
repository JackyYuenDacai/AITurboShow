

export const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);

export const uploadImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv"]);

export const maximumUploadBytes = 50 * 1024 * 1024;

export const maximumJsonBytes = 1024 * 1024;

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const episodePattern = /^episode[-_ ]?(\d+)$/i;

export const clipFilePattern = /^clip[-_ ]?(\d+)(?:[-_ ].*)?$/i;

export const scenePromptPattern = /^scene(\d+)\.prompt$/i;

export const comfyRequiredNodes = [
  "MiniMaxH3ReferenceToVideo",
  "VAEDecodeAudio",
  "CreateVideo",
  "SaveVideo",
  "H3SaveLastFrame",
];

export const comfyRequiredModels = [
  ["VAELoader", "vae_name", "minimax_h3_video_vae_fp16.safetensors"],
  ["VAELoader", "vae_name", "minimax_h3_audio_vae_fp32.safetensors"],
  ["UNETLoader", "unet_name", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"],
  ["CLIPLoader", "clip_name", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
];

export const zImageRequiredNodes = [
  "CLIPTextEncode",
  "ConditioningZeroOut",
  "EmptySD3LatentImage",
  "ModelSamplingAuraFlow",
  "KSampler",
  "VAEDecode",
  "SaveImage",
];

export const zImageRequiredModels = [
  ["VAELoader", "vae_name", "ae.safetensors"],
  ["UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"],
  ["CLIPLoader", "clip_name", "qwen_3_4b.safetensors"],
];

export const defaultDeepSeekBaseUrl = "https://api.deepseek.com";

export const defaultDeepSeekModel = "deepseek-chat";

export const h3FirstFrameContinuityInstruction = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";

export const agentActions = new Set([
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
