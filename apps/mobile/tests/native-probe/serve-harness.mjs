/**
 * Starts the probe's controlled listeners on fixed ports, bound to every interface so an emulator or
 * a device on the same network can reach them, and prints the exact values to type into the probe
 * screen. A human starts this and stops it with Ctrl-C; the probe runs against it are finite.
 *
 *   node tests/native-probe/serve-harness.mjs
 *
 * Fixed ports rather than ephemeral ones purely so the screen can carry defaults and nobody has to
 * type four URLs on a phone keyboard.
 */

import { startFaultSource, startRedirectTarget } from './harness.mjs';

const HOST = '0.0.0.0';
const TARGET_PORT = 4310;
const SOURCE_PORT = 4311;

const { createServer } = await import('node:http');
const free = async (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });

for (const [port, name] of [
  [TARGET_PORT, 'redirect target'],
  [SOURCE_PORT, 'fault source'],
]) {
  if (!(await free(port))) {
    console.error(`Port ${port} (${name}) is already in use. Stop whatever holds it and retry.`);
    process.exit(1);
  }
}

const target = await startRedirectTarget(HOST, TARGET_PORT);
const source = await startFaultSource(HOST, target.port, SOURCE_PORT);

const lan = Object.values(await import('node:os').then((os) => os.networkInterfaces()))
  .flat()
  .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  .map((entry) => entry.address);

console.log('Probe harness listening.');
console.log('');
console.log(`  Redirect target : port ${target.port}`);
console.log(`  Fault source    : port ${source.port}`);
console.log('');
console.log(
  '  Android emulator : http://10.0.2.2:%d and http://10.0.2.2:%d',
  source.port,
  target.port,
);
console.log(
  '  iOS simulator    : http://127.0.0.1:%d and http://127.0.0.1:%d',
  source.port,
  target.port,
);
for (const address of lan) {
  console.log(
    `  This machine     : http://${address}:${source.port} and http://${address}:${target.port}`,
  );
}
console.log('');
console.log('Ctrl-C to stop.');

const shutdown = async () => {
  await Promise.all([target.stop(), source.stop()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
