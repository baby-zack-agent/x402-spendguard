'use strict';
// Example: guard an x402 facilitator endpoint with spendguard.
// Zero dependencies — plain node:http with a tiny Express-style adapter.
//
//   node examples/facilitator.js
//   curl -X POST localhost:8787/pay \
//     -H 'content-type: application/json' \
//     -d '{"payment":{"agentId":"scraper-01","to":"0xabc","amountUsd":5}}'
//   # -> 200 {"verified":true,...}            (allowed, reaches the handler)
//   # oversized amounts -> 402 held for approval (with queue:true)
//   # denylisted recipients -> 403 with reasons
const http = require('node:http');
const { loadPolicy } = require('../lib/policy');
const { facilitatorGuard } = require('../lib/facilitator');

const policy = loadPolicy(__dirname + '/../policy.example.json');
const guard = facilitatorGuard(policy, {
  logPath: __dirname + '/facilitator-audit.log',
  queue: true, // needs_approval -> held in the approval queue, 402 carries queueId
});

// Minimal Express-style (req, res, next) adapter over node:http.
function adapt(mw) {
  return (nodeReq, nodeRes) => {
    let body = '';
    nodeReq.on('data', (c) => { body += c; });
    nodeReq.on('end', () => {
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch { /* fail-closed: guard denies */ }
      const req = { body: json };
      const res = {
        status(code) { this.statusCode = code; return this; },
        json(obj) {
          nodeRes.writeHead(this.statusCode || 200, { 'content-type': 'application/json' });
          nodeRes.end(JSON.stringify(obj));
        },
      };
      mw(req, res, () => {
        // <-- only reached when spendguard allowed the payment.
        // Your real x402 verification / settlement goes here.
        nodeRes.writeHead(200, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ verified: true, settled: req.body.payment }));
      });
    });
  };
}

const server = http.createServer((nodeReq, nodeRes) => {
  if (nodeReq.method === 'POST' && nodeReq.url === '/pay') return adapt(guard)(nodeReq, nodeRes);
  nodeRes.writeHead(404).end('not found');
});

server.listen(8787, () => console.log('guarded facilitator on http://localhost:8787/pay'));
