const express = require('express');
const { setTimeout: delay } = require('node:timers/promises');
function calculate(value) { return value * 2; }
async function service(value) { await delay(4); return calculate(value); }
async function handler(req, res) { res.json({ value: await service(21) }); }
const app = express();
app.get('/api/probe', handler);
app.listen(Number(process.env.PORT), '127.0.0.1');
