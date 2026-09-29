// What answers /api/ping on a port: 'same' (a panel of this version),
// 'other' (a panel of another version; older panels do not say theirs),
// or null (not a CodeTAC panel).
export function panelOnPort(ping, version) {
  if (ping?.status !== 200) return null;
  let body;
  try { body = JSON.parse(ping.body); } catch { return null; }
  if (body?.ok !== true) return null;
  return body.version === version ? { kind: 'same' } : { kind: 'other', version: body.version ?? null, pid: Number.isInteger(body.pid) ? body.pid : null };
}
