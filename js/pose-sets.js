// ── pose-sets.js ──────────────────────────────────────────────────
// Pose SETS: every *.json file sitting directly in the presets/ folder is a
// set, and each one is EXACTLY the same kind of file as pose-overrides.json —
// pose-overrides.json is simply the first set (the original poses). They are
// all read at launch, and their poses show up in the Pose panel, the 3D
// editor's Switch Pose list and the Copy Poses menu.
//
// Every file has the same layout:
//   - one top-level entry per pose key (the pose's own numbers — label,
//     section, spineTwist, right:{...} etc. — plus whatever Save adds, e.g.
//     jointXYZ), and
//   - the reserved blobs _jointEdits / _handWristOverrides / _wristPins /
//     _wristAttachments, each keyed by pose key.
// A pose's edits are saved back into the file that pose lives in (a pose from
// "model poses v2.json" saves into "model poses v2.json"; an original pose
// saves into pose-overrides.json). Optional "_name" gives the set a display
// name (defaults to the filename).
//
// Also here: the search + "which set" filter shared by the three pose menus.
// Plain global script (no modules) — loaded after poses-data.js, before 3d-init.js.

const POSE_SET_ORIGINAL_ID3D = 'pose-overrides';
const POSE_SETS_FOLDER3D = 'presets';
const POSE_SETS_CACHE_KEY3D = 'poseSetFileListCache';

// The built-in poses are the first "set" (shown as "Original poses").
const poseSets3D = [{ id: POSE_SET_ORIGINAL_ID3D, label: 'Original poses', file: 'pose-overrides.json', builtIn: true, count: 0 }];
const poseSetOf3D = {};          // pose key -> set id
const poseSetErrors3D = [];      // human-readable problems reading set files
const POSE_MAIN_FILE3D = 'pose-overrides.json';
const POSE_RESERVED_KEYS3D = ['_jointEdits', '_handWristOverrides', '_wristPins', '_wristAttachments'];
const poseFileData3D = {};       // file name -> that file's parsed JSON, as last read from / written to GitHub
Object.keys(POSES3D).forEach(k => { poseSetOf3D[k] = POSE_SET_ORIGINAL_ID3D; });
poseSets3D[0].count = Object.keys(POSES3D).length;
let poseSetsReady3D = null;      // promise; hand-pins-github.js waits on it before applying saved edits

