#!/usr/bin/env node
/**
 * Surveys the Alpha working copy before its first push, and refuses to be the
 * thing that publishes a secret.
 *
 * `alpha.update` cannot update anything until Alpha's code is actually in the
 * repository — today `vyos88/Alpha` holds one file. Getting it there is a
 * single push, and a first push of a directory that has never been in version
 * control is the most dangerous git operation there is: whatever is sitting in
 * it goes public in one commit, and a secret in git history stays in git
 * history long after the file is deleted.
 *
 * A personal assistant's working directory is close to a worst case for that.
 * Alpha's own shell calls /speech, /avatar, /communication and /triggers, so
 * the machine it runs on plausibly holds speech and model credentials, phone
 * or messaging tokens, and an auth store.
 *
 * So this reads and reports. **It runs no git command and changes nothing.**
 * It tells you what would be committed, what looks like a credential, what is
 * too big, and what the .gitignore should say. You read that, then push.
 *
 * Usage, on the Alpha host:
 *   node scripts/publish-alpha.mjs --dir C:\alpha
 *
 * Exit codes:
 *   0  nothing alarming found
 *   2  findings to look at before pushing
 *   1  could not run
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_FINDINGS = 2;

/**
 * Never worth committing, and the reason each is here.
 *
 * Directories: installed or generated, so they are large, machine-specific,
 * and rebuildable. Anything derived belongs out of git — that is also what
 * keeps a later `alpha.update` Pull fast.
 */
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache',
  'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  'coverage', '.gradle', 'target', 'bin', 'obj', '.idea', '.vs', '.vscode',
  'logs', 'tmp', 'temp',
]);

/** Files whose *name* alone is enough to stop and look. */
const SECRET_NAMES = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /credentials?(\.json|\.yml|\.yaml|\.ini)?$/i,
  /^service-account.*\.json$/i,
  /^token(s)?\.(json|txt)$/i,
  /^auth(-store)?\.json$/i,
  /^secrets?\.(json|yml|yaml|env|txt)$/i,
];

const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12', '.keystore', '.jks']);

/**
 * Content that looks like a live credential.
 *
 * Deliberately reported by file and line only — never by value. This report
 * gets pasted into chats and terminals, and a tool that scolds you about a
 * secret by printing it has leaked it a second time.
 */
