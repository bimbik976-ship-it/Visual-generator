import type { IncomingMessage, ServerResponse } from 'node:http';
import app from '../server.ts';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url) {
    const parsed = new URL(req.url, 'http://localhost');
    const rewrittenPath = parsed.searchParams.get('__vercel_path');
    if (rewrittenPath !== null) {
      parsed.searchParams.delete('__vercel_path');
      const qs = parsed.searchParams.toString();
      const normalized = rewrittenPath.replace(/^\/+/, '');
      req.url = `/api/${normalized}${qs ? `?${qs}` : ''}`;
      delete (req as { originalUrl?: string }).originalUrl;
    }
  }

  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
