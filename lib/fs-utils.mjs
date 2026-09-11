import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { env } from "./state.mjs";

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function entries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function walk(directory) {
  const output = [];
  for (const entry of entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export function relativePath(path) {
  return relative(env.repositoryRoot, resolve(path)).split(sep).join("/");
}

export function safeRepositoryPath(value) {
  const cleaned = decodeURIComponent(String(value || "")).replaceAll("\\", "/").replace(/^\/+/, "");
  const candidate = resolve(env.repositoryRoot, cleaned);
  const rel = relative(env.repositoryRoot, candidate);
  if (rel.startsWith("..") || resolve(candidate) === resolve(env.repositoryRoot, "..")) {
    throw new Error("Requested path is outside the repository.");
  }
  return candidate;
}

export function readText(path) {
  if (!path || !isFile(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function readJson(path) {
  if (!path || !isFile(path)) return null;
  try {
    return JSON.parse(readText(path));
  } catch {
    return null;
  }
}
