// ── hand-wrist-panel.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Hand/Wrist Facing panel state — the live, pose-independent dropdown overrides (handRotationOverride/wristRotationOverride/etc.) and refreshHandWristButtons(), which keeps that panel's UI in sync.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

// ---- Hand / Wrist Facing panel — live, pose-independent overrides -------
// Lets a person click through the handRotation/wristRotation words above and
// see the result immediately on whichever hand(s) are selected, instead of
// having to guess a pose name or degree value. Sits on top of whatever the
// current named pose already set — Reset clears back to the pose's own
// values.
//
// PER-POSE: the variables below always hold the values for the pose that is
// currently selected. The values for every OTHER pose live in
// handWristByPose3D and are swapped in/out by switchHandWristPose3D whenever
// the selected pose changes (called from applyPose3D). So a Bend/Turn/Swing
// or elbow edit made on "Hands on Hips" is never seen by "Relaxed" or
// "Arms Out T Pose". (These used to be one global value shared by every pose,
// which is why an edit on one pose showed up on all of them.)
let handRotationOverride = { left: null, right: null };   // 'front'|'side'|'back'|null
let wristRotationOverride = { left: null, right: null };  // 'up'|'front'|'down'|null
let wristSwingOverride = { left: null, right: null };     // degrees (number) | null
// Elbow position overrides — raw degree numbers (not word aliases, unlike
// the two above) since there's no small fixed vocabulary for "where the
// elbow sits". elbowBendOverride replaces the pose's own `elbow` flexion
// angle outright; elbowLiftOverride is an ADDITIONAL shoulder-abduction
// amount stacked on top of whatever the wristTurn-overshoot auto-lift
// already contributes (see clampWristTurn), so a person can lift the elbow
// further without having to fight an out-of-range wristTurn to do it. Both
// null = no override (pose default).
let elbowBendOverride = { left: null, right: null };
let elbowLiftOverride = { left: null, right: null };
let handWristTargetSide = 'right';
// { [poseName]: { hand, wrist, swing, elbowBend, elbowLift } } — each a {left,right}.
// The CURRENT pose's live values are in the variables above, not here, until
// they're stashed by switchHandWristPose3D / collectHandWristOverridesState3D.
let handWristByPose3D = {};
const HW_FIELDS_3D = [
  ['hand', 'handRotationOverride'], ['wrist', 'wristRotationOverride'], ['swing', 'wristSwingOverride'],
  ['elbowBend', 'elbowBendOverride'], ['elbowLift', 'elbowLiftOverride'],
];
function liveHandWristSnapshot3D() {
  return {
    hand: { ...handRotationOverride }, wrist: { ...wristRotationOverride }, swing: { ...wristSwingOverride },
    elbowBend: { ...elbowBendOverride }, elbowLift: { ...elbowLiftOverride },
  };
}
function loadLiveHandWrist3D(entry) {
  const e = entry || {};
  const norm = (o) => ({ left: null, right: null, ...(o || {}) });
  handRotationOverride = norm(e.hand);
  wristRotationOverride = norm(e.wrist);
  wristSwingOverride = norm(e.swing);
  elbowBendOverride = norm(e.elbowBend);
  elbowLiftOverride = norm(e.elbowLift);
}
// Called by applyPose3D right BEFORE currentPose3D changes: park the outgoing
// pose's values, bring in the incoming pose's (or blanks if it has none).
function switchHandWristPose3D(newPose) {
  if (newPose === currentPose3D) return;
  handWristByPose3D[currentPose3D] = liveHandWristSnapshot3D();
  loadLiveHandWrist3D(handWristByPose3D[newPose]);
  refreshHandWristButtons();
}
// Full copy (map + live values) for the Joint Editor's Cancel button.
function snapshotHandWristAll3D() {
  const map = {};
  Object.keys(handWristByPose3D).forEach(k => { map[k] = JSON.parse(JSON.stringify(handWristByPose3D[k])); });
  map[currentPose3D] = liveHandWristSnapshot3D();
  return { map };
}
function restoreHandWristAll3D(snap) {
  if (!snap || !snap.map) return;
  handWristByPose3D = {};
  Object.keys(snap.map).forEach(k => { handWristByPose3D[k] = JSON.parse(JSON.stringify(snap.map[k])); });
  loadLiveHandWrist3D(handWristByPose3D[currentPose3D]);
}
function clearAllHandWristPoses3D() {
  handWristByPose3D = {};
  loadLiveHandWrist3D(null);
}
// Saved 3D-editor joint edits (from presets/pose-overrides.json), cached so they
// can be re-applied automatically — on page load and after every model rebuild.
let jointEditsSaved3D = null;
let jointEditsInitialApplied3D = false;
let jointEditsFetching3D = false;
// Built-in wristTurn/wrist/handRotation/wristRotation per pose+side, before
// any saved edits — captured once so an override of 'default' can go back
// to it (see literalFacing3D in char-constants.js and
// capturePoseLiteralFacing3D in hand-pins-github.js).
let poseLiteralFacing3D = null;
let poseOverridesCache3D = null;
// Snapshot of the last applyPose3D() call's fully-resolved per-side values
// (post-override, post-clamp) — see where it's written at the end of
// applyPose3D for exactly what it holds. null until the first pose is
// applied. Read by the Save button below.
let lastPoseResolved3D = null;

