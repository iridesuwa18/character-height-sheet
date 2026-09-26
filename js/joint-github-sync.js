// ── joint-github-sync.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Saves/loads the Joint Editor's own manual edits (manualJointEdits3D) to the same GitHub pose-overrides.json file, under the reserved "_jointEdits" key, plus bakeHandFacingIntoPose3D.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

// ============================================================================
// 3D EDITOR — QUICK GITHUB SAVE/LOAD
// ============================================================================
// A one-tap save/load for the joint editor's own state. It lives inside the
// SAME file as the pose edits (presets/pose-overrides.json) under one
// reserved top-level key, "_jointEdits", so there's a single save blob and a
// single auto-load on refresh. The pose-edit code above only touches real
// pose keys and preserves every other key when it re-writes the file, so the
// two never overwrite each other.
const JOINT_EDITS_KEY = '_jointEdits';

function collectJointEditsState3D() {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const q2a = (q) => q ? [r4(q.x), r4(q.y), r4(q.z), r4(q.w)] : null;
  const byPose = {};
  Object.keys(manualJointEdits3D).forEach(poseName => {
    const m = manualJointEdits3D[poseName];
    byPose[poseName] = {
      left:  { shoulderQuat: q2a(m.left.shoulderQuat),  elbowQuat: q2a(m.left.elbowQuat),  wristQuat: q2a(m.left.wristQuat) },
      right: { shoulderQuat: q2a(m.right.shoulderQuat), elbowQuat: q2a(m.right.elbowQuat), wristQuat: q2a(m.right.wristQuat) },
    };
  });
  return {
    pose: currentPose3D, // last-active pose — informational only, no longer used to force a pose switch on load
    manualJointEdits: byPose, // keyed by pose name: { [poseName]: { left: {...}, right: {...} } }
    // Hand Facing / Wrist dropdowns are saved per pose (see bakeHandFacingIntoPose3D), not here.
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
// Hand Facing / Wrist Facing dropdowns are saved PER POSE: on ⬆ Save the
// current override for each side is written into that pose's own record as raw
// wristTurn / wrist degrees (same fields the pose loader already re-applies),
// then the live override is cleared. Hand facing is fully independent of the
// position-based pin/Default Setter system now (see applyArmPosition3D) —
// pinned or not, every side saves the same way. Returns [{side, fields}] to push.
function bakeHandFacingIntoPose3D() {
  const pose = POSES3D[currentPose3D];
  const out = [];
  if (!pose) return out;
  const lit = (poseLiteralFacing3D && poseLiteralFacing3D[currentPose3D]) || {};
  ['left', 'right'].forEach(side => {
    pose[side] = pose[side] || {};
    const hv = handRotationOverride[side], wv = wristRotationOverride[side];
    const fields = {};
    if (hv === 'default') {
      // back to the built-in value: drop the saved fields, restore the literal ones
      ['wristTurn', 'handRotation', 'wristTurnEdit'].forEach(f => { delete pose[side][f]; fields[f] = null; if (lit[side] && lit[side][f] !== undefined) pose[side][f] = lit[side][f]; });
    } else if (ovSet(hv) && handOvDeg(side, hv) !== undefined) {
      fields.wristTurnEdit = round1(clampTurnFree(handOvDeg(side, hv)));
      pose[side].wristTurnEdit = fields.wristTurnEdit; delete pose[side].handRotation; fields.handRotation = null;
    }
    if (wv === 'default') {
      ['wrist', 'wristRotation'].forEach(f => { delete pose[side][f]; fields[f] = null; if (lit[side] && lit[side][f] !== undefined) pose[side][f] = lit[side][f]; });
    } else if (ovSet(wv) && wristOvDeg(wv) !== undefined) {
      fields.wrist = round1(clampWristBend(wristOvDeg(wv)));
      pose[side].wrist = fields.wrist; delete pose[side].wristRotation; fields.wristRotation = null;
    }
    // Swing was being silently discarded here: wristSwingOverride[side] gets
    // nulled out a few lines below on every save, but until now nothing ever
    // wrote its value into the saved pose first — so a mirrored/edited wrist's
    // swing looked right in-session but reverted to the pose's default swing
    // on the next reload. Bake it the same way Bend/Turn are baked above.
    const sv = wristSwingOverride[side];
    if (sv === 'default') {
      delete pose[side].wristSwing; fields.wristSwing = null;
    } else if (ovSet(sv)) {
      fields.wristSwing = round1(clampWristSwing(sv));
      pose[side].wristSwing = fields.wristSwing;
    }
    if (!Object.keys(fields).length) return;
    handRotationOverride[side] = null; wristRotationOverride[side] = null; wristSwingOverride[side] = null;
    out.push({ side, fields });
  });
  if (out.length) {
    jointEditorFacingSnapshot3D = { hand: Object.assign({}, handRotationOverride), wrist: Object.assign({}, wristRotationOverride), swing: Object.assign({}, wristSwingOverride) };
    refreshHandWristButtons();
    applyPose3D(currentPose3D, { reframe: false });
  }
  return out;
}
async function quickSaveJointsToGitHub3D() {
  if (typeof ghGetSettings !== 'function') { alert("GitHub save isn't available on this page."); return; }
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) { alert('Set your GitHub token in the GitHub Presets panel first (needed to save).'); return; }
  const btn = document.getElementById('jeQuickSaveBtn');
  const setBtn = (txt, disabled) => { if (btn) { btn.textContent = txt; btn.disabled = !!disabled; } };
  setBtn('Saving…', true);
  // Capture everything we're about to save SYNCHRONOUSLY, right now, before
  // any `await` runs. If we read this stuff after an await instead, a Cancel
  // click that lands in the gap reverts manualJointEdits3D/pose/facing first,
  // and we'd end up saving the reverted (pre-edit) state to GitHub — which is
  // exactly the bug where Save+Cancel silently saved the original pose.
  const poseKey = currentPose3D, pose = POSES3D[poseKey];
  const edits = [];
  for (const sd of ['left', 'right']) {
    if (jointEditorPinDirty3D[sd]) {
      clearTimeout(pinPushTimers3D[poseKey + '|' + sd]); delete pinPushTimers3D[poseKey + '|' + sd];
      const ht = pose && pose[sd] && pose[sd].handTarget;
      edits.push({ side: sd, fields: { handTarget: ht === undefined ? null : ht } });
    }
  }
  for (const e of bakeHandFacingIntoPose3D()) {
    const ex = edits.find(x => x.side === e.side);
    if (ex) Object.assign(ex.fields, e.fields); else edits.push(e);
  }
  const jointState = collectJointEditsState3D();
  // Re-baseline the editor's "revert to this" snapshots to what we're about
  // to save, right now while it's still fresh. This is what makes Cancel
  // safe to hit after a Save: from this point on, Cancel only undoes edits
  // made SINCE this save, not the whole editor session. Keep the old ones
  // around in case the save fails and we need to put them back.
  const preSaveModeSnapshot3D = jointEditorModeSnapshot3D;
  const preSaveFacingSnapshot3D = jointEditorFacingSnapshot3D;
  jointEditorModeSnapshot3D = cloneManualJointEdits3D(manualJointEdits3D);
  jointEditorFacingSnapshot3D = { hand: Object.assign({}, handRotationOverride), wrist: Object.assign({}, wristRotationOverride), swing: Object.assign({}, wristSwingOverride) };
  try {
    // Let any pin save already in flight finish, then do EVERYTHING (pins,
    // per-pose facing, joint edits) as ONE commit — several back-to-back
    // commits to the same file is what used to trip GitHub's sha check.
    await pinPushChain3D;
    const run = () => githubUpdatePoseOverrides3D('Quick save 3D joint edits', all => {
      edits.forEach(({ side, fields }) => {
        all[poseKey] = all[poseKey] || {};
        all[poseKey][side] = Object.assign({}, all[poseKey][side], fields);
        Object.keys(fields).forEach(k => { if (fields[k] === null && k !== 'handTarget') delete all[poseKey][side][k]; });
      });
      all[JOINT_EDITS_KEY] = jointState;
      // Default Setter data staged by pinning (see captureHandDefaultFromCurrent3D)
      // only actually gets written to GitHub here, on an explicit Save.
      if (pinDefaultsDirty3D.left || pinDefaultsDirty3D.right) all[PIN_DEFAULTS_KEY] = pinDefaults3D;
    });
    pinPushChain3D = pinPushChain3D.then(run, run);
    await pinPushChain3D;
    for (const sd of ['left', 'right']) jointEditorPinDirty3D[sd] = false;
    pinDefaultsDirty3D.left = false; pinDefaultsDirty3D.right = false;
    jointEditorPinCopySnapshot3D = null; // pins are saved now — Cancel shouldn't revert them
    jointEditsSaved3D = jointState; jointEditsInitialApplied3D = true;
    setBtn('✓ Saved', false);
    setTimeout(() => setBtn('⬆ Save', false), 1600);
  } catch (err) {
    // Save failed — the snapshots were re-baselined optimistically above, but
    // nothing actually reached GitHub, so put them back to how they were
    // before this attempt, otherwise Cancel would treat the failed edit as
    // already-saved and stop offering to undo it.
    jointEditorModeSnapshot3D = preSaveModeSnapshot3D;
    jointEditorFacingSnapshot3D = preSaveFacingSnapshot3D;
    alert('GitHub quick save failed: ' + err.message);
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
    if (all[PIN_DEFAULTS_KEY]) pinDefaults3D = all[PIN_DEFAULTS_KEY];
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
    if (all[PIN_DEFAULTS_KEY]) pinDefaults3D = all[PIN_DEFAULTS_KEY];
  } catch (e) { console.warn('Could not auto-load joint edits from GitHub:', e); }
  finally { jointEditsFetching3D = false; }
}
