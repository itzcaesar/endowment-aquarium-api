import { createApp } from './app.js';
import { readGameApiConfig } from './config/environment.js';

const config = readGameApiConfig();
const app = await createApp({ config });

await app.listen({ port: config.port, host: '0.0.0.0' });