function setHandWristTargetSide(side) {
  handWristTargetSide = side;
  refreshHandWristButtons();
}
function setHandRotationInput(value) {
  const sides = handWristTargetSide === 'both' ? ['left', 'right'] : [handWristTargetSide];
  sides.forEach(s => { handRotationOverride[s] = value; });
  refreshHandWristButtons();
  if (sceneInited3D && meshRecords3D.length) applyPose3D(currentPose3D, { reframe: false });
}
function setWristRotationInput(value) {
  const sides = handWristTargetSide === 'both' ? ['left', 'right'] : [handWristTargetSide];
  sides.forEach(s => { wristRotationOverride[s] = value; });
  refreshHandWristButtons();
  if (sceneInited3D && meshRecords3D.length) applyPose3D(currentPose3D, { reframe: false });
}
// Elbow inputs are free-typed numbers rather than buttons, so there's no
// discrete "value" to toggle active — just parse-and-store, same
// side-targeting (right/left/both) as the hand/wrist word presets above.
// An empty/unparsable field clears that side's override back to null (pose
// default) rather than coercing to 0, which would otherwise be
// indistinguishable from an intentional "0°" override.
function setElbowBendInput(value) {
  const sides = handWristTargetSide === 'both' ? ['left', 'right'] : [handWristTargetSide];
  const num = value === '' ? null : parseFloat(value);
  const parsed = (num === null || isNaN(num)) ? null : num;
  sides.forEach(s => { elbowBendOverride[s] = parsed; });
  if (sceneInited3D && meshRecords3D.length) applyPose3D(currentPose3D, { reframe: false });
}
function setElbowLiftInput(value) {
  const sides = handWristTargetSide === 'both' ? ['left', 'right'] : [handWristTargetSide];
  const num = value === '' ? null : parseFloat(value);
  const parsed = (num === null || isNaN(num)) ? null : num;
  sides.forEach(s => { elbowLiftOverride[s] = parsed; });
  if (sceneInited3D && meshRecords3D.length) applyPose3D(currentPose3D, { reframe: false });
}
function clearHandWristOverrides() {
  handRotationOverride = { left: null, right: null };
  wristRotationOverride = { left: null, right: null };
  wristSwingOverride = { left: null, right: null };
  elbowBendOverride = { left: null, right: null };
  elbowLiftOverride = { left: null, right: null };
  delete handWristByPose3D[currentPose3D];
  refreshHandWristButtons();
  if (sceneInited3D && meshRecords3D.length) applyPose3D(currentPose3D, { reframe: false });
}
// ---- Persisting these overrides across reloads ---------------------------
// Saved as { byPose: { [poseName]: { hand, wrist, swing, elbowBend, elbowLift } } }
// — one entry per pose, same keying as _wristPins / manualJointEdits. This
// covers the wrist Bend/Turn/Swing sliders (which write here, not to a
// quaternion — see onWristSlider3D) and the elbow overrides.
// Older saves were ONE flat, pose-less block; applyHandWristOverridesState3D
// migrates that onto a single pose instead of letting it hit every pose.
function collectHandWristOverridesState3D() {
  const all = { ...handWristByPose3D, [currentPose3D]: liveHandWristSnapshot3D() };
  const byPose = {};
  Object.keys(all).forEach(poseName => {
    const e = all[poseName];
    const hasAny = HW_FIELDS_3D.some(([k]) => e[k] && (e[k].left != null || e[k].right != null));
    if (hasAny) byPose[poseName] = JSON.parse(JSON.stringify(e));
  });
  return { byPose };
}
// legacyPoseKey: which pose an old flat (pre-per-pose) save belongs to. Callers
// pass the pose the save was captured on (_jointEdits.pose); falls back to the
// pose on screen.
function applyHandWristOverridesState3D(state, legacyPoseKey) {
  if (!state) return;
  if (state.byPose) {
    handWristByPose3D = {};
    Object.keys(state.byPose).forEach(poseName => {
      const s = state.byPose[poseName] || {};
      handWristByPose3D[poseName] = {
        hand: s.hand, wrist: s.wrist, swing: s.swing, elbowBend: s.elbowBend, elbowLift: s.elbowLift,
      };
    });
  } else {
    // Legacy flat save -> attach to ONE pose only.
    const key = (legacyPoseKey && typeof POSES3D !== 'undefined' && POSES3D[legacyPoseKey]) ? legacyPoseKey : currentPose3D;
    handWristByPose3D = {};
    handWristByPose3D[key] = {
      hand: state.handRotationOverride, wrist: state.wristRotationOverride, swing: state.wristSwingOverride,
      elbowBend: state.elbowBendOverride, elbowLift: state.elbowLiftOverride,
    };
  }
  loadLiveHandWrist3D(handWristByPose3D[currentPose3D]);
  refreshHandWristButtons();
  if (sceneInited3D && meshRecords3D.length) applyPose3D(currentPose3D, { reframe: false });
}
// Which value to show as "active"/populated for the currently selected
// target side(s) — for 'both', only lit up (or filled in) when left and
// right actually agree; used for both the word-preset buttons (compared
// against a button's data-value) and the elbow number fields (dropped
// straight into the input's value).
function currentHandWristValue(overrideObj) {
  if (handWristTargetSide === 'both') {
    return overrideObj.left === overrideObj.right ? overrideObj.left : null;
  }
  return overrideObj[handWristTargetSide];
}
function refreshHandWristButtons() {
  document.querySelectorAll('.hw-side-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.side === handWristTargetSide);
  });
  const handVal = currentHandWristValue(handRotationOverride);
  document.querySelectorAll('.hw-hand-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === handVal);
  });
  const wristVal = currentHandWristValue(wristRotationOverride);
  document.querySelectorAll('.hw-wrist-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === wristVal);
  });
  const bendEl = document.getElementById('hwElbowBend');
  if (bendEl) {
    const bendVal = currentHandWristValue(elbowBendOverride);
    bendEl.value = (bendVal === null || bendVal === undefined) ? '' : bendVal;
  }
  const liftEl = document.getElementById('hwElbowLift');
  if (liftEl) {
    const liftVal = currentHandWristValue(elbowLiftOverride);
    liftEl.value = (liftVal === null || liftVal === undefined) ? '' : liftVal;
  }
}
