import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isFile, relativePath, safeRepositoryPath } from "./fs-utils.mjs";
import { maximumJsonBytes, uploadImageExtensions } from "./constants.mjs";
import { agentConfigPath, runtime } from "./state.mjs";

export function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function collectUploadTargets(catalog) {
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

export function readRequestBody(request, maximumBytes, label = "Request body") {
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

export async function readJsonRequest(request) {
  const content = await readRequestBody(request, maximumJsonBytes, "JSON request");
  if (!content.length) return {};
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

export const mimeTypes = new Map([
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

export function sendJson(response, payload, status = 200) {
  const content = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  response.end(content);
}

export function sendFile(request, response, path, cacheControl = "private, max-age=30") {
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

export function extractApiToken(request, url) {
  const header = String(request.headers.authorization || "");
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  const query = url.searchParams.get("token");
  if (query) return query;
  return "";
}

export function apiTokenAuthorized(request, url) {
  if (!runtime.apiToken) return true;
  const remote = request.socket?.remoteAddress || "";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLoopback) return true;
  const provided = extractApiToken(request, url);
  if (!provided) return false;
  const expected = Buffer.from(runtime.apiToken);
  const candidate = Buffer.from(provided);
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}
