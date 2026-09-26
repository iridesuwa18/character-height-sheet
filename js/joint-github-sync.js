// ── joint-github-sync.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Saves/loads the Joint Editor's own
// manual drags (manualJointEdits3D) to the same GitHub pose-overrides.json
// file, under the reserved "_jointEdits" key. The ⬆ Save button
// (quickSaveJointsToGitHub3D, below) does two things on press: snapshot
// every joint's current XYZ position (captureAllJointXYZ3D, in
// hand-pins-github.js — a read-only baseline for a future pin system, not
// yet consumed on load) AND persist the current manualJointEdits3D rotation
// quaternions under "_jointEdits" — that second part is what actually
// reproduces the on-screen pose after a refresh, via applySavedJointEdits3D.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

const JOINT_EDITS_KEY = '_jointEdits';

function collectJointEditsState3D() {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const q2a = (q) => q ? [r4(q.x), r4(q.y), r4(q.z), r4(q.w)] : null;
  const byPose = {};
  Object.keys(manualJointEdits3D).forEach(poseName => {
    const m = manualJointEdits3D[poseName];
    byPose[poseName] = {
      left:  { shoulderQuat: q2a(m.left.shoulderQuat),  elbowQuat: q2a(m.left.elbowQuat),  wristQuat: q2a(m.left.wristQuat),  handTurnQuat: q2a(m.left.handTurnQuat) },
      right: { shoulderQuat: q2a(m.right.shoulderQuat), elbowQuat: q2a(m.right.elbowQuat), wristQuat: q2a(m.right.wristQuat), handTurnQuat: q2a(m.right.handTurnQuat) },
    };
  });
  return {
    pose: currentPose3D, // last-active pose — informational only, no longer used to force a pose switch on load
    manualJointEdits: byPose, // keyed by pose name: { [poseName]: { left: {...}, right: {...} } }
  };
}
function applyJointEditsState3D(jstate, { keepPose = false } = {}) {
  if (!jstate) return;
  const a2q = (a) => (Array.isArray(a) && a.length === 4) ? new THREE.Quaternion(a[0], a[1], a[2], a[3]) : null;
  const raw = jstate.manualJointEdits || {};
  // Backward-compat: older saves stored a single flat {left,right} object
  // (the very bug this per-pose keying fixes — it applied to every pose at
  // once) instead of {[poseName]: {left,right}}. Detect that old shape and
  // migrate it onto whichever pose it was captured for, instead of letting
  // it stick around under the wrong key forever.
  if (raw.left || raw.right) {
    const poseKey = (jstate.pose && typeof POSES3D !== 'undefined' && POSES3D[jstate.pose]) ? jstate.pose : currentPose3D;
    const je = jointEditsForPose3D(poseKey);
    ['left', 'right'].forEach(side => {
      const src = raw[side] || {};
      je[side].shoulderQuat = a2q(src.shoulderQuat);
      je[side].elbowQuat    = a2q(src.elbowQuat);
      je[side].wristQuat    = a2q(src.wristQuat);
      je[side].handTurnQuat = a2q(src.handTurnQuat);
    });
  } else {
    Object.keys(raw).forEach(poseName => {
      const src = raw[poseName] || {};
      const je = jointEditsForPose3D(poseName);
      ['left', 'right'].forEach(side => {
        const s = src[side] || {};
        je[side].shoulderQuat = a2q(s.shoulderQuat);
        je[side].elbowQuat    = a2q(s.elbowQuat);
        je[side].wristQuat    = a2q(s.wristQuat);
        je[side].handTurnQuat = a2q(s.handTurnQuat);
      });
    });
  }
  applyPose3D(currentPose3D, { reframe: !keepPose });
}
// Fetches pose-overrides.json (whole file). Returns { all, sha } — `all` is {}
// and sha undefined when the file doesn't exist yet.
async function fetchPoseOverridesFile(s) {
  const resp = await fetch(`${poseOverridesApiUrl(s)}?ref=${encodeURIComponent(s.branch)}&_=${Date.now()}`, { headers: ghHeaders(s.token), cache: 'no-store' });
  if (resp.status === 404) return { all: {}, sha: undefined };
  if (!resp.ok) throw new Error(resp.statusText);
  const j = await resp.json();
  let all = {};
  try { all = JSON.parse(ghB64ToUtf8(j.content)) || {}; } catch (e) { all = {}; }
  return { all, sha: j.sha };
}

