// GET /t/:id, /p/:id, /a/:id, /ar/:id, /u/:id, /l/:id  (rewritten here by vercel.json)
import { handleShare, toResponse } from '../lib/handler.js';

async function respond(request, head) {
  const q = new URL(request.url).searchParams;
  return toResponse(await handleShare({ kind: q.get('kind') ?? '', id: q.get('id') ?? '' }), head);
}

export const GET = (request) => respond(request, false);
export const HEAD = (request) => respond(request, true);
