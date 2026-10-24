import { main } from './server.js';

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
