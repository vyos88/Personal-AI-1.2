import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Reads a daily Cloudflare report that something else on the host writes.
 *
 * This repo does not manage Cloudflare — the tunnel/edge setup lives elsewhere
 * — so the host does not invent numbers. It surfaces a report file if one is
 * configured (`ALPHA_CLOUDFLARE_REPORT`, a path to JSON refreshed daily by
 * whatever runs the Cloudflare side), and otherwise says plainly that none is
 * configured. The dashboard renders either outcome; it never fabricates.
 *
 * Node standard library only.
 *
 * @returns {Promise<object>} one of:
 *   { configured:false, note }                      no path set
 *   { configured:true, report, generatedAt, ... }   report read
 *   { configured:true, error, note }                path set but unreadable
 */
export async function cloudflareReport({ path = process.env.ALPHA_CLOUDFLARE_REPORT } = {}) {
  if (!path) {
    return {
      configured: false,
      note: 'No Cloudflare report configured. Set ALPHA_CLOUDFLARE_REPORT to a JSON file that the Cloudflare side refreshes daily.',
    };
  }

  const file = resolve(path);
  let raw;
  let generatedAt = null;
  try {
    raw = await readFile(file, 'utf8');
    const info = await stat(file).catch(() => null);
    if (info) generatedAt = info.mtime.toISOString();
  } catch (error) {
    return {
      configured: true,
      error: error.code === 'ENOENT' ? 'report file not found yet' : error.message,
      note: `Expected a daily report at ${file}.`,
    };
  }

  try {
    const report = JSON.parse(raw);
    // Let the writer carry its own timestamp if it has one; fall back to mtime.
    return { configured: true, generatedAt: report.generatedAt ?? generatedAt, report };
  } catch (error) {
    return { configured: true, error: `report is not valid JSON (${error.message})`, note: `At ${file}.` };
  }
}
