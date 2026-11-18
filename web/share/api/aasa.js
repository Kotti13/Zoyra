// GET /.well-known/apple-app-site-association (rewritten here by vercel.json)
import { appleAppSiteAssociation, toResponse } from '../lib/handler.js';

export const GET = () => toResponse(appleAppSiteAssociation());
export const HEAD = () => toResponse(appleAppSiteAssociation(), true);
