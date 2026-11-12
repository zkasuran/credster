// Small JSON-lines and JSON state files under ~/.credster (never in the repo).
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const HOME = process.env.CREDSTER_HOME || join(homedir(), ".credster");

export function path(...p) {
  const f = join(HOME, ...p);
  mkdirSync(dirname(f), { recursive: true });
  return f;
}

export function appendLine(file, obj) {
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

export function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function readJson(file, dflt = null) {
  if (!existsSync(file)) return dflt;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJson(file, obj) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
