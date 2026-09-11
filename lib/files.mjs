import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isFile } from "./fs-utils.mjs";
import { httpError } from "./http.mjs";

export function detectImageMime(buffer) {
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

export function expectedImageMime(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return null;
}

export function safeUnlink(path) {
  try {
    if (isFile(path)) unlinkSync(path);
  } catch {
    // Cleanup failure must not discard a successfully promoted image.
  }
}

export function writeImageAtomically(path, content, overwrite) {
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

export function writeTextAtomically(path, text) {
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

export function writeJsonAtomically(path, payload) {
  writeTextAtomically(path, `${JSON.stringify(payload, null, 2)}\n`);
}
