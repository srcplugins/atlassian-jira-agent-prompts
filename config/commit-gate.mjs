// Shared srcplugins file, synchronized across repositories.
// Commit gate: a commit on `dev` needs a full `npm run check` that passed on exactly the tree being
// committed. The check's last step (`record`) saves that tree in .local/ and installs a git
// pre-commit hook (`verify`) that compares it with the staged tree; `npm run commit`, which commits
// through GitHub rather than git, asks the same question. Commits that change only Markdown are
// exempt, and so is every branch but `dev`, so landings on main are untouched. A repository's
// quick `plugins:drift` script, where it defines one, runs on every commit on `dev`, Markdown included.
//
// The same evidence spares CI a repeat: `suite` runs a hosted suite and records the tree a whole
// features or full suite passed on, and the commit-msg hook (`message`, also installed by
// `record`) adds a Local-suite trailer to a commit on `dev` of exactly that tree. The Hosted
// workflow skips its features run for a push to `dev` whose head commit carries the trailer with
// that commit's own tree.
// Usage: node <this file> record | verify | message <file> | suite <name>…
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const receiptFile = '.local/commit-gate.json';
const suiteFile = '.local/hosted-suite.json';
const marker = 'srcplugins commit gate';
// Not a "Hosted:" line: the Hosted workflow reads every line starting with that as a choice.
const trailer = 'Local-suite';
// Suites that cover the features suite a push runs by default.
const covering = ['features', 'full'];

