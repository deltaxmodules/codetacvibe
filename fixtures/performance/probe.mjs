function lineTotal(price, quantity) { return Math.round(price * quantity * 100) / 100; }
function invoiceTotal(lines) {
  let total = 0;
  for (const line of lines) total += lineTotal(line.price, line.quantity);
  return total;
}
const lines = Array.from({ length: 1000 }, (_, i) => ({ price: 1 + i / 100, quantity: 2 }));
const samplesMs = [];
let total;
for (let i = 0; i < 12; i++) {
  const start = performance.now();
  total = invoiceTotal(lines);
  if (i >= 2) samplesMs.push(performance.now() - start);
}
console.log(JSON.stringify({ total, samplesMs }));
