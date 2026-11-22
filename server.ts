import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ensureCatalogReady, loadCatalogFromDb } from './server/kieCatalog.ts';
import { apiRouter } from './server/routes.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '45mb' }));

// Mount API routes
app.use('/api', apiRouter);

function mountStaticFallback(): void {
  const publicDir = path.resolve(process.cwd(), 'public');
  const distDir = path.resolve(process.cwd(), 'dist');
  const staticDir = fs.existsSync(path.join(publicDir, 'index.html')) ? publicDir : distDir;
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => {
    const indexPath = path.join(staticDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Build output not found.');
    }
  });
}

// Load cached catalog immediately and warm/sync in background
loadCatalogFromDb();
void ensureCatalogReady();

if (process.env.VERCEL) {
  mountStaticFallback();
} else {
  const startLocalServer = async (): Promise<void> => {
    if (!isProduction) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      mountStaticFallback();
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Kie Studio server listening on http://0.0.0.0:${PORT}`);
    });
  };

  void startLocalServer();
}

export default app;
