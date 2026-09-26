// ── hand-pins-github.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. GitHub read/write plumbing for
// presets/pose-overrides.json (generic PUT/GET-with-retry helper, per-pose
// hand-facing overrides, and the Reset-to-saved-file escape hatch), plus
// captureAllJointXYZ3D — the joint XYZ snapshot the ⬆ Save button writes.
//
// The old mesh-face hand-pin system (Pinned Mesh / Pinned Face Part
// dropdowns, the Default Setter, and the position-based arm IK) has been
// removed entirely, along with the fixed-angle-vs-"positioned" branch it
// needed in applyPose3D. Every joint's rotation still comes straight from
// the pose data / sliders / manual joint-editor drags, same as before.
// What's new: ⬆ Save now also snapshots every joint's current XYZ position
// (relative to the spine — the character's own fixed "world map" frame,
// unaffected by root tilt) into the saved file, only when the button is
// actually pressed. That gives a future pin system real, unpinned baseline
// coordinates to build on top of instead of re-deriving them from scratch.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

const round2 = n => Math.round(n * 100) / 100;
const round1 = n => Math.round((n || 0) * 10) / 10;

// ---- Joint XYZ snapshot -----------------------------------------------
// Every posed joint pivot, read in the spine's own local frame (the same
// frame regardless of root tilt/lying-down poses, and the same frame the
// Joint Editor's own Position panel already reads/writes) — this is the
// "world map" coordinate set the Save button writes. Position only:
// rotations are still driven live by the pose data / sliders / manual
// joint-editor drags, untouched by this snapshot.
const JOINT_XYZ_KEYS_3D = [
  'spine',
  'leftShoulder', 'leftElbow', 'leftWrist', 'leftHandTurn',
  'rightShoulder', 'rightElbow', 'rightWrist', 'rightHandTurn',
  'leftHip', 'leftKnee', 'leftAnkle',
  'rightHip', 'rightKnee', 'rightAnkle',
];
function jointWorldPosSpineLocal3D(grp) {
  if (!grp || !rig3D.spine) return null;
  rig3D.spine.updateMatrixWorld(true);
  const w = new THREE.Vector3();
  grp.getWorldPosition(w);
  const p = rig3D.spine.worldToLocal(w);
  return { x: round2(p.x), y: round2(p.y), z: round2(p.z) };
}
// Reads every joint in JOINT_XYZ_KEYS_3D off the CURRENTLY rendered rig —
// call this right before pushing, never cached, so it always matches
// whatever's on screen at the moment Save is pressed.
function captureAllJointXYZ3D() {
  const out = {};
  JOINT_XYZ_KEYS_3D.forEach(key => {
    const pos = jointWorldPosSpineLocal3D(rig3D[key]);
    if (pos) out[key] = pos;
  });
  return out;
}

