import { DecisionStore } from "../src/decision-store.mjs";
import { verifyJournal } from "../src/journal.mjs";
import { canonicalJson, sha256 } from "../src/constitution.mjs";
import { join } from "node:path";
const store=new DecisionStore(process.env.APEX_DATA_DIR || join(process.cwd(),"data","decisions"));
const id=process.argv[2];
if (!id) { console.log(JSON.stringify(store.all().map(r=>({id:r.id,createdAt:r.createdAt,mode:r.mode,buildId:r.buildId})),null,2)); }
else {
  const record=store.get(id); const verification=verifyJournal(record.events);
  // Export intentionally excludes portfolio quantities, account identifiers and free-form provider text.
  const exported={id:record.id,buildId:record.buildId,mode:record.mode,policy:record.constitution,
    eventCheckpoints:record.events.map(e=>({event_id:e.event_id,event_type:e.event_type,event_hash:e.event_hash,previous_hash:e.previous_hash})),verification};
  console.log(JSON.stringify({manifest:{format:"apex-sanitized-v1",digest:sha256(canonicalJson(exported)),limitations:"Event payloads excluded; full journal verification requires local private record. Keep a trusted external head to detect truncation."},record:exported},null,2));
  if (!verification.valid) process.exitCode=1;
}
