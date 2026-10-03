// ── joint-github-sync.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Saves/loads the Joint Editor's own
// manual drags (manualJointEdits3D) to the same GitHub pose-overrides.json
// file, under the reserved "_jointEdits" key, plus per-pose distance-leash
// wrist pins (wristPinLocked3D — see joint-faces-panel.js) under
// "_wristPins", same per-pose-keyed pattern. The ⬆ Save button
// (quickSaveJointsToGitHub3D, below) does three things on press: snapshot
// every joint's current XYZ position (captureAllJointXYZ3D, in
// hand-pins-github.js — a read-only baseline for a future pin system, not
// yet consumed on load), persist the current manualJointEdits3D rotation
// quaternions under "_jointEdits" (what actually reproduces the on-screen
// pose after a refresh, via applySavedJointEdits3D), and persist
// wristPinLocked3D under "_wristPins" (what lets a pinned/leashed wrist
// come back pinned after a refresh, via applyWristPinsState3D).
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

const JOINT_EDITS_KEY = '_jointEdits';
const HAND_WRIST_OVERRIDES_KEY = '_handWristOverrides';
const WRIST_PINS_KEY = '_wristPins';
const WRIST_ATTACHMENTS_KEY = '_wristAttachments';

// Wrist attachments are stored per pose (facesWristAttachmentByPose3D in
// joint-faces-panel.js, { [poseName]: {left,right} }), same keying as
// collectWristPinsState3D just below. This is the "Attached Wrists"
// mesh-group/face/H%/V% dot data; it used to be entirely un-persisted, which
// is also why a reloaded leash-pinned wrist (see computeWristPinAdjustedChain3D
// in joint-faces-panel.js) could come back bent oddly — that function
// resolves its live dot straight from facesWristAttachment3D every frame, so
// a null attachment after reload silently dropped both the dot-tracking
// delta and the corrective final wrist-aim pass.
function collectWristAttachmentsState3D() {
  const byPose = {};
  Object.keys(facesWristAttachmentByPose3D).forEach(poseName => {
    const a = facesWristAttachmentByPose3D[poseName];
    if (!a.left && !a.right) return;
    byPose[poseName] = { left: a.left ? { ...a.left } : null, right: a.right ? { ...a.right } : null };
  });
  return byPose;
}
function applyWristAttachmentsState3D(state) {
  if (!state) return;
  // Per-pose format: { [poseName]: {left,right} }. Older saves were ONE flat
  // { left, right } shared by every pose — that has no pose name to go on, so
  // it's put on the pose showing now (the others start empty).
  const isLegacyFlat = ('left' in state || 'right' in state) && !Object.values(state).some(v => v && typeof v === 'object' && ('left' in v || 'right' in v));
  const next = {};
  if (isLegacyFlat) {
    next[currentPose3D] = { left: state.left ? { ...state.left } : null, right: state.right ? { ...state.right } : null };
  } else {
    Object.keys(state).forEach(poseName => {
      const a = state[poseName] || {};
      next[poseName] = { left: a.left ? { ...a.left } : null, right: a.right ? { ...a.right } : null };
    });
  }
  facesWristAttachmentByPose3D = next;
  if (typeof refreshWristAttachmentsForPoseChange3D === 'function') refreshWristAttachmentsForPoseChange3D();
  else if (typeof refreshFacesWristReadouts3D === 'function') refreshFacesWristReadouts3D();
}

// wristPinLocked3D (joint-faces-panel.js) is already keyed the same way
// manualJointEdits3D is — { [poseName]: { left, right } } — and every value
// inside a pin (x/y/z/turn/bend/swing/sx.../ex.../dox.../r/upperLen/
// foreLen/torsoHalfWidth) is a plain number or null, so unlike
// collectJointEditsState3D there's no quaternion encoding to do — just a
// shallow copy per side so the saved snapshot never aliases the live
// object a later PIN APPLY/CLEAR would go on to mutate.
function collectWristPinsState3D() {
  const byPose = {};
  Object.keys(wristPinLocked3D).forEach(poseName => {
    const p = wristPinLocked3D[poseName];
    byPose[poseName] = { left: p.left ? { ...p.left } : null, right: p.right ? { ...p.right } : null };
  });
  return byPose;
}
function applyWristPinsState3D(state) {
  if (!state) return;
  Object.keys(state).forEach(poseName => {
    const src = state[poseName] || {};
    wristPinsForPose3D(poseName).left = src.left ? { ...src.left } : null;
    wristPinsForPose3D(poseName).right = src.right ? { ...src.right } : null;
  });
  syncWristPinReadout3D();
}

