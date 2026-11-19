// Production entry (Railway): ingest + processor in one container, sharing DATA_DIR on one volume.
// If either dies, exit so the platform restarts both together.
import { spawn, type ChildProcess } from 'node:child_process';

const kids: ChildProcess[] = [];
const run = (name: string, args: string[]) => {
  const p = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  p.on('exit', (code, signal) => {
    console.error(`[start] ${name} exited (${code ?? signal}), stopping`);
    stop(code ?? 1);
  });
  kids.push(p);
};
function stop(code: number) {
  for (const k of kids) if (k.exitCode === null) k.kill('SIGTERM');
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stop(0));

run('ingest', ['ingest/server.ts']);
run('processor', ['--disable-warning=ExperimentalWarning', 'processor/processor.ts']);
