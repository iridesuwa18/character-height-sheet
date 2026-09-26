// ── hand-wrist-panel.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Hand/Wrist Facing panel state — the live, pose-independent dropdown overrides (handRotationOverride/wristRotationOverride/etc.) and refreshHandWristButtons(), which keeps that panel's UI in sync.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

// ---- Hand / Wrist Facing panel — live, pose-independent overrides -------
// Lets a person click through the handRotation/wristRotation words above and
// see the result immediately on whichever hand(s) are selected, instead of
// having to guess a pose name or degree value. Sits on top of whatever the
// current named pose already set — Reset clears back to the pose's own
// values. Kept sticky across pose switches on purpose, so it's easy to try
// the same hand facing against several poses in a row.
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
// null = no override (pose default). Only meaningful on the fixed-angle
// path — a side driven by the new position-based pin/default system (see
// "New position-based hand pin + elbow system" below) already fully
// determines its own elbow from the wrist position, so overriding the
// elbow there would just fight that; applyPose3D skips both overrides
// whenever that side is position-driven.
let elbowBendOverride = { left: null, right: null };
let elbowLiftOverride = { left: null, right: null };
let handWristTargetSide = 'right';
// Saved 3D-editor joint edits (from presets/pose-overrides.json), cached so they
// can be re-applied automatically — on page load and after every model rebuild.
let jointEditsSaved3D = null;
let jointEditsInitialApplied3D = false;
let jointEditsFetching3D = false;
// Deep copy of the hard-coded pins taken before any saved file is applied, and
// the last saved file we saw — Reset uses these to get back to the saved state.
let poseLiteralFacing3D = null; // built-in wristTurn/wrist/handRotation/wristRotation per pose+side, before any saved edits
let poseLiteralPins3D = null;
let poseOverridesCache3D = null;
// Legacy "kept-position pin" wrist-rotation restore hook — always null now
// (nothing in the new position-based pin system sets it; hand facing is
// fully decoupled from position, see applyArmPosition3D), kept as inert
// dead state rather than touching the read site below.
let keptWristQuat3D = { left: null, right: null };
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
  const pinStatusEl = document.getElementById('pinStatusLine');
  if (pinStatusEl) {
    const pose = POSES3D[currentPose3D];
    const sides = handWristTargetSide === 'both' ? ['left', 'right'] : [handWristTargetSide];
    pinStatusEl.textContent = sides.map(s => {
      const label = s.charAt(0).toUpperCase() + s.slice(1);
      const ht = pose && pose[s] && pose[s].handTarget;
      if (!ht) return `${label}: not pinned`;
      return `${label}: pinned to ${describePin3D(ht)}`;
    }).join('  ·  ');
  }
  updateJePinStatus3D();
}

// ═══════════════════════════════════════════════════════════════════════
// New position-based hand pin + elbow system (replaces the old mesh-face
// click-to-pin / surface-normal / arm-IK system entirely — see the block
// comment above resolveHandAbsolutePos3D / applyArmPosition3D further down
// for the full design). Summary:
//   - Every side has a captured DEFAULT wrist/elbow/shoulder position (see
//     "Default Setter" below), taken from the rig while the body is built
//     at the reference measurements this project's poses were hand-tuned
//     against (BASELINE_SHOULDER_LENGTH_CM = 21.4cm shoulder length, same
//     for waist length, 175cm height, male).
//   - A hand can be pinned to a FACE of any of the fixed body meshes (head,
//     neck, torso, waist/hip, legs, feet) via two dropdowns: Pinned Mesh +
//     Pinned Face Part. Picking them does NOT move the hand — it just
//     records how far the hand currently is from that face (an xyz
//     offset). From then on the hand tracks that face 1:1 as the body
//     resizes: if the face moves 3cm, the hand moves the same 3cm.
//   - The elbow is never solved by IK anymore. It has its own default
//     position and always sits at "its default + however far the hand has
//     moved from ITS default" — then both segments (shoulder→elbow,
//     elbow→wrist) are re-aimed (never re-LENGTHed) to stay physically
//     rigid, which is the only thing that can gently move the hand off an
//     unreachable target ("to a minimum," never further than needed).
// ═══════════════════════════════════════════════════════════════════════

