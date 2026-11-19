// Self-update from the project's git remote (GitHub). Update = fetch + fast-forward pull, then exit so
// the supervisor (systemd Restart=always / start.bat loop) starts the new code.
const { execFile } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const AUTO_HOURS = +(process.env.UPDATE_CHECK_HOURS || 6);
const state = { lastCheck: 0, behind: 0, commits: [], error: null, applying: false };

const git = (args, timeout = 90000) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd: ROOT, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (e, out, err) => (e ? reject(new Error((err || e.message).trim().slice(0, 400))) : resolve(out.trim())));
});
const safeUrl = (u) => u.replace(/\/\/[^@/]+@/, '//***@');

async function repoInfo() {
  try {
    const top = await git(['rev-parse', '--show-toplevel']);
    if (path.resolve(top).toLowerCase() !== path.resolve(ROOT).toLowerCase()) return { repo: false, reason: 'Folder aplikasi bukan git repository sendiri' };
  } catch { return { repo: false, reason: 'Folder aplikasi bukan git repository (atau git belum terinstall). Pasang dengan git clone.' }; }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const [hash, subject, date] = (await git(['log', '-1', '--pretty=%h|%s|%cI'])).split('|');
  let remote = ''; try { remote = safeUrl(await git(['remote', 'get-url', 'origin'])); } catch { return { repo: false, reason: 'Remote "origin" belum diset' }; }
  return { repo: true, branch, current: { hash, subject, date }, remote };
}
async function status() {
  const i = await repoInfo();
  const authOk = !!process.env.DASH_USER;
  return { enabled: i.repo && authOk, reason: !i.repo ? i.reason : !authOk ? 'Isi DASH_USER dan DASH_PASS di .env dulu agar tombol update aman dipakai' : null,
    branch: i.branch, current: i.current, remote: i.remote, ...state };
}
async function check() {
  const i = await repoInfo();
  if (!i.repo) throw new Error(i.reason);
  try {
    await git(['fetch', '--prune', 'origin']);
    const up = `origin/${i.branch}`;
    state.behind = +(await git(['rev-list', '--count', `HEAD..${up}`])) || 0;
    state.commits = state.behind ? (await git(['log', `HEAD..${up}`, '--pretty=%h|%s|%an|%cI', '-n', '30'])).split('\n').map((l) => {
      const [hash, subject, author, date] = l.split('|'); return { hash, subject, author, date };
    }) : [];
    state.error = null;
  } catch (e) { state.error = e.message; }
  state.lastCheck = Date.now();
  return status();
}
async function apply() {
  if (state.applying) throw new Error('Update sedang berjalan');
  const i = await repoInfo();
  if (!i.repo) throw new Error(i.reason);
  state.applying = true;
  try {
    const out = await git(['pull', '--ff-only', 'origin', i.branch]);
    state.behind = 0; state.commits = [];
    console.log('[update]', out.split('\n').pop());
    setTimeout(() => { console.log('[update] restarting…'); process.exit(0); }, 1000); // supervisor restarts us
    return { ok: true, output: out, restarting: true };
  } catch (e) { state.applying = false; throw e; }
}

function schedule() {
  const run = () => repoInfo().then((i) => i.repo && check()).catch(() => {});
  setTimeout(run, 20000).unref();
  if (AUTO_HOURS > 0) setInterval(run, AUTO_HOURS * 3600 * 1000).unref();
}
module.exports = { status, check, apply, schedule };
