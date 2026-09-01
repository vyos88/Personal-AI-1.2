import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads a .env file if one sits next to the project root. Real environment
 * variables already set always win, so an explicit `ALPHA_HOST_URL=... npm run
 * agent` overrides the file.
 */
export function loadEnv(file = '.env') {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return false;
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error) {
    process.stderr.write(`warning: could not read ${path}: ${error.message}\n`);
    return false;
  }
}
