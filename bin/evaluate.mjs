import { judge } from "../src/referee.mjs";
import { activePolicy } from "../src/policy.mjs";
import { performance } from "node:perf_hooks";
const policy = activePolicy();
const cases = [
  ["small-long", .001, "LONG", 25000, 0, 79000], ["ordinary-long",.01,"LONG",25000,0,79000],
  ["large-long",1,"LONG",25000,0,79000], ["leveraged-add",.5,"LONG",25000,.5,79000],
  ["small-short",.001,"SHORT",25000,0,81000], ["large-short",1,"SHORT",25000,0,81000],
  ["close-long",.05,"SHORT",25000,.05,79000], ["flip-long",.06,"SHORT",25000,.05,81000],
  ["zero-equity",.01,"LONG",0,0,79000], ["negative-quantity",-.01,"LONG",25000,0,79000],
  ["zero-quantity",0,"LONG",25000,0,79000], ["no-invalidation",.01,"LONG",25000,0,null],
  ["tight-budget",.05,"LONG",1000,0,70000], ["concentrated-book",.01,"LONG",25000,1,79000],
  ["nan-quantity",NaN,"LONG",25000,0,79000], ["ordinary-small-book",.001,"LONG",1000,0,79000]
];
const results=cases.map(([id,qty,side,walletBalance,held,invalidation])=>{
  const start=performance.now();
  const verdict=judge({book:{walletBalance,positions:held?[{symbol:"BTCUSDT",qty:held,entryPrice:80000}]:[]},marks:{BTCUSDT:80000},candidate:{symbol:"BTCUSDT",qty,side,entryPrice:80000},thesis:{confidence:.9,invalidation,flowToxicity:.1},policy});
  return {id,verdict:verdict.verdict,rules:verdict.checks.filter(c=>!c.passed).map(c=>c.rule),latencyMs:Math.round((performance.now()-start)*1000)/1000};
});
console.log(JSON.stringify({environment:"SIMULATION",generatedAt:new Date().toISOString(),policy:policy.constitution_sha256,results,
  counts:Object.fromEntries(["APPROVE","RESIZE","DENY"].map(v=>[v,results.filter(r=>r.verdict===v).length])),
  submissions:0,purchases:0,externalCost:0,
  comparison:{deterministic:"MEASURED",singleAnalyst:"BLOCKED_NO_LIVE_MODEL_RESULTS",bullBear:"BLOCKED_NO_EXTERNAL_BEAR",full:"BLOCKED_NO_VERIFIED_INTEGRATIONS"},
  falseRejections:null,policyViolationsAtSubmission:null,
  limitations:"Synthetic behavior check; no independent ground-truth labels, source/model comparison, or profitability inference. Zero submissions does not measure a successful execution pipeline."},null,2));
