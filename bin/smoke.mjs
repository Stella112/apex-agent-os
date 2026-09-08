// Local HTTP integration: launches and terminates only its own isolated server.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DecisionStore } from "../src/decision-store.mjs";
import { verifyJournal } from "../src/journal.mjs";
const directory=mkdtempSync(join(tmpdir(),"apex-smoke-"));
const child=spawn(process.execPath,["server.mjs"],{cwd:new URL("..",import.meta.url),env:{...process.env,PORT:"0",HOST:"127.0.0.1",APEX_DATA_DIR:directory,OLLAMA_ENABLED:"false",BEAR_API_KEY:"",BINANCE_MCP_ACCESS_TOKEN:""},stdio:["ignore","pipe","pipe"]});
try {
  const base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Server startup timeout")),10000);
    child.once("error",reject);
    child.stdout.on("data",chunk=>{ const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);} });
    child.stderr.on("data",chunk=>process.stderr.write(chunk));
  });
  const request=async(path,body)=>fetch(base+path,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const identity=await (await request("/api/identity")).json(); assert.match(identity.buildId,/^[a-f0-9]{16}$/);
  const init=await (await request("/mcp",{jsonrpc:"2.0",id:1,method:"initialize"})).json(); assert.equal(init.result.serverInfo.name,"apex-decision-layer");
  const tools=await (await request("/mcp",{jsonrpc:"2.0",id:2,method:"tools/list"})).json(); assert.equal(tools.result.tools.length,4);
  const invalid=await (await request("/mcp",{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"apex_find_opportunities",arguments:{symbols:"BTCUSDT"}}})).json(); assert.equal(invalid.error.code,-32602);
  const badOrigin=await fetch(base+"/mcp",{method:"POST",headers:{Origin:"invalid","Content-Type":"application/json"},body:'{}'}); assert.equal(badOrigin.status,403);
  assert.equal((await request("/api/cycle")).status,410);
  assert.equal((await request('/')).status,200);
  assert.equal((await request('/docs')).status,200);
  assert.equal((await request('/api/binance/connect')).status,410);
  assert.equal((await request('/apex/api/binance/connect')).status,410);
  const account=await (await request('/api/account')).json();
  assert.equal(account.balances,null);
  assert.equal((await request('/api/autopilot/stop',{})).status,405);
  assert.equal((await request("/api/confirm",{cycle_id:"fake"})).status,409);
  const input={mode:"live",book:{walletBalance:1000,positions:[]},proposal:{symbol:"BTCUSDT",side:"LONG",qty:.001},thesis:{invalidation:70000}};
  assert.equal((await request("/api/evaluate",{...input,mode:"replay"})).status,400);
  const response=await request("/api/evaluate",input); assert.equal(response.status,200);
  const result=await response.json(); assert.equal(result.halt,"MODEL_UNAVAILABLE");assert.equal(result.authorisable,null);
  const saved=new DecisionStore(directory).get(result.cycle_id);assert.equal(verifyJournal(saved.events).valid,true);
  assert.equal((await request("/api/confirm-extra",{})).status,405);
  const cross=await fetch(base+"/api/evaluate",{method:"POST",headers:{Origin:"https://foreign.example","Content-Type":"application/json"},body:JSON.stringify(input)});assert.equal(cross.status,403);
  console.log(JSON.stringify({status:"PASS",buildId:identity.buildId,checks:["backend identity","retired fixture endpoint","blocked confirmation","replay isolation","provider failure","durable decision read and hash verification","exact routing","cross-origin rejection"],externalCalls:0}));
} finally { child.kill(); await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once("exit",resolve);});rmSync(directory,{recursive:true,force:true}); }
