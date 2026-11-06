#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const IGNORED = new Set(["dist", "node_modules", "drizzle"]);
const FORBIDDEN = [".js", ".jsx", ".mjs", ".cjs"];

function sourceDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ["apps", "packages"]) {
    let workspaces: string[];
    try {
      workspaces = readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const workspace of workspaces) {
      const src = join(root, group, workspace, "src");
      try {
        if (statSync(src).isDirectory()) dirs.push(src);
      } catch {
        // workspace has no src/ — nothing to check
      }
    }
  }
  return dirs;
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED.has(entry.name)) walk(join(dir, entry.name), files);
    } else if (entry.isFile()) {
      files.push(join(dir, entry.name));
    }
  }
}

const files: string[] = [];
for (const dir of sourceDirs()) walk(dir, files);

const offenders = files
  .filter((file) => FORBIDDEN.some((ext) => file.endsWith(ext)))
  .sort()
  .map((file) => file.slice(root.length + 1));

if (offenders.length > 0) {
  console.error(`Found ${offenders.length} non-TypeScript source file(s):`);
  for (const file of offenders) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`TypeScript-only check passed: ${files.length} files`);
