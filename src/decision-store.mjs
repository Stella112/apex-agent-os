import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "./constitution.mjs";

// One process owns a data directory. Atomic replace; interrupted temporary files are ignored.
export class DecisionStore {
  constructor(directory) { this.directory = directory; mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  path(id) { if (!/^[a-zA-Z0-9_-]{1,90}$/.test(id)) throw new Error("Invalid record ID"); return join(this.directory, `${id}.json`); }
  save(record) {
    const path = this.path(record.id), temporary = `${path}.${randomUUID()}.tmp`;
    const text = canonicalJson(record);
    const envelope = JSON.stringify({ format: "apex-record-v1", digest: sha256(text), record });
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, envelope); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    return record;
  }
  get(id) {
    const envelope = JSON.parse(readFileSync(this.path(id), "utf8"));
    if (envelope.digest !== sha256(canonicalJson(envelope.record))) throw new Error("Record integrity failed");
    return envelope.record;
  }
  all() { return readdirSync(this.directory).filter(n => n.endsWith(".json")).map(n => this.get(n.slice(0,-5))); }
}