// ---- ⬆ Save: snapshot every joint's current XYZ, push it, only on press ----
async function quickSaveJointsToGitHub3D() {
  if (typeof ghGetSettings !== 'function') { alert("GitHub save isn't available on this page."); return; }
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) { alert('Set your GitHub token in the GitHub Presets panel first (needed to save).'); return; }
  const btn = document.getElementById('jeQuickSaveBtn');
  const setBtn = (txt, disabled) => { if (btn) { btn.textContent = txt; btn.disabled = !!disabled; } };
  setBtn('Saving…', true);
  // Capture synchronously, right now, before any `await` runs — so a Cancel
  // click that lands in the gap can't revert the pose out from under the
  // read and save something other than what was actually on screen.
  const poseKey = currentPose3D;
  const jointXYZ = captureAllJointXYZ3D();
  const jointEditsState = collectJointEditsState3D();
  try {
    await githubUpdatePoseOverrides3D('Save joint XYZ + edits: ' + poseKey, all => {
      all[poseKey] = all[poseKey] || {};
      all[poseKey].jointXYZ = jointXYZ;
      // Also persist the rotation edits that actually drive the rig, so a
      // refresh restores what's on screen. jointXYZ alone can't do this —
      // it's a position snapshot with no consumer yet (see notes above);
      // the quaternion edits below are what applySavedJointEdits3D re-applies.
      all[JOINT_EDITS_KEY] = jointEditsState;
    });
    setBtn('✓ Saved', false);
    setTimeout(() => setBtn('⬆ Save', false), 1600);
  } catch (err) {
    alert('GitHub save failed: ' + err.message);
    setBtn('⬆ Save', false);
  }
}
async function quickLoadJointsFromGitHub3D() {
  if (typeof ghGetSettings !== 'function') { alert("GitHub load isn't available on this page."); return; }
  const s = ghGetSettings();
  // Only owner+repo are needed to read (see ghHeaders/pullPoseOverridesFromGitHub) — token is a write-only requirement.
  if (!s.owner || !s.repo) { alert('Set your GitHub owner and repo in the GitHub Presets panel first.'); return; }
  const btn = document.getElementById('jeQuickLoadBtn');
  const setBtn = (txt, disabled) => { if (btn) { btn.textContent = txt; btn.disabled = !!disabled; } };
  setBtn('Loading…', true);
  try {
    const { all } = await fetchPoseOverridesFile(s);
    if (!all[JOINT_EDITS_KEY]) throw new Error('No saved joint edits found yet.');
    jointEditsSaved3D = all[JOINT_EDITS_KEY]; jointEditsInitialApplied3D = true;
    applyJointEditsState3D(all[JOINT_EDITS_KEY]);
    reapplyManualJointEdits3D(); groundBody3D(false);
    if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
    setBtn('✓ Loaded', false);
    setTimeout(() => setBtn('⬇ Load', false), 1600);
  } catch (err) {
    alert('GitHub quick load failed: ' + err.message);
    setBtn('⬇ Load', false);
  }
}
// Auto-pulls the saved joint edits once, right after the 3D scene first
// builds (called from switchBodyView the first time the 3D view opens), so a
// refresh on any browser comes back with them applied. Quiet no-op if GitHub
// isn't configured or nothing's been saved yet.
// Stamps the cached saved joint edits onto the model. The first time it also
// restores the saved pose; after a later rebuild (Generate, depth sliders) it
// only puts the edits back and leaves whatever pose is showing alone.
function applySavedJointEdits3D() {
  if (!jointEditsSaved3D || !sceneInited3D || !rig3D || !rig3D.leftShoulder || !rig3D.rightShoulder) return;
  const first = !jointEditsInitialApplied3D;
  jointEditsInitialApplied3D = true;
  applyJointEditsState3D(jointEditsSaved3D, { keepPose: !first });
  reapplyManualJointEdits3D(); // works even before the editor has been opened
  groundBody3D(false);
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
}
// Fallback fetch (e.g. GitHub settings were filled in after page load). The
// normal path is pullPoseOverridesFromGitHub, which caches the same data.
async function autoLoadJointsFromGitHub3D() {
  if (jointEditsSaved3D) { if (!jointEditsInitialApplied3D) applySavedJointEdits3D(); return; }
  if (jointEditsFetching3D || typeof ghGetSettings !== 'function') return;
  const s = ghGetSettings();
  // Reading only needs owner+repo — see ghHeaders/pullPoseOverridesFromGitHub.
  if (!s.owner || !s.repo) return;
  jointEditsFetching3D = true;
  try {
    const { all } = await fetchPoseOverridesFile(s);
    if (all[JOINT_EDITS_KEY]) { jointEditsSaved3D = all[JOINT_EDITS_KEY]; applySavedJointEdits3D(); }
  } catch (e) { console.warn('Could not auto-load joint edits from GitHub:', e); }
  finally { jointEditsFetching3D = false; }
}