function escapeHtmlPose3D(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function prettifyPoseName3D(s) { return String(s).replace(/\.json$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// ---- Reading the presets folder -------------------------------------------
async function listPoseSetFiles3D(s) {
  const cacheId = `${s.owner}/${s.repo}@${s.branch}`;
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/${POSE_SETS_FOLDER3D}?ref=${encodeURIComponent(s.branch)}`;
    const resp = await fetch(url, { headers: ghHeaders(s.token), cache: 'no-store' });
    if (!resp.ok) throw new Error(resp.status + ' ' + resp.statusText);
    const items = await resp.json();
    if (!Array.isArray(items)) throw new Error('presets is not a folder');
    const files = items
      .filter(i => i.type === 'file' && /\.json$/i.test(i.name) && i.name.toLowerCase() !== 'pose-overrides.json')
      .map(i => i.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    try { localStorage.setItem(POSE_SETS_CACHE_KEY3D, JSON.stringify({ id: cacheId, files })); } catch (e) {}
    return files;
  } catch (e) {
    // GitHub's anonymous API limit is low (60/hr per IP) — fall back to the last list we saw.
    try {
      const c = JSON.parse(localStorage.getItem(POSE_SETS_CACHE_KEY3D) || 'null');
      if (c && c.id === cacheId && Array.isArray(c.files)) { console.warn('Using cached pose-set list:', e.message); return c.files; }
    } catch (e2) {}
    throw e;
  }
}
async function fetchPoseSetFile3D(s, name) {
  const enc = encodeURIComponent(name);
  const viaApi = async () => {
    const url = `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/${POSE_SETS_FOLDER3D}/${enc}?ref=${encodeURIComponent(s.branch)}`;
    const r = await fetch(url, { headers: Object.assign(ghHeaders(s.token), { Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    return JSON.parse(await r.text());
  };
  // With a token (you, saving edits) read straight from the API so you always see your latest save — the
  // site's own copy can lag a few minutes behind a commit. Without one (visitors) use the site's copy first:
  // no API rate limit, no CORS.
  if (s.token) return viaApi();
  try {
    const r = await fetch(`${POSE_SETS_FOLDER3D}/${enc}?_=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch (e) { /* not hosted next to presets/ — use the API */ }
  return viaApi();
}

// Which file a pose's data lives in / saves to.
function poseFileNameFor3D(poseKey) {
  const set = poseSets3D.find(x => x.id === poseSetOf3D[poseKey]);
  return (set && !set.builtIn) ? set.file : POSE_MAIN_FILE3D;
}
function poseFilePathFor3D(poseKey) { return POSE_SETS_FOLDER3D + '/' + poseFileNameFor3D(poseKey); }

// Keep only the entries of a file's data that belong to that file (a duplicate key skipped at load, say, isn't ours).
function ownedPoseFileData3D(file, data) {
  const owns = k => poseFileNameFor3D(k) === file;
  const out = {};
  Object.keys(data || {}).forEach(k => {
    const v = data[k];
    if (k[0] !== '_') { if (owns(k)) out[k] = v; return; }
    if (POSE_RESERVED_KEYS3D.indexOf(k) < 0) return;
    if (file === POSE_MAIN_FILE3D) { out[k] = v; return; } // main file keeps everything it has, as before
    const pick = obj => { const o = {}; Object.keys(obj || {}).forEach(pk => { if (owns(pk)) o[pk] = obj[pk]; }); return o; };
    if (k === '_jointEdits') out[k] = { pose: v && v.pose, manualJointEdits: pick(v && v.manualJointEdits) };
    else if (k === '_handWristOverrides') out[k] = { byPose: pick(v && v.byPose) };
    else out[k] = pick(v); // _wristPins / _wristAttachments
  });
  return out;
}
// All files' data folded into ONE pose-overrides-shaped object (what the loaders and the save-status check read).
// Pose keys are unique across files, so this is just a union.
function mergedPoseFilesData3D() {
  const out = {};
  const files = Object.keys(poseFileData3D).sort((a, b) => (a === POSE_MAIN_FILE3D ? -1 : b === POSE_MAIN_FILE3D ? 1 : 0));
  files.forEach(file => {
    const d = ownedPoseFileData3D(file, poseFileData3D[file]);
    Object.keys(d).forEach(k => {
      if (k[0] !== '_') { out[k] = d[k]; return; }
      if (k === '_jointEdits') {
        const je = out[k] = out[k] || { pose: d[k].pose, manualJointEdits: {} };
        let raw = d[k].manualJointEdits || {};
        if (raw.left || raw.right) raw = { [d[k].pose || currentPose3D]: raw }; // old flat save -> keyed by the pose it was for
        if (je.manualJointEdits.left || je.manualJointEdits.right) je.manualJointEdits = { [je.pose || currentPose3D]: je.manualJointEdits };
        Object.assign(je.manualJointEdits, raw);
      } else if (k === '_handWristOverrides') {
        if (!d[k].byPose) { if (!out[k]) out[k] = d[k]; return; } // old flat save: leave as-is
        if (!out[k] || !out[k].byPose) { if (out[k]) return; out[k] = { byPose: {} }; }
        Object.assign(out[k].byPose, d[k].byPose);
      } else { // _wristPins / _wristAttachments: { poseKey: {...} }
        if (d[k].left || d[k].right) { if (!out[k]) out[k] = d[k]; return; } // old flat attachments save
        if (out[k] && (out[k].left || out[k].right)) return;
        out[k] = Object.assign(out[k] || {}, d[k]);
      }
    });
  });
  return out;
}
// Pushes the union of all files to the save-status check — but only once the main file has been read,
// so status stays 'unknown' (grey) rather than briefly claiming 'No Save'.
function updatePoseBaseline3D() {
  if (poseFileData3D[POSE_MAIN_FILE3D] === undefined || typeof setSaveBaseline3D !== 'function') return;
  setSaveBaseline3D(mergedPoseFilesData3D());
}
// Remember what a file currently holds on GitHub, and refresh the "On latest save" baseline from all files.
function recordPoseFileData3D(file, data) {
  poseFileData3D[file] = (data && typeof data === 'object') ? data : {};
  updatePoseBaseline3D();
}
// Re-reads every loaded set file fresh (used by Load / Reset, which want the latest saved state of everything).
async function refreshPoseSetFilesData3D(s) {
  await Promise.all(poseSets3D.filter(x => !x.builtIn).map(async x => {
    try { poseFileData3D[x.file] = await fetchPoseSetFile3D(s, x.file); }
    catch (e) { console.warn('Could not re-read ' + x.file, e); }
  }));
  updatePoseBaseline3D();
}

// A set file is the same shape as pose-overrides.json: top-level non-underscore keys are poses.
function parsePoseSetFile3D(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected a JSON object');
  const name = (typeof raw._name === 'string' && raw._name) || (raw._meta && raw._meta.name) || null;
  return { name, data: raw };
}

// Adds one set's poses to POSES3D. Never overwrites an existing pose key.
function registerPoseSet3D(file, parsed) {
  const id = file.replace(/\.json$/i, '');
  const label = (parsed.name && String(parsed.name).trim()) || prettifyPoseName3D(file);
  const set = { id, label, file, count: 0 };
  poseSets3D.push(set); // pushed first so poseFileNameFor3D works for its own keys below
  const data = parsed.data;
  Object.keys(data).forEach(rawKey => {
    if (rawKey[0] === '_') return;
    const entry = data[rawKey];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    if (rawKey !== rawKey.replace(/[^A-Za-z0-9_.\-]/g, '-')) { // keys end up inside onclick="…('key')" strings
      console.warn(`Pose key "${rawKey}" in ${file} skipped — use only letters, numbers, - _ .`); poseSetErrors3D.push(`${file}: "${rawKey}" skipped (key has odd characters)`); return;
    }
    const key = rawKey;
    if (POSES3D[key]) { console.warn(`Pose "${key}" in ${file} skipped — that key is already used by set "${poseSetOf3D[key]}".`); poseSetErrors3D.push(`${file}: "${key}" skipped (duplicate key)`); return; }
    const def = JSON.parse(JSON.stringify(entry));
    delete def.jointXYZ; // a saved snapshot, not part of the pose definition
    POSES3D[key] = Object.assign(def, { section: def.section || label, label: def.label || prettifyPoseName3D(key) });
    poseSetOf3D[key] = id;
    set.count++;
    // Remember the pose's own literal hand facing (same as the built-in poses) before saved edits layer on top.
    if (typeof capturePoseLiteralFacingFor3D === 'function') capturePoseLiteralFacingFor3D(key);
  });
  poseFileData3D[file] = data;
}

async function loadPoseSetsFromPresets3D() {
  try {
    const s = ghGetSettings();
    if (!s.owner || !s.repo) return;
    if (typeof capturePoseLiteralFacing3D === 'function') capturePoseLiteralFacing3D();
    const files = await listPoseSetFiles3D(s);
    const results = await Promise.all(files.map(async f => {
      try { return { f, parsed: parsePoseSetFile3D(await fetchPoseSetFile3D(s, f)) }; }
      catch (e) { console.warn(`Could not read pose set ${f}:`, e); poseSetErrors3D.push(`${f}: ${e.message}`); return null; }
    }));
    results.forEach(r => { if (r) registerPoseSet3D(r.f, r.parsed); }); // filename order, regardless of which fetch finished first
    updatePoseBaseline3D();
  } catch (e) {
    console.warn('Could not load pose sets from the presets folder:', e);
    poseSetErrors3D.push('Could not list the presets folder (' + e.message + ')');
  }
  refreshPoseSetUI3D();
}

// ---- Search + set filter (shared by the 3 pose menus) ----------------------
// ctx: 'panel' (Pose panel), 'popup' (editor Switch Pose), 'copy' (editor Copy Poses)
const poseSearchState3D = { panel: { q: '', set: '' }, popup: { q: '', set: '' }, copy: { q: '', set: '' } };
const POSE_SEARCH_IDS3D = {
  panel: { input: 'poseSearchInput', select: 'poseSetSelect', count: 'poseSearchCount' },
  popup: { input: 'jePoseSearchInput', select: 'jePoseSetSelect', count: 'jePoseSearchCount' },
  copy:  { input: 'jeCopySearchInput', select: 'jeCopySetSelect', count: 'jeCopySearchCount' },
};
function poseMatchesSearch3D(key, st) {
  const p = POSES3D[key]; if (!p) return false;
  if (st.set && poseSetOf3D[key] !== st.set) return false;
  const q = (st.q || '').trim().toLowerCase();
  if (!q) return true;
  const set = poseSets3D.find(x => x.id === poseSetOf3D[key]);
  const hay = `${p.label || ''} ${key} ${p.section || ''} ${set ? set.label : ''}`.toLowerCase();
  return q.split(/\s+/).every(t => hay.includes(t));
}
function filteredPoseKeys3D(ctx) { return Object.keys(POSES3D).filter(k => poseMatchesSearch3D(k, poseSearchState3D[ctx])); }
function rerenderPoseCtx3D(ctx) {
  if (ctx === 'panel') { if (typeof renderPosePanel3D === 'function') renderPosePanel3D(); }
  else if (ctx === 'popup') { if (typeof renderPosePopupList3D === 'function') renderPosePopupList3D(); }
  else if (ctx === 'copy') { if (typeof populateCopyPoseSelect3D === 'function') populateCopyPoseSelect3D(); }
}
function onPoseSearch3D(ctx, value) { poseSearchState3D[ctx].q = value || ''; rerenderPoseCtx3D(ctx); }
function onPoseSetFilter3D(ctx, value) { poseSearchState3D[ctx].set = value || ''; rerenderPoseCtx3D(ctx); }
function clearPoseSearch3D(ctx) {
  poseSearchState3D[ctx].q = '';
  const el = document.getElementById(POSE_SEARCH_IDS3D[ctx].input); if (el) el.value = '';
}
function updatePoseSearchCount3D(ctx, shown) {
  const el = document.getElementById(POSE_SEARCH_IDS3D[ctx].count); if (!el) return;
  const st = poseSearchState3D[ctx];
  el.textContent = (st.q.trim() || st.set) ? `${shown} match${shown === 1 ? '' : 'es'}` : '';
}
// Fills the three "which set" dropdowns (only shown once there's more than the original set).
function refreshPoseSetSelects3D() {
  Object.keys(POSE_SEARCH_IDS3D).forEach(ctx => {
    const sel = document.getElementById(POSE_SEARCH_IDS3D[ctx].select); if (!sel) return;
    const st = poseSearchState3D[ctx];
    if (st.set && !poseSets3D.some(x => x.id === st.set)) st.set = '';
    sel.innerHTML = `<option value="">All sets (${Object.keys(POSES3D).length})</option>` +
      poseSets3D.map(x => `<option value="${escapeHtmlPose3D(x.id)}">${escapeHtmlPose3D(x.label)} (${x.count})</option>`).join('');
    sel.value = st.set;
    sel.style.display = poseSets3D.length > 1 ? '' : 'none';
  });
}
function refreshPoseSetUI3D() {
  refreshPoseSetSelects3D();
  if (typeof renderPosePanel3D === 'function') renderPosePanel3D();
  if (typeof populateCopyPoseSelect3D === 'function') populateCopyPoseSelect3D();
  const pop = document.getElementById('jePosePopup');
  if (pop && pop.classList.contains('open') && typeof renderPosePopupList3D === 'function') renderPosePopupList3D();
}

// Started from 3d-init.js (last script) so every function it refreshes already exists.
