import { setTimeout as delay } from 'node:timers/promises';
export function calculate(value) { return value * 2; }
export async function service(value) { await delay(4); return calculate(value); }
