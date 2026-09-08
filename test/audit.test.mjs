import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverOpportunities } from '../src/opportunities.mjs';
import { handleApexMcp } from '../src/apex-mcp.mjs';
const market={symbol:'BTCUSDT',markPrice:100,indexPrice:100,bestBid:99.99,bestAsk:100.01,realizedVolatility:0.3,flowToxicity:0.1,fundingRate:0.001,fundingIntervalHours:8,sma24:100,sma168:98};
test('carry uses the instrument funding interval',()=>{
 const eight=discoverOpportunities([market]).find(o=>o.category==='FUNDING_CARRY');
 const four=discoverOpportunities([{...market,fundingIntervalHours:4}]).find(o=>o.category==='FUNDING_CARRY');
 assert.equal(four.gross_annualized_pct,eight.gross_annualized_pct*2);
});
test('missing funding schedule or moving averages cannot create routes',()=>{
 assert.equal(discoverOpportunities([{...market,fundingIntervalHours:null,sma168:null}]).length,0);
 assert.equal(discoverOpportunities([{...market,flowToxicity:null}]).length,0);
});
test('MCP negotiates a supported client protocol',async()=>{
 const r=await handleApexMcp({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}});
 assert.equal(r.result.protocolVersion,'2025-03-26');
});
