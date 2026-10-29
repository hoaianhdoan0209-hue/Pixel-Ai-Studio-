import { resolve } from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR || 'var');
const instance = createApp({dataDir, allowFirstAdmin: process.env.BOOTSTRAP_ADMIN === 'true'});
const server = instance.app.listen(port,host,()=>console.log(`Pixel AI World API listening on ${host}:${port}`));
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  instance.stopServices();
  const deadline = setTimeout(() => server.closeAllConnections(), 20000);
  deadline.unref();
  server.close(() => {
    clearTimeout(deadline);
    instance.close();
    process.exit(0);
  });
};
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
