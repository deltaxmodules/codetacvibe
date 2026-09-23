import { service } from './service.js';
export async function GET() { return Response.json({ value: await service(21) }); }