const SECRET_CONTENT = [
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  // Any *_token / *_key / *_secret assigned a long literal. Deliberately broad:
  // the first version listed only the well-known names and sailed straight past
  // `speech_token = "..."` in a fixture, which is precisely the sort of thing
  // this machine has. For a pre-push audit a false positive costs a glance and
  // a miss costs a rotated credential, so it errs loud.
  { label: 'credential-looking assignment', re: /\b\w*(api[_-]?key|[_-]?key|secret|token|password|passwd|credential)\w*\s*[:=]\s*['"][A-Za-z0-9_\-./+]{16,}['"]/i },
  // The same thing in .env / shell form, where there are no quotes.
  { label: 'credential-looking environment variable', re: /^\s*(export\s+)?[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*\S{12,}/ },
  { label: 'bearer token', re: /\bbearer\s+[A-Za-z0-9_\-.]{20,}/i },
  { label: 'alpha-tunnel token', re: /\balpha_[a-z]+_[a-z0-9]{8,}\.[A-Za-z0-9_-]{16,}/ },
];

// Only text worth grepping. Reading a 300 MB model file line by line to look
// for "password" helps nobody.
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.rb', '.go',
  '.rs', '.java', '.cs', '.php', '.sh', '.bash', '.ps1', '.psm1', '.bat', '.cmd',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.txt', '.md',
  '.html', '.css', '.scss', '.xml', '.sql',
]);

const BIG_FILE_BYTES = 10 * 1024 * 1024;   // worth a second look
const HUGE_FILE_BYTES = 100 * 1024 * 1024; // GitHub refuses this outright
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const options = { dir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') options.dir = argv[++i];
    else throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  if (!options.dir) throw new Error('--dir <path to the Alpha working copy> is required');
  if (!existsSync(options.dir)) throw new Error(`no such directory: ${options.dir}`);
  return options;
}

function walk(root) {
  const files = [];
  const skipped = new Map();

  (function descend(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is not this tool's problem to solve
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
          skipped.set(entry.name, (skipped.get(entry.name) ?? 0) + 1);
          continue;
        }
        descend(full);
      } else if (entry.isFile()) {
        try {
          files.push({ path: full, rel: relative(root, full), size: statSync(full).size });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  })(root);

  return { files, skipped };
}

function scanForSecrets(files) {
  const findings = [];

  for (const file of files) {
    const name = basename(file.rel);
    const ext = extname(name).toLowerCase();

    if (SECRET_NAMES.some((re) => re.test(name))) {
      findings.push({ rel: file.rel, why: 'filename looks like a credentials file' });
      continue;
    }
    if (SECRET_EXTENSIONS.has(ext)) {
      findings.push({ rel: file.rel, why: `${ext} is a key or certificate` });
      continue;
    }
    if (!TEXT_EXTENSIONS.has(ext) || file.size > MAX_SCAN_BYTES) continue;

    let contents;
    try {
      contents = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    const lines = contents.split('\n');
    for (const { label, re } of SECRET_CONTENT) {
      const index = lines.findIndex((line) => re.test(line));
      // Line number only. The value stays where it is.
      if (index !== -1) findings.push({ rel: file.rel, why: `${label} at line ${index + 1}` });
    }
  }

  return findings;
}

function suggestedIgnore(skipped) {
  const present = [...skipped.keys()].filter((name) => name !== '.git').sort();
  return [
    '# Installed or generated — rebuildable, machine-specific, and what would',
    '# otherwise make every alpha.update Pull enormous.',
    ...present.map((name) => `${name}/`),
    '',
    '# Credentials. Never commit these; if one has already been committed,',
    '# rotating it is the fix — deleting the file is not.',
    '.env',
    '.env.*',
    '!.env.example',
    '*.pem',
    '*.key',
    '*.pfx',
    '*.p12',
    '.npmrc',
    '.netrc',
    'credentials.json',
    'service-account*.json',
    'auth-store.json',
    '',
    '# Local noise',
    '*.log',
    '.DS_Store',
    'Thumbs.db',
  ].join('\n');
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function main(argv) {
  const { dir } = parseArgs(argv);
  const { files, skipped } = walk(dir);
  const total = files.reduce((sum, file) => sum + file.size, 0);

  console.log(`\nAlpha working copy: ${dir}`);
  console.log(`Would commit: ${files.length} files, ${human(total)}\n`);

  if (skipped.size) {
    console.log('Excluded as installed or generated (put these in .gitignore):');
    for (const [name, count] of [...skipped].sort()) {
      console.log(`  ${name}/${count > 1 ? `  (${count} places)` : ''}`);
    }
    console.log('');
  }

  const big = files.filter((file) => file.size >= BIG_FILE_BYTES).sort((a, b) => b.size - a.size);
  if (big.length) {
    console.log('Large files — GitHub refuses anything over 100 MB outright:');
    for (const file of big.slice(0, 15)) {
      const flag = file.size >= HUGE_FILE_BYTES ? '  << over the hard limit' : '';
      console.log(`  ${human(file.size).padStart(9)}  ${file.rel}${flag}`);
    }
    if (big.length > 15) console.log(`  ...and ${big.length - 15} more`);
    console.log('');
  }

  const secrets = scanForSecrets(files);
  if (secrets.length) {
    console.log('POSSIBLE CREDENTIALS — read every one of these before pushing:');
    for (const finding of secrets) console.log(`  ${finding.rel}\n      ${finding.why}`);
    console.log('\n  Values are deliberately not printed. A secret pushed once is in the');
    console.log('  history for good, and deleting the file later does not remove it —');
    console.log('  rotating the credential is the only real fix. Add these to');
    console.log('  .gitignore first, and check nothing already committed carries them.\n');
  } else {
    console.log('No obvious credentials found. Not a guarantee — skim the file list too.\n');
  }

  console.log('--- suggested .gitignore ------------------------------------------');
  console.log(suggestedIgnore(skipped));
  console.log('-------------------------------------------------------------------\n');

  console.log('If that looks right, from the Alpha working copy:');
  console.log('  1. save the block above as .gitignore   (BEFORE the first git add)');
  console.log('  2. git status --porcelain | head -50    # sanity-check the list');
  console.log('  3. git add -A && git status --short | wc -l');
  console.log('  4. git commit -m "Alpha 9.0: the application itself"');
  console.log('  5. git push -u origin HEAD');
  console.log('\nThis script ran no git command and changed nothing.\n');

  return secrets.length || big.some((file) => file.size >= HUGE_FILE_BYTES)
    ? EXIT_FINDINGS
    : EXIT_OK;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(`publish-alpha: ${error.message}`);
  process.exit(EXIT_ERROR);
}