function git(cwd, args, env = process.env) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The repository's top directory, or undefined outside a git work tree. */
function topLevel(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The tree a commit would have, built in a temporary index so the real one is untouched: from the
 * current index with every tracked change in the working tree, or from `base` (a commit) with
 * only `add` and `remove` applied.
 */
export function treeOf(cwd, { base, add = [], remove = [] } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'commit-gate-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index') };
  try {
    if (base) git(cwd, ['read-tree', base], env);
    else {
      const index = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']));
      if (existsSync(index)) {
        copyFileSync(index, env.GIT_INDEX_FILE);
        // Keep the index's times: git rehashes an entry written in the same second as its index
        // ("racy"), and a newer copy would make a same-size edit from that second look clean.
        const { atime, mtime } = statSync(index);
        utimesSync(env.GIT_INDEX_FILE, atime, mtime);
      }
      git(cwd, ['add', '-u'], env);
    }
    if (add.length) git(cwd, ['add', '--', ...add], env);
    if (remove.length) git(cwd, ['rm', '--cached', '--quiet', '--', ...remove], env);
    return git(cwd, ['write-tree'], env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The recorded passing tree, if any. */
export function receipt(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, receiptFile), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Why a commit is refused, or undefined when it may go ahead. */
export function refusal({ branch, tree, changed, recorded }) {
  if (branch !== 'dev') return undefined;
  if (changed.length && changed.every((file) => /\.md$/i.test(file))) return undefined;
  if (recorded?.tree === tree) return undefined;
  const untracked = recorded?.untracked
    ? ` The last check left out ${recorded.untracked} untracked file(s): stage new files (\`git add\`) before it runs.`
    : '';
  return (
    'No full `npm run check` passed on the tree being committed. Run it after the last change ' +
    `(it records the tree), then commit exactly those files. Markdown-only commits are exempt.${untracked}`
  );
}

/**
 * Why a repository's quick drift check refuses a commit, or undefined: its `plugins:drift` script,
 * which compares the files this repository manages in other checkouts. It runs even for
 * Markdown-only commits, which skip the full check. A plugin defines none.
 */
export function driftRefusal(root) {
  let scripts;
  try {
    ({ scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')));
  } catch {
    return undefined;
  }
  if (!scripts?.['plugins:drift']) return undefined;
  const result = spawnSync('npm', ['run', '--silent', 'plugins:drift'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status === 0) return undefined;
  return (
    'Plugin drift (above). Run `npm run plugins:sync`, commit and push each synced plugin, then ' +
    'commit here; Verify checks the plugins as they are on GitHub.'
  );
}

/** The whole gate for a commit on `branch`: the recorded check, then drift on `dev`. */
export function gateRefusal(root, { branch, tree, changed }) {
  return (
    refusal({ branch, tree, changed, recorded: receipt(root) }) ??
    (branch === 'dev' ? driftRefusal(root) : undefined)
  );
}

/** The recorded passing hosted suite, if any. */
export function suiteRecord(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, suiteFile), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Runs `npx forge-test suite <args>` and returns its exit status. When the whole features or full
 * suite passes (no other argument, so no `--only`), and the working tree had no untracked files
 * (a deploy can include them; a commit wouldn't) and didn't change while it ran, it records that
 * tree. It removes any earlier record first, so a later failure on the same tree isn't hidden.
 */
export function runSuite(cwd, args, command = ['npx', 'forge-test', 'suite']) {
  const root = topLevel(cwd);
  const own = root && realpathSync(root) === realpathSync(cwd);
  if (own) rmSync(path.join(root, suiteFile), { force: true });
  const whole = own && args.length === 1 && covering.includes(args[0]);
  const state = () => ({
    tree: treeOf(root),
    untracked: git(root, ['ls-files', '--others', '--exclude-standard']),
  });
  const before = whole ? state() : undefined;
  const [program, ...rest] = command;
  const status = spawnSync(program, [...rest, ...args], { cwd, stdio: 'inherit' }).status ?? 1;
  if (status !== 0 || !before) return status;
  const after = state();
  if (before.untracked || after.untracked)
    console.warn(
      'Not recorded for CI: untracked files could have been deployed. Commit or remove them and rerun.',
    );
  else if (before.tree !== after.tree)
    console.warn('Not recorded for CI: tracked files changed while the suite ran.');
  else {
    mkdirSync(path.join(root, '.local'), { recursive: true });
    writeFileSync(
      path.join(root, suiteFile),
      `${JSON.stringify({ suite: args[0], tree: after.tree, at: new Date().toISOString() })}\n`,
    );
    console.log(
      `Recorded: the ${args[0]} suite passed on tree ${after.tree.slice(0, 12)}. A commit on dev of exactly this tree gets a ${trailer} trailer, and CI skips its features run.`,
    );
  }
  return status;
}

/**
 * The commit message with a Local-suite trailer when `tree`, being committed on `dev`, is the one
 * `recorded` (suiteRecord) passed on. A message that already chooses a run with a "Hosted:" line
 * keeps that choice and gets none. A trailer left from an earlier version of the message (an
 * amend) is dropped first, so only a current match carries one. Comment lines (an editor's) stay
 * last.
 */
export function withLocalSuite(message, { branch, tree, recorded }) {
  const lines = message.split('\n');
  const comments = lines.findIndex((line) => line.startsWith('#'));
  const body = comments < 0 ? lines : lines.slice(0, comments);
  const tail = comments < 0 ? [] : lines.slice(comments);
  const kept = body.filter((line) => !line.startsWith(`${trailer}:`));
  const text = kept.join('\n').trimEnd();
  const matches =
    branch === 'dev' &&
    Boolean(tree) &&
    recorded?.tree === tree &&
    covering.includes(recorded?.suite) &&
    text !== '' &&
    !/^Hosted:/m.test(text);
  if (!matches) return kept.length === body.length ? message : [...kept, ...tail].join('\n');
  const paragraphs = text.split(/\n\s*\n/);
  // Join an existing trailer block (a last paragraph of "Token: value" lines after the subject).
  const block =
    paragraphs.length > 1 &&
    paragraphs
      .at(-1)
      .split('\n')
      .every((line) => /^[A-Za-z0-9-]+: \S/.test(line));
  const line = `${trailer}: ${recorded.suite} passed on tree ${tree} at ${recorded.at}`;
  return [`${text}${block ? '\n' : '\n\n'}${line}`, ...tail].join('\n') + (tail.length ? '' : '\n');
}

/** Whether a repository uses the gate: its check script ends by recording. */
export function gated(root) {
  try {
    const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    return /commit-gate\.mjs record/.test(scripts?.check ?? '');
  } catch {
    return false;
  }
}

/**
 * Records the tree a passing check ran on, and installs the pre-commit (`verify`) and commit-msg
 * (`message`) hooks where no other hook of that name is.
 */
export function record(cwd = process.cwd(), script = fileURLToPath(import.meta.url)) {
  const root = topLevel(cwd);
  // A package that is not its repository's root, such as a generated plugin checked inside
  // another work tree, or outside git altogether, has nothing of its own to commit.
  if (!root || realpathSync(root) !== realpathSync(cwd)) return;
  mkdirSync(path.join(root, '.local'), { recursive: true });
  // The recorded tree holds tracked files only, so a new file must be staged before the check.
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean);
  writeFileSync(
    path.join(root, receiptFile),
    `${JSON.stringify({ tree: treeOf(root), untracked: untracked.length, at: new Date().toISOString() })}\n`,
  );
  if (untracked.length)
    console.warn(
      `The recorded tree of ${path.basename(root)} leaves out ${untracked.length} untracked file(s) (${untracked.slice(0, 3).join(', ')}${untracked.length > 3 ? ', …' : ''}). To commit them, \`git add\` them and run the check again.`,
    );
  const hooks = path.resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']));
  const relative = path.relative(root, script);
  for (const [name, command] of [
    ['pre-commit', 'verify'],
    ['commit-msg', 'message "$1"'],
  ]) {
    const hook = path.join(hooks, name);
    if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(marker)) {
      console.warn(`${hook} exists and is not the ${marker}; it was left as it is.`);
      continue;
    }
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      hook,
      `#!/bin/sh\n# Installed by the ${marker} (${relative}).\nexec node "${relative}" ${command}\n`,
    );
    chmodSync(hook, 0o755);
  }
}

/** The pre-commit check: git runs it at the top directory, with the index being committed. */
function verify(cwd = process.cwd()) {
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  // A first commit is compared with the empty tree.
  const base = head.status === 0 ? 'HEAD' : git(cwd, ['hash-object', '-t', 'tree', '/dev/null']);
  const changed = git(cwd, ['diff', '--cached', '--name-only', base]).split('\n').filter(Boolean);
  return gateRefusal(cwd, { branch: currentBranch(cwd), tree: git(cwd, ['write-tree']), changed });
}

const currentBranch = (cwd) =>
  spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).stdout.trim();

/**
 * The commit-msg hook: adds or drops the Local-suite trailer in the message file. It never
 * refuses a commit; at worst CI runs the suite again.
 */
function message(file, cwd = process.cwd()) {
  try {
    const text = readFileSync(file, 'utf8');
    const next = withLocalSuite(text, {
      branch: currentBranch(cwd),
      tree: git(cwd, ['write-tree']),
      recorded: suiteRecord(cwd),
    });
    if (next !== text) writeFileSync(file, next);
  } catch (error) {
    console.warn(`No ${trailer} trailer: ${error.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'record') record();
  else if (command === 'verify') {
    const reason = verify();
    if (reason) {
      console.error(reason);
      process.exitCode = 1;
    }
  } else if (command === 'message' && args.length === 1) message(args[0]);
  else if (command === 'suite' && args.length) process.exitCode = runSuite(process.cwd(), args);
  else {
    console.error('Usage: node commit-gate.mjs record | verify | message <file> | suite <name>…');
    process.exitCode = 2;
  }
}
