import { createApp } from './app.js';
import { readMockApiConfig } from './config/environment.js';

const config = readMockApiConfig();
const app = await createApp({ config });
await app.listen({ port: config.port, host: '0.0.0.0' });
