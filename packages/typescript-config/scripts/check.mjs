import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const typescriptEntry = import.meta.resolve('typescript');
const compiler = fileURLToPath(new URL('./tsc.js', typescriptEntry));
const configs = ['base.json', 'node.json', 'bundler.json', 'react.json'];

for (const config of configs) {
  try {
    execFileSync(process.execPath, [compiler, '--showConfig', '--project', config], {
      cwd: packageDirectory,
      stdio: 'pipe',
    });
  } catch (error) {
    if (error && typeof error === 'object') {
      if ('stdout' in error && error.stdout) process.stderr.write(error.stdout);
      if ('stderr' in error && error.stderr) process.stderr.write(error.stderr);
    }
    throw error;
  }
}
