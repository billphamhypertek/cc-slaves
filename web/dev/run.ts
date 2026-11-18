// `bun run web:dev`: mock engine (4318) + Vite (5173, proxies /ws). Open http://localhost:5173/?f=F3
const root = new URL('../', import.meta.url).pathname;
const mock = Bun.spawn(['bun', 'dev/mock-engine.ts'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
const vite = Bun.spawn(['bunx', 'vite'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
const stop = () => { mock.kill(); vite.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race([mock.exited, vite.exited]);
stop();