// ---- Cross-reload pose persistence (GitHub-backed) -------------------------
// Pushed edits (per-pose hand-facing overrides, manual joint-editor drags,
// and now each pose's joint-XYZ snapshot) are kept in one JSON file in your
// GitHub repo (owner/repo/branch/token configured in the GitHub Presets
// panel, using ghGetSettings/ghHeaders/ghUtf8ToB64/ghB64ToUtf8 from
// index.html's inline script) and pulled back down on top of the POSES3D
// literal once at load time (see pullPoseOverridesFromGitHub). This needs
// owner/repo/token filled in on the GitHub Presets panel — without them,
// edits still apply for the rest of this session, they just won't survive
// a reload.
const POSE_OVERRIDES_GH_PATH = 'presets/pose-overrides.json';
function poseOverridesApiUrl(s) {
  return `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${POSE_OVERRIDES_GH_PATH.split('/').map(encodeURIComponent).join('/')}`;
}
// GitHub's contents API can hand back a stale sha for a moment after a commit,
// so a quick second write fails with "does not match <sha>". Every write goes
// through this: fetch fresh (cache-busted), apply `mutate`, PUT, and on a sha
// mismatch wait a beat and retry.
async function githubUpdatePoseOverrides3D(message, mutate) {
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) throw new Error('Set your GitHub token in the GitHub Presets panel first (needed to save).');
  const apiUrl = poseOverridesApiUrl(s);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 500 * attempt));
    let sha, all = {};
    const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(s.branch)}&_=${Date.now()}`, { headers: ghHeaders(s.token), cache: 'no-store' });
    if (getResp.ok) {
      const j = await getResp.json();
      sha = j.sha;
      try { all = JSON.parse(ghB64ToUtf8(j.content)) || {}; } catch (e) { all = {}; }
    }
    mutate(all);
    const body = { message, content: ghUtf8ToB64(JSON.stringify(all, null, 2)), branch: s.branch };
    if (sha) body.sha = sha;
    const putResp = await fetch(apiUrl, { method: 'PUT', headers: ghHeaders(s.token), body: JSON.stringify(body) });
    if (putResp.ok) return all;
    const errj = await putResp.json().catch(() => ({}));
    lastErr = new Error(errj.message || putResp.statusText);
    if (!(putResp.status === 409 || putResp.status === 422 || /does not match|sha/i.test(lastErr.message))) throw lastErr;
  }
  throw lastErr;
}
// Wipes the saved pose-edits file from the repo and reloads, so POSES3D
// comes back purely from the hardcoded literal below with nothing re-applied
// on top — the escape hatch if a saved edit needs undoing back to original.
async function clearAllSavedPoseEdits() {
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) { alert('Set your GitHub token in the GitHub Presets panel first (needed to clear saved edits).'); return; }
  if (!confirm('Delete the pose-edits file from GitHub (hand-facing edits, joint XYZ snapshots AND saved 3D joint edits) and reload the page?')) return;
  try {
    const apiUrl = poseOverridesApiUrl(s);
    const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(s.branch)}`, { headers: ghHeaders(s.token) });
    if (getResp.status === 404) { location.reload(); return; } // nothing saved, nothing to clear
    if (!getResp.ok) throw new Error(getResp.statusText);
    const j = await getResp.json();
    const delResp = await fetch(apiUrl, { method: 'DELETE', headers: ghHeaders(s.token), body: JSON.stringify({ message: 'Clear saved pose edits', sha: j.sha, branch: s.branch }) });
    if (!delResp.ok) { const errj = await delResp.json().catch(() => ({})); throw new Error(errj.message || delResp.statusText); }
    location.reload();
  } catch (e) { alert('Could not clear pose edits from GitHub: ' + e.message); }
}
// Remembers the pose library's own literal hand-facing numbers (assigns
// into poseLiteralFacing3D, declared in hand-wrist-panel.js) so an override
// of 'default' can go back to them even after a saved edit has been
// layered on top. Called once, right after POSES3D is defined.
function capturePoseLiteralFacing3D() {
  if (poseLiteralFacing3D || typeof POSES3D === 'undefined') return;
  poseLiteralFacing3D = {};
  Object.keys(POSES3D).forEach(k => {
    poseLiteralFacing3D[k] = {};
    ['left', 'right'].forEach(side => {
      const r = POSES3D[k][side]; if (!r) return;
      const o = {};
      ['wristTurn', 'wrist', 'handRotation', 'wristRotation'].forEach(f => { if (r[f] !== undefined) o[f] = r[f]; });
      poseLiteralFacing3D[k][side] = o;
    });
  });
}
// Applies a parsed pose-overrides.json (everything except the joint-edit blob
// and each pose's jointXYZ snapshot, which nothing currently re-drives the
// rig from) on top of POSES3D.
function applyPoseOverridesData3D(all) {
  Object.keys(all).forEach(poseKey => {
    if (poseKey === '_jointEdits' || poseKey === '_handWristOverrides') return; // reserved blobs, handled separately
    const pose = POSES3D[poseKey];
    if (!pose) return;
    ['left', 'right'].forEach(side => {
      const fields = all[poseKey][side];
      if (!fields) return;
      pose[side] = pose[side] || {};
      Object.assign(pose[side], fields);
    });
  });
}
async function pullPoseOverridesFromGitHub() {
  capturePoseLiteralFacing3D();
  const s = ghGetSettings();
  // Reading only needs owner+repo (public-repo GETs work without a token);
  // token is only required to write. Requiring it here too is what made a
  // browser with no saved GitHub settings at all (e.g. incognito) silently
  // skip loading your saved edits and show the bare default pose instead —
  // looking exactly like the edits had never been saved.
  if (!s.owner || !s.repo) return;
  try {
    const resp = await fetch(`${poseOverridesApiUrl(s)}?ref=${encodeURIComponent(s.branch)}`, { headers: ghHeaders(s.token) });
    if (!resp.ok) return; // 404 = nothing saved yet; other errors fail quietly at load time
    const j = await resp.json();
    const all = JSON.parse(ghB64ToUtf8(j.content));
    poseOverridesCache3D = all;
    applyPoseOverridesData3D(all);
    // The overrides may have landed after the pose panel's first paint —
    // re-apply the currently-selected pose so any edit to it shows up.
    if (typeof applyPose3D === 'function' && sceneInited3D) applyPose3D(currentPose3D, { reframe: false });
    // Saved 3D-editor joint edits ride in the same file — load them right now
    // (no Load button needed).
    if (all._jointEdits) { jointEditsSaved3D = all._jointEdits; applySavedJointEdits3D(); }
    if (all._handWristOverrides) applyHandWristOverridesState3D(all._handWristOverrides);
  } catch (e) { console.warn('Could not load pose edits from GitHub:', e); }
}

// ---- ⬆ Save button (see quickSaveJointsToGitHub3D in joint-github-sync.js) ----
// That function does the actual push; captureAllJointXYZ3D above is what it
// reads from, right before pressing.