function collectJointEditsState3D() {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const q2a = (q) => q ? [r4(q.x), r4(q.y), r4(q.z), r4(q.w)] : null;
  const byPose = {};
  Object.keys(manualJointEdits3D).forEach(poseName => {
    const m = manualJointEdits3D[poseName];
    byPose[poseName] = {
      left:  { shoulderQuat: q2a(m.left.shoulderQuat),  elbowQuat: q2a(m.left.elbowQuat),  wristQuat: q2a(m.left.wristQuat),  handTurnQuat: q2a(m.left.handTurnQuat),  kneeQuat: q2a(m.left.kneeQuat),  ankleQuat: q2a(m.left.ankleQuat) },
      right: { shoulderQuat: q2a(m.right.shoulderQuat), elbowQuat: q2a(m.right.elbowQuat), wristQuat: q2a(m.right.wristQuat), handTurnQuat: q2a(m.right.handTurnQuat), kneeQuat: q2a(m.right.kneeQuat), ankleQuat: q2a(m.right.ankleQuat) },
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
      je[side].kneeQuat     = a2q(src.kneeQuat);
      je[side].ankleQuat    = a2q(src.ankleQuat);
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
        je[side].kneeQuat     = a2q(s.kneeQuat);   // absent in older saves -> null (unchanged leg)
        je[side].ankleQuat    = a2q(s.ankleQuat);
      });
    });
  }
  applyPose3D(currentPose3D, { reframe: !keepPose });
}
// Fetches pose-overrides.json (whole file). Returns { all, sha } — `all` is {}
// and sha undefined when the file doesn't exist yet.
async function fetchPoseOverridesFile(s) {
  const resp = await fetch(`${poseOverridesApiUrl(s)}?ref=${encodeURIComponent(s.branch)}&_=${Date.now()}`, { headers: ghHeaders(s.token), cache: 'no-store' });
  if (resp.status === 404) { setSaveBaseline3D({}); return { all: {}, sha: undefined }; }
  if (!resp.ok) throw new Error(resp.statusText);
  const j = await resp.json();
  let all = {};
  try { all = JSON.parse(ghB64ToUtf8(j.content)) || {}; } catch (e) { all = {}; }
  setSaveBaseline3D(all);
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
  const handWristState = collectHandWristOverridesState3D();
  const wristPinsState = collectWristPinsState3D();
  const wristAttachmentsState = collectWristAttachmentsState3D();
  try {
    await githubUpdatePoseOverrides3D('Save joint XYZ + edits: ' + poseKey, all => {
      all[poseKey] = all[poseKey] || {};
      all[poseKey].jointXYZ = jointXYZ;
      // Also persist the rotation edits that actually drive the rig, so a
      // refresh restores what's on screen. jointXYZ alone can't do this —
      // it's a position snapshot with no consumer yet (see notes above);
      // the quaternion edits below are what applySavedJointEdits3D re-applies.
      all[JOINT_EDITS_KEY] = jointEditsState;
      // Wrist Bend/Turn/Swing (and the elbow overrides) write to their own
      // their own state instead of a quaternion — see onWristSlider3D — so
      // they need their own save/load, separate from the block above. Saved
      // PER POSE ({byPose:{[pose]:{...}}}) so one pose's wrist edits never
      // leak onto another.
      all[HAND_WRIST_OVERRIDES_KEY] = handWristState;
      // Distance-leash wrist pins (pinned XYZ, dot origin XYZ, R, and the
      // shoulder/elbow/torso snapshot the leash chain is built from — see
      // applyWristPin3D in joint-faces-panel.js), one set per pose, same
      // as JOINT_EDITS_KEY above.
      all[WRIST_PINS_KEY] = wristPinsState;
      // The Attached Wrists dot (mesh group + face + H/V%) itself — see the
      // comment above collectWristAttachmentsState3D for why this needs to
      // land BEFORE the wrist-pin leash math can trust its dot again.
      all[WRIST_ATTACHMENTS_KEY] = wristAttachmentsState;
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
    const hasJointEdits = !!all[JOINT_EDITS_KEY];
    const hasHandWrist = !!all[HAND_WRIST_OVERRIDES_KEY];
    const hasWristPins = !!all[WRIST_PINS_KEY];
    const hasWristAttachments = !!all[WRIST_ATTACHMENTS_KEY];
    if (!hasJointEdits && !hasHandWrist && !hasWristPins && !hasWristAttachments) throw new Error('No saved joint edits found yet.');
    if (hasJointEdits) {
      jointEditsSaved3D = all[JOINT_EDITS_KEY]; jointEditsInitialApplied3D = true;
      applyJointEditsState3D(all[JOINT_EDITS_KEY]);
      reapplyManualJointEdits3D(); groundBody3D(false);
    }
    if (hasHandWrist) applyHandWristOverridesState3D(all[HAND_WRIST_OVERRIDES_KEY], all[JOINT_EDITS_KEY] && all[JOINT_EDITS_KEY].pose);
    // Restore the Attached Wrists dot BEFORE the wrist-pin leash below runs
    // enforceWristPinConstraints3D — that function resolves its live dot
    // straight off facesWristAttachment3D, so loading it after would leave
    // the very first enforce pass computing against a null dot.
    if (hasWristAttachments) applyWristAttachmentsState3D(all[WRIST_ATTACHMENTS_KEY]);
    if (hasWristPins) {
      applyWristPinsState3D(all[WRIST_PINS_KEY]);
      // Re-enforce for the pose now on screen — same reasoning as the
      // applySavedJointEdits3D hook: a freshly-loaded pin needs its leash
      // applied immediately, not just sitting in wristPinLocked3D waiting
      // for the next unrelated applyPose3D call. Converge (not a single
      // pass): _jointEdits gets stamped onto the rig before this pin even
      // exists (see the ordering note above), so the wrist can start this
      // enforcement from a stale/incorrect quaternion — same capped-slerp
      // shortfall risk as the mirror path, see
      // enforceWristPinConstraintsConverge3D in joint-faces-panel.js.
      if (typeof enforceWristPinConstraintsConverge3D === 'function') {
        enforceWristPinConstraintsConverge3D();
      }
      groundBody3D(false);
    }
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
  // Re-enforce distance-leash wrist pins (see enforceWristPinConstraints3D
  // in joint-faces-panel.js) AFTER re-stamping saved edits above — this
  // runs straight after applyPose3D's own call to it inside buildBody3D
  // (see the hook there), and without repeating it here, any saved
  // shoulderQuat/elbowQuat for the current pose would silently overwrite
  // the fresh reach-clamp applyPose3D just computed, snapping a leashed
  // wrist back out of place on every rebuild (e.g. right after a
  // shoulder/waist-width Generate).
  if (typeof enforceWristPinConstraintsConverge3D === 'function') {
    enforceWristPinConstraintsConverge3D();
  }
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
    if (all[HAND_WRIST_OVERRIDES_KEY]) applyHandWristOverridesState3D(all[HAND_WRIST_OVERRIDES_KEY], all[JOINT_EDITS_KEY] && all[JOINT_EDITS_KEY].pose);
    // Same ordering requirement as quickLoadJointsFromGitHub3D above: the
    // attachment needs to exist before the wrist-pin block's
    // enforceWristPinConstraints3D call below resolves its live dot.
    if (all[WRIST_ATTACHMENTS_KEY]) applyWristAttachmentsState3D(all[WRIST_ATTACHMENTS_KEY]);
    if (all[WRIST_PINS_KEY]) {
      applyWristPinsState3D(all[WRIST_PINS_KEY]);
      if (typeof enforceWristPinConstraintsConverge3D === 'function') {
        enforceWristPinConstraintsConverge3D();
      }
      groundBody3D(false);
    }
  } catch (e) { console.warn('Could not auto-load joint edits from GitHub:', e); }
  finally { jointEditsFetching3D = false; }
}


// ---- Per-pose "save status" indicator (above the ⬆ Save button) ----------
// Compares the CURRENT pose's live edits (joint quaternions, hand/wrist
// overrides, wrist pin, attached-wrist dots — the same four things Save
// writes) against that pose's entry in the last-known saved file:
//   red    "No Save"              nothing saved for this pose yet
//   gold   "Please save changes"  saved, but what's on screen differs
//   green  "On latest save."      identical to the saved data
// saveBaseline3D is the whole pose-overrides.json as last read from / written
// to GitHub (see the setSaveBaseline3D calls in fetchPoseOverridesFile,
// pullPoseOverridesFromGitHub and githubUpdatePoseOverrides3D). null = not
// known yet (still loading, or GitHub unreachable) -> neutral grey.
let saveBaseline3D = null;
function setSaveBaseline3D(all) {
  saveBaseline3D = (all && typeof all === 'object') ? all : null;
  updateSaveStatus3D();
}
// Drops nulls / undefined / empty objects so "never touched" and "touched
// then cleared" compare equal, and old saves with explicit nulls match live
// state that simply has no entry.
function pruneSaveState3D(x) {
  if (x === null || x === undefined) return undefined;
  if (Array.isArray(x)) return x.map(v => (v === null || v === undefined) ? null : pruneSaveState3D(v));
  if (typeof x === 'object') {
    const o = {};
    Object.keys(x).forEach(k => { const v = pruneSaveState3D(x[k]); if (v !== undefined) o[k] = v; });
    return Object.keys(o).length ? o : undefined;
  }
  return x;
}
function saveStatesEqual3D(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.0006; // saves round quats to 4dp
  if (typeof a !== typeof b || (a === null) !== (b === null)) return false;
  if (typeof a !== 'object' || a === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => k in b && saveStatesEqual3D(a[k], b[k]));
}
// What the saved file holds for one pose, in the same shape poseLiveSaveState3D
// builds from the live rig. Handles the old flat (pre-per-pose) saves by
// putting them on the pose they were captured for, like the loaders do.
function poseSavedState3D(all, poseKey) {
  const je = all[JOINT_EDITS_KEY] || {};
  const rawEdits = je.manualJointEdits || {};
  const legacyPose = je.pose;
  let joints;
  if (rawEdits.left || rawEdits.right) joints = (legacyPose === poseKey) ? rawEdits : undefined;
  else joints = rawEdits[poseKey];
  const hw = all[HAND_WRIST_OVERRIDES_KEY];
  let handWrist;
  if (hw && hw.byPose) handWrist = hw.byPose[poseKey];
  else if (hw && legacyPose === poseKey) handWrist = { hand: hw.handRotationOverride, wrist: hw.wristRotationOverride, swing: hw.wristSwingOverride, elbowBend: hw.elbowBendOverride, elbowLift: hw.elbowLiftOverride };
  const pins = (all[WRIST_PINS_KEY] || {})[poseKey];
  const att = all[WRIST_ATTACHMENTS_KEY];
  let attach;
  if (att && ('left' in att || 'right' in att) && !Object.values(att).some(v => v && typeof v === 'object' && ('left' in v || 'right' in v))) attach = (legacyPose === poseKey) ? att : undefined;
  else attach = att ? att[poseKey] : undefined;
  return pruneSaveState3D({ joints, handWrist, pins, attach });
}
function poseLiveSaveState3D(poseKey) {
  return pruneSaveState3D({
    joints: (collectJointEditsState3D().manualJointEdits || {})[poseKey],
    handWrist: collectHandWristOverridesState3D().byPose[poseKey],
    pins: collectWristPinsState3D()[poseKey],
    attach: collectWristAttachmentsState3D()[poseKey],
  });
}
function poseSaveStatus3D(poseKey) {
  if (!saveBaseline3D) return 'unknown';
  const saved = poseSavedState3D(saveBaseline3D, poseKey);
  const entry = saveBaseline3D[poseKey];
  const hasSave = saved !== undefined || !!(entry && typeof entry === 'object' && entry.jointXYZ);
  if (!hasSave) return 'nosave';
  return saveStatesEqual3D(saved, poseLiveSaveState3D(poseKey)) ? 'latest' : 'dirty';
}
function updateSaveStatus3D() {
  const el = document.getElementById('jeSaveStatus');
  if (!el) return;
  let st = 'unknown';
  try { st = poseSaveStatus3D(currentPose3D); } catch (e) { st = 'unknown'; }
  const map = {
    unknown: ['', 'Save status unknown'],
    nosave:  ['nosave', 'No Save'],
    dirty:   ['dirty', 'Please save changes'],
    latest:  ['latest', 'On latest save.'],
  };
  const [cls, txt] = map[st];
  if (el.dataset.state === st) return;
  el.dataset.state = st; el.className = cls; el.textContent = txt;
}
// Edits happen through many paths (gizmo drags, typed fields, mirror, copy,
// pins, pose switches), so rather than hook each one, re-check twice a second
// while the editor is open. It's a cheap one-pose comparison.
setInterval(() => { if (typeof jointEditorModeActive3D !== 'undefined' && jointEditorModeActive3D) updateSaveStatus3D(); }, 500);
