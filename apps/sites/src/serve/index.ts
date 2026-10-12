import { readServeConfig } from './config.ts';
import { createSiteServer } from './server.ts';
import { createS3Reader } from './store.ts';

const config = readServeConfig(process.env);
const server = createSiteServer({
  reader: createS3Reader(config.s3),
  allowedSuffix: config.allowedSuffix,
  defaultLabelSuffix: config.defaultLabelSuffix,
});

server.listen(config.address.port, config.address.host, () => {
  const line = {
    at: new Date().toISOString(),
    message: 'sites server listening',
    port: config.address.port,
    suffix: config.allowedSuffix,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
