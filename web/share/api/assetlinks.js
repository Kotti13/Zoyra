// GET /.well-known/assetlinks.json (rewritten here by vercel.json)
import { assetLinks, toResponse } from '../lib/handler.js';

export const GET = () => toResponse(assetLinks());
export const HEAD = () => toResponse(assetLinks(), true);
