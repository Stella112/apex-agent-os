import { runCycle } from '../src/cycle.mjs';
import { createBook } from '../src/portfolio.mjs';
const result = await runCycle({symbol:'BTCUSDT',book:createBook({walletBalance:1000}),candidate:{symbol:'BTCUSDT',side:'LONG',qty:0.001,entryPrice:null},mode:'LIVE'});
console.log(JSON.stringify({halt:result.halt,bull:{valid:result.bull?.valid,reasons:result.bull?.reasons},bear:{valid:result.bear?.valid,reasons:result.bear?.reasons},verdict:result.verdict?.verdict,guardian:result.guardian?.status}));
