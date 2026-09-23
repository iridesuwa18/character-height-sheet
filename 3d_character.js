// ═══════════════════════════════════════════════════════════════
// 3d_character.js
// Extrudes the 2D body-proportion boxes (Character Height Sheet, Body tab)
// into a real, orbit-able 3D model using Three.js.
//
// Depends on globals defined in index.html's inline script, which must load
// BEFORE this file: PX_PER_CM, SCALE_FACTOR, preview (the #preview element),
// leftArmWrap, rightArmWrap, and the GitHub Presets helpers ghGetSettings/
// ghHeaders/ghUtf8ToB64/ghB64ToUtf8 (used to save/load pose edits — see
// "Cross-reload pose persistence" below).
// Also depends on THREE and THREE.OrbitControls being loaded first.
//
// Called from index.html:
//   - generateHeight() calls buildBody3D() at the end of every Generate
//   - switchBodyView('3d'|'2d') toggles the #preview / #preview3D containers
//   - depth sliders call updateHeadDepth(value) / updateBodyDepth(value) /
//     updateWaistlinePct(value)
//   - the Recenter button calls recenterBody3D()
//   - the Pose panel buttons call setPose3D('pose-key') (see POSES3D below)
// ═══════════════════════════════════════════════════════════════
const CM_PER_PX_3D = 1 / (PX_PER_CM * SCALE_FACTOR);
// Depth is anchored to the head's own width for most parts, not each part's
// own width — so a wider torso/shoulder setting doesn't balloon the torso's
// front-to-back depth. Head depth = headDepthMult × head's own width. Torso,
// waist/hip box & legs = (bodyDepthMult × head's width) + 0.25 × that part's
// own width. Neck & arms are pinned to their OWN width instead (1.2×) — a
// thick torso shouldn't inflate a thin neck or arm. Hands are pinned to
// their own width too but flatter (0.5×). Feet are boosted further to ~2×
// their own width (real feet are longer than wide), with only the *extra*
// depth pushed forward so the heel stays aligned with the leg above it.
// See computeBodyDepth3D().
let headDepthMult = 1.1, bodyDepthMult = 0.6;
// % of the waist/hip box's own width used as the pinch point when the
// hourglass waistline split is drawn (100% = no pinch, a straight box).
let waistlinePct = 100;
let headWidthCm3D = 0;
const groupColor3D = {
  head:0xf0c040, neck:0xf0c040, torso:0xffff99, waistbox:0xff9db9,
  arms:0x9fc4ff, hands:0x9fc4ff, legs:0xc9c9d4, feet:0xc9c9d4, joint:0xf2f2f2
};
let scene3D=null, camera3D=null, renderer3D=null, controls3D=null, bodyGroup3D=null, poseRootGroup3D=null;
let sceneInited3D=false, animating3D=false;
let meshRecords3D=[]; // {mesh, group, wCm, hCm}
let rig3D={}; // pivot groups from the last build: leftHip/rightHip, leftKnee/rightKnee,
              // leftAnkle/rightAnkle, leftShoulder/rightShoulder, leftElbow/rightElbow

const deg2rad = d => d * Math.PI / 180;

// ---- Poses ----------------------------------------------------------------
// Every joint angle is in degrees and describes how far THAT joint bends
// relative to its own parent segment (hip relative to the fixed pelvis, knee
// relative to the thigh, ankle relative to the shin, elbow relative to the
// upper arm). Because every joint in a given chain rotates about the exact
// same world-aligned axis, angles down the chain simply ADD UP: thigh total
// = hip; shin total = hip+knee; foot total = hip+knee+ankle (same idea for
// the arm). 0° = hanging straight down (the T-pose/rest orientation); -90°
// swings a limb forward (toward the camera); +90° swings it back the other
// way. Knee and elbow flexion each have one fixed, anatomically-valid sign
// no matter what the parent joint is doing (POSITIVE for knees, NEGATIVE for
// elbows) — that's how "shin stays vertical" seated poses are built from two
// opposite numbers (hip:-90, knee:90 cancels back to hanging straight down).
// Ankle flexion is the same idea: NEGATIVE dorsiflexes the foot (toes lift
// toward the shin — the natural look for an extended leg), POSITIVE points
// the toes away from the shin (a pointed/plantarflexed foot).
//
// Two more axes exist beyond forward/back flexion:
//   hipAbd / shoulderAbd — swings the whole thigh/upper-arm out to the SIDE
//     (hip/shoulder abduction). Always give this as a POSITIVE number for
//     "away from the body's midline" — left and right are mirrored
//     automatically, so hipAbd:20 on both sides always splays both knees
//     outward, never inward.
//   ankleTurn — turns a foot in/out (like a turned-out stance), independent
//     of its flex.
//   hipTurn — rotates the whole leg about its own long axis (external/
//     internal hip rotation) — the missing piece for crossed-leg poses:
//     without it, a bent knee can only swing forward/back/out, never turn
//     enough for an ankle to rest up on the opposite knee.
//   shoulderRoll — rotates the whole upper arm about its own long axis
//     (external/internal shoulder rotation), the arm equivalent of hipTurn.
//     Give it a signed number the same way as hipTurn: it's applied straight
//     to whichever side's value you set (a shared value gets mirrored
//     automatically, +1 on the right side / -1 on the left). Without this,
//     the elbow can only hinge within whatever plane the shoulder happens to
//     be aimed at, so it can never independently aim the forearm/hand at a
//     target like "the temple" (salute) or "the hip" (hands on hips) — the
//     hand just follows wherever shoulder+elbow flex happen to add up to.
//     shoulderRoll re-aims that plane before the elbow bends within it.
//   wrist — hinges the hand at the wrist, same fixed sign convention as
//     elbow flexion (NEGATIVE curls the hand/palm inward, POSITIVE extends
//     it back). Without this the hand can only ever continue on as a rigid
//     extension of the forearm — which is why crossed arms, hands-on-hips,
//     and anything that tucks or rests a hand against the body used to look
//     wrong no matter how the shoulder/elbow were tuned.
//   wristTurn — rotates the hand about the forearm's own long axis (the
//     wrist's version of shoulderRoll), re-aiming which way the flat hand
//     block actually faces — palm down on a hip, palm-in tucked under an
//     opposite forearm, palms together when clasped, etc. Same signed/
//     mirrored convention as shoulderRoll/hipTurn.
//
// SHORTHAND FOR INSTRUCTING A POSE IN WORDS instead of raw degrees — use
// these when describing a new pose (to Claude or anyone else) so "which way
// is the hand twisted / bent" doesn't have to be guessed as a number:
//   handRotation: 'front' | 'side' | 'back' — coarse alias for wristTurn
//     (which way the flat hand block is twisted about the forearm's long
//     axis). front:0°, side:90°, back:180°. Give it per-side the same way
//     as any other field (e.g. right:{handRotation:'side'}).
//   wristRotation: 'up' | 'front' | 'down' — coarse alias for the wrist
//     hinge (`wrist`), i.e. which way the fingers point relative to the
//     forearm. front:0° (fingers continue the forearm's own direction),
//     up:+60° (wrist extended back, fingers lift up), down:-60° (wrist
//     curled/flexed, fingers drop down). Matches the wrist sign convention
//     above (negative curls inward, positive extends back).
// Either alias is just a preset for its raw numeric field — set wristTurn/
// wrist directly instead for a value the alias doesn't cover. If both are
// given, the raw numeric field wins.
//
// AUTHORING A NEW ARM POSE — work HAND FIRST, never from formulas alone:
//   1. Decide where the hand needs to end up and which way it should face
//      for the pose to actually read (e.g. crossed arms: each hand tucks
//      under the OPPOSITE forearm, palm toward the ribs — not just "elbow
//      bent, arm somewhere near the chest").
//   2. Set wrist/wristTurn FIRST to lock that hand position/orientation in.
//   3. Pick elbow next, purely to route the forearm from the shoulder to
//      that now-fixed hand — the elbow's job is to bridge, not to define
//      where the hand ends up.
//   4. shoulder/shoulderAbd/shoulderRoll then just connect shoulder → elbow;
//      they rarely need exotic values once the hand and elbow are already
//      right. Shoulder → Elbow → Hand, always in that bridging direction,
//      decided in hand → elbow → shoulder order.
//   Legs don't need this because their range of motion is small enough that
//   pure joint-angle math already looks natural; hands and arms don't, and
//   any pose that looks wrong here should have its hand re-anchored first,
//   not its shoulder/elbow numbers nudged blindly.
// Every pose can also bend the SPINE — spineBend (fold forward/back),
// spineSide (lean sideways) and spineTwist (rotate, e.g. "looking over a
// shoulder") — which carries the torso, head, neck and both arms together as
// a unit, pivoting at the waist; the pelvis and legs are unaffected. root /
// rootZ pitch/roll the WHOLE body (lying down, handstands, side-lying) and
// the model is automatically re-grounded afterward on whatever ends up
// lowest, so any combination is safe to use.
//
// Every field defaults to 0/straight. Give a joint a single shared value
// (e.g. `knee: 90`) to mirror it on both legs/arms, or add a `left:{...}` /
// `right:{...}` override for anything asymmetric (one leg up, a kick, a
// one-arm gesture, most "model" poses, etc). currentPose3D remembers the
// active pose so slider tweaks (which rebuild the whole mesh) can silently
// re-apply it instead of snapping back to a T-pose.
let currentPose3D = 'stand-relaxed';

// Reference shoulder length (cm) the fixed-angle "hands on hips" / "arms
// crossed" / etc. poses below were originally hand-tuned against. Fixed
// joint angles only put the hand in the right real-world spot (on the hip
// bone, on the opposite arm...) AT that one shoulder width — widen the
// shoulders and the same angles drift the hand off the body's actual
// surface. Rather than rescaling angles by this baseline, poses whose hand
// needs to stay ON a body surface are auto-converted (see
// HAND_LOCK_SIGNATURES below) to `handTarget`-driven IK instead, which
// re-solves against a mesh position every rebuild and is therefore correct
// at ANY shoulder length automatically — this constant is kept only as a
// documented reference point / for any future baseline-relative tuning.
const BASELINE_SHOULDER_LENGTH_CM = 21.4;

// Word-based presets for handRotation/wristRotation (see the comment block
// above) — coarse degree values an author can reach for instead of tuning
// wristTurn/wrist by trial and error.
// Side-aware: the LEFT hand's dorsum sits at +180°, the RIGHT hand's at
// -180° (see the canonical convention below) — a single shared table can't
// express both, so this used to leave the right hand always reading as
// "palm" no matter which button was pressed (0/90/180 are all >= -90).
const HAND_ROTATION_DEG = {
  left:  { front: 0, side: 90,  back: 180 },
  right: { front: 0, side: -90, back: -180 },
};
const WRIST_ROTATION_DEG = { front: 0, up: 60, down: -60 };

// ---- Wrist rotation-range limit -------------------------------------------
// A real forearm can only pronate/supinate so far on its own before the
// wrist runs out of twist — past that, turning the hand further needs the
// whole elbow to lift/rotate at the shoulder instead. Canonical range (see
// the wristTurn convention below): LEFT 0°(palm)↔180°(dorsum), RIGHT
// 0°(palm)↔-180°(dorsum). Anything a pose or override asks for beyond that
// gets clamped, and the clamped-off amount is handed to the shoulder as an
// "elbow lift" (extra abduction) so the pose still reads as reaching for
// the requested orientation instead of silently capping with no visual cue.
const WRIST_TURN_RANGE = { left: [0, 180], right: [-180, 0] };
const ELBOW_LIFT_PER_EXCESS_DEG = 0.4;   // how much shoulder-abd lift per degree of overshoot
const MAX_ELBOW_LIFT_DEG = 45;           // cap so a wildly out-of-range value can't fling the elbow overhead
function clampWristTurn(side, deg) {
  const [min, max] = WRIST_TURN_RANGE[side];
  const clamped = Math.min(max, Math.max(min, deg || 0));
  const overshoot = Math.abs((deg || 0) - clamped);
  const elbowLift = Math.min(MAX_ELBOW_LIFT_DEG, overshoot * ELBOW_LIFT_PER_EXCESS_DEG);
  return { clamped, elbowLift };
}

// ---- Forearm flip state (palm vs. dorsum) ----------------------------------
// A forearm is "flipped" when its hand is palm-side, "unflipped" when it's
// dorsum-side — colored red/blue on the forearm block, AND used to pick
// which edge the thumb sits on (see applyHandFlipVisuals3D), so the state
// reads consistently at a glance. CONFIRMED against the render (do not
// re-guess this):
//   default thumb position (wristTurn 0, right hand's thumb on the +x edge /
//   left hand's on the -x edge — see baseSign in applyHandFlipVisuals3D)
//   = RED = flipped = palm view.
//   The opposite thumb edge (wristTurn rotated toward dorsum)
//   = BLUE = unflipped = dorsum view.
// There is no separate per-pose flag for any of this — wristTurn is the
// single source of truth, so the thumb and the forearm color can never
// disagree with each other the way the old thumbFlip escape hatch allowed.
// Canonical wristTurn range (viewer looking at the model's POV, hand
// stretched ~15° from the body): 0° (palm) → 180° (dorsum) for the LEFT
// hand as it rotates toward the torso midline, and 0° (palm) → -180°
// (dorsum) for the RIGHT hand. A raw wristTurn value is classified by
// whichever endpoint (0 or ±180) it sits closer to, so poses authored
// before this convention existed still get a reasonable flip/color reading.
const FOREARM_FLIPPED_COLOR = 0xff4444;   // red  = flipped   = palm view
const FOREARM_UNFLIPPED_COLOR = 0x4488ff; // blue = unflipped = dorsum view
function isHandFlipped(side, wristTurnDeg) {
  const t = wristTurnDeg || 0;
  return side === 'left' ? t < 90 : t > -90;
}

// Applies the flip state (derived live from wristTurn, never authored) to
// every visual that reads it: the forearm's red/blue color AND the thumb's
// attachment edge, so the two can never fall out of sync with each other.
// Replaces the old thumbFlip escape hatch — a pose no longer needs to
// separately declare which edge its thumb belongs on; wristTurn alone
// decides both the color and the thumb's position/angle. Safe to call
// before the thumb/forearm exist yet (build order) since each ref is
// checked individually.
function applyHandFlipVisuals3D(side, wristTurnDeg) {
  const flipped = isHandFlipped(side, wristTurnDeg);
  rig3D[side + 'HandFlipped'] = flipped;
  const forearmMesh = rig3D[side + 'ForearmMesh'];
  if (forearmMesh) forearmMesh.material.color.setHex(flipped ? FOREARM_FLIPPED_COLOR : FOREARM_UNFLIPPED_COLOR);
  const thumbPivot = rig3D[side + 'ThumbPivot'];
  const thumbGeom = rig3D[side + 'ThumbGeom'];
  if (thumbPivot && thumbGeom) {
    // Base edge (thumb's home side ignoring flip): +x for the right hand,
    // -x for the left — matches the old default thumbSign. Flipped (palm)
    // keeps the thumb on that base edge; unflipped (dorsum) sends it to
    // the opposite edge.
    const baseSign = side === 'right' ? 1 : -1;
    const thumbSign = baseSign * (flipped ? 1 : -1);
    thumbPivot.position.x = thumbSign * thumbGeom.wCm * 0.42;
    thumbPivot.rotation.z = deg2rad(thumbSign * 35);
  }
}

// Expands a POSES3D entry (shared fields + optional left/right overrides)
// into the explicit per-side values applyPose3D() actually sets on the rig.
function expandPose3D(pose) {
  const L = pose.left || {}, R = pose.right || {};
  const pick = (side, key) => (side[key] !== undefined ? side[key] : (pose[key] || 0));
  // Same override order as pick() (side raw > side alias > pose raw > pose
  // alias > 0), but resolves a word alias (e.g. handRotation:'side') into
  // its degree value whenever the matching raw numeric field isn't given.
  const pickWithAlias = (side, rawKey, aliasKey, table) => {
    if (side[rawKey] !== undefined) return side[rawKey];
    if (side[aliasKey] !== undefined) return table[side[aliasKey]] || 0;
    if (pose[rawKey] !== undefined) return pose[rawKey];
    if (pose[aliasKey] !== undefined) return table[pose[aliasKey]] || 0;
    return 0;
  };
  return {
    hipL: pick(L, 'hip'), hipR: pick(R, 'hip'),
    hipAbdL: pick(L, 'hipAbd'), hipAbdR: pick(R, 'hipAbd'),
    hipTurnL: pick(L, 'hipTurn'), hipTurnR: pick(R, 'hipTurn'),
    kneeL: pick(L, 'knee'), kneeR: pick(R, 'knee'),
    ankleL: pick(L, 'ankle'), ankleR: pick(R, 'ankle'),
    ankleTurnL: pick(L, 'ankleTurn'), ankleTurnR: pick(R, 'ankleTurn'),
    shoulderL: pick(L, 'shoulder'), shoulderR: pick(R, 'shoulder'),
    shoulderAbdL: pick(L, 'shoulderAbd'), shoulderAbdR: pick(R, 'shoulderAbd'),
    shoulderRollL: pick(L, 'shoulderRoll'), shoulderRollR: pick(R, 'shoulderRoll'),
    elbowL: pick(L, 'elbow'), elbowR: pick(R, 'elbow'),
    wristL: pickWithAlias(L, 'wrist', 'wristRotation', WRIST_ROTATION_DEG),
    wristR: pickWithAlias(R, 'wrist', 'wristRotation', WRIST_ROTATION_DEG),
    wristTurnL: pickWithAlias(L, 'wristTurn', 'handRotation', HAND_ROTATION_DEG.left),
    wristTurnR: pickWithAlias(R, 'wristTurn', 'handRotation', HAND_ROTATION_DEG.right),
    spineBend: pose.spineBend || 0, spineSide: pose.spineSide || 0, spineTwist: pose.spineTwist || 0,
    root: pose.root || 0, rootZ: pose.rootZ || 0,
    // "Reach for this mesh" instead of a fixed angle — see the IK block
    // above applyPose3D uses this. Per-side override wins; a shared
    // top-level `handTarget` (or one injected automatically by
    // applyHandLockSignatures) applies to both hands, since symmetric
    // gestures like "hands on hips" want both hands tracking their own
    // side's mesh point identically.
    handTargetL: L.handTarget || pose.handTarget || null,
    handTargetR: R.handTarget || pose.handTarget || null,
  };
}

// ---- Hand / Wrist Facing panel — live, pose-independent overrides -------
// Lets a person click through the handRotation/wristRotation words above and
// see the result immediately on whichever hand(s) are selected, instead of
// having to guess a pose name or degree value. Sits on top of whatever the
// current named pose already set — Reset clears back to the pose's own
// values. Kept sticky across pose switches on purpose, so it's easy to try
// the same hand facing against several poses in a row.
let handRotationOverride = { left: null, right: null };   // 'front'|'side'|'back'|null
let wristRotationOverride = { left: null, right: null };  // 'up'|'front'|'down'|null
// Elbow position overrides — raw degree numbers (not word aliases, unlike
// the two above) since there's no small fixed vocabulary for "where the
// elbow sits". elbowBendOverride replaces the pose's own `elbow` flexion
// angle outright; elbowLiftOverride is an ADDITIONAL shoulder-abduction
// amount stacked on top of whatever the wristTurn-overshoot auto-lift
// already contributes (see clampWristTurn), so a person can lift the elbow
// further without having to fight an out-of-range wristTurn to do it. Both
// null = no override (pose default). Only meaningful on the fixed-angle
// path — an IK-driven arm (handTarget set) already fully determines its own
// elbow to keep the hand locked onto its target, so overriding the elbow
// there would just pull the hand off the mesh it's pinned to; applyPose3D
// skips both overrides whenever that side is IK-driven.
let elbowBendOverride = { left: null, right: null };
let elbowLiftOverride = { left: null, right: null };
let handWristTargetSide = 'right';
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
}

const round1 = n => Math.round((n || 0) * 10) / 10;

// ---- Cross-reload pose persistence (GitHub-backed) -------------------------
// Saving a pose (below) mutates the in-memory POSES3D object, which is
// enough to keep the edit for the rest of THIS page load, but a refresh
// re-runs this whole file from scratch and POSES3D goes back to its
// hardcoded literal below — so edits are also pushed to a JSON file in your
// GitHub repo (reusing the same owner/repo/branch/token configured in the
// GitHub Presets panel, and ghGetSettings/ghHeaders/ghUtf8ToB64/ghB64ToUtf8
// from index.html's inline script) and pulled back down on top of the
// literal once at load time (see pullPoseOverridesFromGitHub, called right
// after POSES3D is defined). This needs owner/repo/token filled in on the
// GitHub Presets panel — without them, edits still apply for the rest of
// this session, they just won't survive a reload.
const POSE_OVERRIDES_GH_PATH = 'presets/pose-overrides.json';
function poseOverridesApiUrl(s) {
  return `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${POSE_OVERRIDES_GH_PATH.split('/').map(encodeURIComponent).join('/')}`;
}
// Re-applies every saved edit on top of the POSES3D literal below — called
// once, right after that literal is defined. A pose key or field that no
// longer exists (e.g. this file's own POSES3D was edited/renamed since the
// edit was saved) is skipped harmlessly rather than throwing. Also does
// nothing quietly if the GitHub settings aren't filled in yet, or the file
// doesn't exist on the repo yet (first run). This is a network request, so
// unlike the old localStorage version it doesn't finish before the pose
// panel first renders — it re-applies on top a moment later instead.
async function pullPoseOverridesFromGitHub() {
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) return;
  try {
    const resp = await fetch(`${poseOverridesApiUrl(s)}?ref=${encodeURIComponent(s.branch)}`, { headers: ghHeaders(s.token) });
    if (!resp.ok) return; // 404 = nothing saved yet; other errors fail quietly at load time
    const j = await resp.json();
    const all = JSON.parse(ghB64ToUtf8(j.content));
    Object.keys(all).forEach(poseKey => {
      const pose = POSES3D[poseKey];
      if (!pose) return;
      ['left', 'right'].forEach(side => {
        const fields = all[poseKey][side];
        if (!fields) return;
        pose[side] = pose[side] || {};
        Object.assign(pose[side], fields);
      });
    });
    // The overrides may have landed after the pose panel's first paint —
    // re-apply the currently-selected pose so any edit to it shows up.
    if (typeof applyPose3D === 'function' && sceneInited3D) applyPose3D(currentPose3D, { reframe: false });
  } catch (e) { console.warn('Could not load pose edits from GitHub:', e); }
}
// Pushes one side's saved fields for one pose up to the GitHub file,
// merging with whatever's already saved for other poses/sides (fetches the
// current file first so this doesn't clobber edits saved from elsewhere).
async function pushPoseOverrideToGitHub(poseKey, side, fields) {
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) throw new Error('Fill in owner/repo/token in the GitHub Presets panel first.');
  const apiUrl = poseOverridesApiUrl(s);
  let sha, all = {};
  const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(s.branch)}`, { headers: ghHeaders(s.token) });
  if (getResp.ok) {
    const j = await getResp.json();
    sha = j.sha;
    try { all = JSON.parse(ghB64ToUtf8(j.content)); } catch (e) { all = {}; }
  }
  all[poseKey] = all[poseKey] || {};
  all[poseKey][side] = Object.assign({}, all[poseKey][side], fields);
  const body = { message: `Save pose edit: ${poseKey} (${side})`, content: ghUtf8ToB64(JSON.stringify(all, null, 2)), branch: s.branch };
  if (sha) body.sha = sha;
  const putResp = await fetch(apiUrl, { method: 'PUT', headers: ghHeaders(s.token), body: JSON.stringify(body) });
  if (!putResp.ok) { const errj = await putResp.json().catch(() => ({})); throw new Error(errj.message || putResp.statusText); }
}
// Wipes the saved pose-edits file from the repo and reloads, so POSES3D
// comes back purely from the hardcoded literal below with nothing re-applied
// on top — the escape hatch if a saved edit needs undoing back to original.
async function clearAllSavedPoseEdits() {
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) { alert('Fill in owner/repo/token in the GitHub Presets panel first.'); return; }
  if (!confirm('Delete the pose-edits file from GitHub and reload the page?')) return;
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

// Save button: bakes whatever the panel is CURRENTLY showing (pose defaults
// plus any active hand-rotation/wrist-rotation/elbow overrides) into
// POSES3D[currentPose3D] itself, as that pose's new permanent default —
// reading straight from lastPoseResolved3D so what gets saved always
// matches what's on screen, rather than re-deriving it from the overrides
// (which only capture what's been touched, not the pose's own baseline for
// whichever fields haven't been). Only touches wristTurn/wrist/elbow/
// shoulderAbd, so any handTarget (mesh pin) already on the pose is left
// exactly as authored — this is the "/pin" part of the panel state:
// nothing here overwrites it, it just isn't clobbered by the save either.
// An IK-driven side (has a handTarget) is skipped entirely: its hand
// position comes from solving against that target every rebuild, so baking
// in raw angle numbers here would leave dead fields the IK path ignores.
// Also pushes the same fields to a JSON file in your GitHub repo (see
// above) so the edit survives a page reload, not just the rest of this
// session — needs owner/repo/token filled in on the GitHub Presets panel.
async function savePoseFromHandWristPanel() {
  const pose = POSES3D[currentPose3D];
  if (!pose || !lastPoseResolved3D) return;
  const toPush = [];
  ['left', 'right'].forEach(side => {
    const resolved = lastPoseResolved3D[side];
    if (!resolved || resolved.isIK) return;
    pose[side] = pose[side] || {};
    pose[side].wristTurn = round1(resolved.wristTurn);
    pose[side].wrist = round1(resolved.wrist);
    pose[side].elbow = round1(resolved.elbow);
    pose[side].shoulderAbd = round1(resolved.shoulderAbd);
    // The values above are now the per-side source of truth going forward,
    // so drop any word-alias fields on this side that would otherwise still
    // take priority over a *shared* (non-side) raw field per expandPose3D's
    // pick order — they can't out-rank what we just wrote on the same side,
    // but leaving stale ones around is just confusing to read later.
    delete pose[side].handRotation;
    delete pose[side].wristRotation;
    toPush.push({ side, fields: {
      wristTurn: pose[side].wristTurn, wrist: pose[side].wrist,
      elbow: pose[side].elbow, shoulderAbd: pose[side].shoulderAbd,
    }});
  });
  // The pose's own numbers now already equal what the overrides were
  // producing, so clear the overrides — leaving them active would just be
  // silently re-applying the same values on top of their new home.
  handRotationOverride = { left: null, right: null };
  wristRotationOverride = { left: null, right: null };
  elbowBendOverride = { left: null, right: null };
  elbowLiftOverride = { left: null, right: null };
  refreshHandWristButtons();
  applyPose3D(currentPose3D, { reframe: false });
  const statusEl = document.getElementById('hwSaveStatus');
  if (statusEl) {
    statusEl.textContent = `Saving "${pose.label}" to GitHub…`;
    statusEl.style.opacity = '1';
    clearTimeout(statusEl._fadeTimer);
  }
  try {
    // Sequential, not Promise.all — each push does its own GET-modify-PUT
    // round trip against the same file, so running them in parallel could
    // let the second PUT clobber the first (stale sha).
    for (const { side, fields } of toPush) {
      await pushPoseOverrideToGitHub(currentPose3D, side, fields);
    }
    if (statusEl) {
      statusEl.textContent = `Saved "${pose.label}" — will reload from GitHub next time`;
      statusEl._fadeTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, 2600);
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = `Save to GitHub failed: ${e.message}`;
      statusEl._fadeTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, 4000);
    }
  }
}

const POSES3D = {
  // ── Standing ──────────────────────────────────────────────────────────
  'stand-relaxed':        { section:'Standing', label:'Relaxed' },
  'stand-arms-out':        { section:'Standing', label:'Arms Out (T-Pose)', shoulderAbd:85 },
  'stand-hands-hips':      { section:'Standing', label:'Hands on Hips', shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35 },
  'stand-arms-overhead':   { section:'Standing', label:'Arms Overhead', shoulder:-175, elbow:-5 },
  'stand-arms-crossed':    { section:'Standing', label:'Arms Crossed', shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80 },
  'stand-one-hand-hip':    { section:'Standing', label:'One Hand on Hip', right:{shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35} },
  'stand-weight-shift':    { section:'Standing', label:'Weight on One Hip', spineSide:6, right:{hipAbd:9}, left:{hipAbd:2} },
  'stand-hip-pop':         { section:'Standing', label:'Hip Pop', spineSide:10, right:{hipAbd:15}, left:{hipAbd:-2} },
  'stand-arms-behind':     { section:'Standing', label:'Arms Behind Back', shoulder:55, elbow:-90, wrist:-15, wristTurn:-90 },
  'stand-akimbo-overhead': { section:'Standing', label:'One Up, One on Hip', left:{shoulder:-170, elbow:-10, wrist:-10}, right:{shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35} },
  'stand-feet-apart':      { section:'Standing', label:'Feet Apart, Arms Crossed', hipAbd:14, shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80 },
  'stand-look-back':       { section:'Standing', label:'Looking Over Shoulder', spineTwist:35 },
  'stand-lean':            { section:'Standing', label:'Casual Lean', spineSide:-8, shoulder:-70, elbow:-105, shoulderAbd:8, wrist:-15, wristTurn:20 },
  'stand-point':           { section:'Standing', label:'Pointing Forward', right:{shoulder:-95, elbow:-10, wrist:5} },
  'stand-thinking':        { section:'Standing', label:'Chin in Hand', right:{shoulder:-40, shoulderAbd:0, shoulderRoll:-22, elbow:-155, wrist:10, wristTurn:65} },
  'stand-arms-open':       { section:'Standing', label:'Arms Wide Open', shoulder:20, shoulderAbd:60 },
  'stand-hands-head':      { section:'Standing', label:'Hands Behind Head', shoulder:-121, shoulderAbd:74, shoulderRoll:-41, elbow:-135, wrist:0, wristTurn:30 },
  'stand-pocket':          { section:'Standing', label:'Casual, One Hand Tucked', right:{shoulder:5, elbow:-130, wrist:-20, wristTurn:15} },
  'stand-turned-out':      { section:'Standing', label:'Feet Turned Out', hipAbd:8, ankleTurn:25 },
  'stand-soft-knee':       { section:'Standing', label:'Soft Bent Knee', right:{knee:14} },
  'stand-salute':          { section:'Standing', label:'Salute', right:{shoulder:-65, shoulderAbd:55, shoulderRoll:40, elbow:-155, wrist:15, wristTurn:-115} },

  // ── Standing — Dynamic & Action ──────────────────────────────────────
  'dyn-leg-up':      { section:'Standing — Dynamic', label:'Knee Raised', right:{hip:-45, knee:110, ankle:-30} },
  'dyn-flamingo':    { section:'Standing — Dynamic', label:'Flamingo Balance', right:{hip:-10, knee:150, ankle:-70}, shoulderAbd:45 },
  'dyn-high-kick':   { section:'Standing — Dynamic', label:'High Front Kick', right:{hip:-100, knee:8, ankle:-70}, left:{knee:10} },
  'dyn-side-kick':   { section:'Standing — Dynamic', label:'Side Kick', right:{hipAbd:80, knee:8, ankle:-40} },
  'dyn-back-kick':   { section:'Standing — Dynamic', label:'Back Kick', right:{hip:70, knee:110, ankle:20} },
  'dyn-lunge-fwd':   { section:'Standing — Dynamic', label:'Forward Lunge', right:{hip:-55, knee:70, ankle:-10}, left:{hip:60, knee:30, ankle:10} },
  'dyn-lunge-side':  { section:'Standing — Dynamic', label:'Side Lunge', right:{knee:70, hipAbd:55}, left:{hipAbd:-5} },
  'dyn-run-stride':  { section:'Standing — Dynamic', label:'Running Stride', right:{hip:-45, knee:90, ankle:-20, shoulder:55, elbow:-90, wrist:-10}, left:{hip:45, knee:60, ankle:10, shoulder:-45, elbow:-100, wrist:-10} },
  'dyn-jump-tuck':   { section:'Standing — Dynamic', label:'Jump, Tucked', hip:-55, knee:110, ankle:-30, shoulder:-60, elbow:-90 },
  'dyn-star-jump':   { section:'Standing — Dynamic', label:'Star Jump', hipAbd:35, shoulder:-30, shoulderAbd:75 },
  'dyn-arabesque':   { section:'Standing — Dynamic', label:'Arabesque', spineBend:-10, right:{hip:75, knee:5, ankle:10}, shoulderAbd:70 },
  'dyn-step-fwd':    { section:'Standing — Dynamic', label:'Stepping Forward', right:{hip:-35, knee:15, ankle:-10}, left:{hip:25, knee:5} },
  'dyn-ready-crouch':{ section:'Standing — Dynamic', label:'Athletic Ready Stance', hip:-45, knee:70, ankle:-25, shoulder:-30, elbow:-60, wrist:-15 },
  'dyn-punch':       { section:'Standing — Dynamic', label:'Throwing a Punch', spineTwist:-15, right:{shoulder:-95, elbow:-10, wrist:-5}, left:{shoulder:-20, elbow:-140, wrist:-20} },
  'dyn-spin':        { section:'Standing — Dynamic', label:'Mid-Spin', spineTwist:45, right:{hipAbd:15}, shoulderAbd:55 },
  'dyn-leap':        { section:'Standing — Dynamic', label:'Leaping Forward', right:{hip:-70, knee:20, ankle:-30}, left:{hip:50, knee:30, ankle:10}, shoulderAbd:60 },
  'dyn-knee-strike': { section:'Standing — Dynamic', label:'Knee Strike', right:{hip:-100, knee:150, ankle:20} },
  'dyn-victory-jump':{ section:'Standing — Dynamic', label:'Victory Jump', shoulder:-175, elbow:-5, hip:-15, knee:30 },
  'dyn-balance':     { section:'Standing — Dynamic', label:'Balancing, Arms Out', right:{hip:-15, knee:100, ankle:-40}, shoulderAbd:80 },
  'dyn-charge':      { section:'Standing — Dynamic', label:'Charging Forward', spineBend:20, right:{hip:-60, knee:50, ankle:-15}, left:{hip:40, knee:10, ankle:10}, shoulder:-40, elbow:-90, wrist:-10 },

  // ── Sitting (on a chair) ─────────────────────────────────────────────
  'sit-chair':          { section:'Sitting', label:'On a Chair', hip:-90, knee:90, ankle:-8, shoulder:-10, elbow:-40, wrist:-15 },
  'sit-cross-knee':     { section:'Sitting', label:'Legs Crossed at Knee', right:{hip:-60, knee:100, hipAbd:10, hipTurn:60, ankle:-30}, left:{hip:-90, knee:95, ankle:-8} },
  'sit-ankle-on-knee':  { section:'Sitting', label:'Ankle on Knee', right:{hip:-48, hipAbd:0, hipTurn:130, knee:108, ankle:-60}, left:{hip:-90, knee:95, ankle:-8} },
  'sit-lean-fwd':       { section:'Sitting', label:'Elbows on Knees', hip:-90, knee:90, ankle:-8, spineBend:65, shoulder:-69, shoulderAbd:-16, elbow:-45, wrist:-20 },
  'sit-lean-back':      { section:'Sitting', label:'Leaning Back, Relaxed', hip:-90, knee:90, ankle:-8, spineBend:-15, shoulder:10, elbow:-30, wrist:-15 },
  'sit-arms-crossed':   { section:'Sitting', label:'Arms Crossed', hip:-90, knee:90, ankle:-8, shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80 },
  'sit-hand-on-table':  { section:'Sitting', label:'One Arm Resting Forward', hip:-90, knee:90, ankle:-8, right:{shoulder:-80, elbow:-10, wrist:60}, left:{shoulder:5, elbow:-30, wrist:-15} },
  'sit-phone':          { section:'Sitting', label:'Looking at Phone', hip:-90, knee:90, ankle:-8, spineBend:12, shoulder:-70, elbow:-130, shoulderAbd:6, wrist:-70, wristTurn:-60 },
  'sit-thinking':       { section:'Sitting', label:'Thinking', hip:-90, knee:90, ankle:-8, spineBend:8, right:{shoulder:-40, shoulderAbd:0, shoulderRoll:-22, elbow:-155, wrist:10, wristTurn:65} },
  'sit-legs-apart':     { section:'Sitting', label:'Legs Apart', hip:-90, knee:90, ankle:-8, hipAbd:16 },
  'sit-legs-side':      { section:'Sitting', label:'Legs Tucked to the Side', hip:-90, knee:90, ankle:-8, spineTwist:15, hipAbd:35 },
  'sit-stretch-up':     { section:'Sitting', label:'Stretching Arms Up', hip:-90, knee:90, ankle:-8, spineBend:-8, shoulder:-175, elbow:-5 },
  'sit-hands-head':     { section:'Sitting', label:'Hands Behind Head', hip:-90, knee:90, ankle:-8, shoulder:-121, shoulderAbd:74, shoulderRoll:-41, elbow:-135, wrist:0, wristTurn:30 },
  'sit-chin-elbow':     { section:'Sitting', label:'Elbow on Knee, Chin in Hand', hip:-90, knee:90, ankle:-8, spineBend:55, right:{shoulder:-40, shoulderAbd:0, shoulderRoll:-22, elbow:-155, wrist:10, wristTurn:65}, left:{shoulder:-10, wrist:-15} },
  'sit-look-back':      { section:'Sitting', label:'Looking Back', hip:-90, knee:90, ankle:-8, spineTwist:40 },
  'sit-slouch':         { section:'Sitting', label:'Slouching', spineBend:-20, hip:-80, knee:100, shoulder:5 },
  'sit-one-leg-out':    { section:'Sitting', label:'One Leg Extended', right:{hip:-60, knee:25, ankle:-40}, left:{hip:-90, knee:95} },
  'sit-writing':        { section:'Sitting', label:'Writing at a Desk', hip:-90, knee:90, ankle:-8, spineBend:15, right:{shoulder:-60, elbow:-60, wrist:-50, wristTurn:-20}, left:{shoulder:-50, elbow:-30, wrist:-30} },
  'sit-reading':        { section:'Sitting', label:'Reading a Book', hip:-90, knee:90, ankle:-8, spineBend:10, shoulder:-65, elbow:-50, wrist:-45, wristTurn:20 },
  'sit-arm-on-back':    { section:'Sitting', label:'Arm Over Chair Back', hip:-90, knee:90, ankle:-8, right:{shoulder:65, elbow:-90, wrist:-20} },

  // ── Sitting on Something (stool / ledge) ─────────────────────────────
  'sit-perch':          { section:'Sitting on Something', label:'On a Stool/Ledge', hip:-75, knee:70, ankle:-15, shoulder:-15, elbow:-35, wrist:-15 },
  'perch-cross-ankle':  { section:'Sitting on Something', label:'Ankles Crossed', right:{hip:-75, knee:75, ankle:-8, hipTurn:15}, left:{hip:-70, knee:65, hipAbd:8, hipTurn:-15} },
  'perch-swing':        { section:'Sitting on Something', label:'Legs Swinging Forward', right:{hip:-55, knee:40, ankle:-30}, left:{hip:-80, knee:75} },
  'perch-grip-edge':    { section:'Sitting on Something', label:'Gripping the Edge', hip:-75, knee:70, ankle:-15, shoulder:35, elbow:-20, wrist:-55 },
  'perch-lean-back':    { section:'Sitting on Something', label:'Leaning Back on Hands', hip:-75, knee:70, ankle:-15, spineBend:-12, shoulder:60, elbow:-15, wrist:60 },
  'perch-foot-on-seat': { section:'Sitting on Something', label:'One Foot Up on the Seat', right:{hip:-95, knee:130, hipAbd:20, ankle:-20}, left:{hip:-80, knee:80} },
  'perch-arms-crossed': { section:'Sitting on Something', label:'Arms Crossed', hip:-75, knee:70, ankle:-15, shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80 },
  'perch-phone':        { section:'Sitting on Something', label:'Checking Phone', hip:-75, knee:70, ankle:-15, spineBend:10, shoulder:-65, elbow:-120, wrist:-70, wristTurn:-60 },
  'perch-legs-apart':   { section:'Sitting on Something', label:'Legs Apart', hip:-75, knee:70, ankle:-15, hipAbd:14 },
  'perch-look-side':    { section:'Sitting on Something', label:'Looking to the Side', hip:-75, knee:70, ankle:-15, spineTwist:30 },
  'perch-chin-rest':    { section:'Sitting on Something', label:'Chin Resting on Hand', hip:-75, knee:70, ankle:-15, right:{shoulder:-40, shoulderAbd:0, shoulderRoll:-22, elbow:-155, wrist:10, wristTurn:65} },
  'perch-lean-elbows':  { section:'Sitting on Something', label:'Forward Lean, Elbows on Knees', hip:-75, knee:70, ankle:-15, spineBend:70, shoulder:-69, shoulderAbd:-13, elbow:-45, wrist:-20 },
  'perch-casual-side':  { section:'Sitting on Something', label:'Casual Side Sit', hip:-75, knee:70, ankle:-15, spineTwist:15, hipAbd:20 },
  'perch-back-support': { section:'Sitting on Something', label:'One Arm Back for Support', hip:-75, knee:70, ankle:-15, right:{shoulder:50, elbow:-10, wrist:60}, left:{shoulder:-60, elbow:-90, wrist:-15} },
  'perch-legs-out':     { section:'Sitting on Something', label:'Legs Stretched Out', right:{hip:-40, knee:10, ankle:-60}, left:{hip:-80, knee:80} },
  'perch-hands-lap':    { section:'Sitting on Something', label:'Hands on Lap', hip:-75, knee:70, ankle:-15, shoulder:-5, elbow:-45, wrist:-15 },
  'perch-texting':      { section:'Sitting on Something', label:'Texting with Both Hands', hip:-75, knee:70, ankle:-15, shoulder:-60, elbow:-130, wrist:-70, wristTurn:-60 },
  'perch-adjust-shoe':  { section:'Sitting on Something', label:'Adjusting a Shoe', hip:-75, knee:70, ankle:-15, spineBend:40, right:{shoulder:-90, elbow:-100, wrist:-50} },
  'perch-slouch':       { section:'Sitting on Something', label:'Relaxed Slouch', spineBend:-18, hip:-65, knee:60 },
  'perch-cross-knee':   { section:'Sitting on Something', label:'Legs Crossed at Knee', right:{hip:-45, knee:95, hipAbd:8, hipTurn:55, ankle:-30}, left:{hip:-70, knee:68, ankle:-15} },

  // ── Sitting on the Floor ─────────────────────────────────────────────
  'sit-floor':          { section:'Sitting on the Floor', label:'Legs Out Front', hip:-90, knee:0, ankle:-80 },
  'floor-crisscross':   { section:'Sitting on the Floor', label:'Crisscross', hip:-100, knee:135, hipAbd:45, ankle:-10 },
  'floor-side-sit':     { section:'Sitting on the Floor', label:'Side Sit', right:{hip:-95, knee:130, hipAbd:10}, left:{hip:-90, knee:130, hipAbd:55} },
  'floor-knees-in':     { section:'Sitting on the Floor', label:'W-Sit', hip:-100, knee:155, hipAbd:-10 },
  'floor-one-extended': { section:'Sitting on the Floor', label:'One Leg Extended, One Bent', right:{hip:-90, knee:0, ankle:-80}, left:{hip:-95, knee:125, hipAbd:20} },
  'floor-hug-knees':    { section:'Sitting on the Floor', label:'Knees Hugged to Chest', hip:-125, knee:155, shoulder:-60, elbow:-140, wrist:-30 },
  'floor-kneel-up':     { section:'Sitting on the Floor', label:'Kneeling Upright', knee:155, ankle:-75 },
  'floor-seiza':        { section:'Sitting on the Floor', label:'Sitting on Heels', hip:-25, knee:165, ankle:-80 },
  'floor-half-kneel':   { section:'Sitting on the Floor', label:'Half-Kneeling', right:{knee:160, ankle:-75}, left:{hip:-70, knee:95, ankle:-20} },
  'floor-lean-back':    { section:'Sitting on the Floor', label:'Legs Out, Leaning Back on Hands', hip:-90, ankle:-80, spineBend:-25, shoulder:40, elbow:-10, wrist:60 },
  'floor-reach-fwd':    { section:'Sitting on the Floor', label:'Legs Out, Reaching Forward', hip:-95, knee:5, ankle:-75, spineBend:60, shoulder:-90, elbow:-10, wrist:-20 },
  'floor-side-lean':    { section:'Sitting on the Floor', label:'Leaning on One Hand', spineSide:20, right:{hip:-90, knee:125, hipAbd:30}, left:{hip:-85, knee:0, ankle:-70, shoulder:60, elbow:-15, wrist:60} },
  'floor-cross-behind': { section:'Sitting on the Floor', label:'Crisscross, Hands Behind', hip:-100, knee:135, hipAbd:40, shoulder:45, elbow:-15, wrist:60 },
  'floor-knee-hug-one': { section:'Sitting on the Floor', label:'One Knee Hugged', right:{hip:-110, knee:140, shoulder:-60, elbow:-140, wrist:-30}, left:{hip:-90, knee:0, ankle:-75} },
  'floor-phone':        { section:'Sitting on the Floor', label:'Crisscross, on Phone', hip:-100, knee:135, hipAbd:45, spineBend:15, shoulder:-65, elbow:-120, wrist:-70, wristTurn:-60 },
  'floor-child-pose':   { section:'Sitting on the Floor', label:"Child's Pose", hip:-150, knee:165, ankle:-80, spineBend:80, shoulder:-170, elbow:-5, wrist:-15 },
  'floor-mermaid':      { section:'Sitting on the Floor', label:'Mermaid Sit', spineTwist:20, right:{hip:-95, knee:150, hipAbd:65}, left:{hip:-90, knee:150, hipAbd:-10} },
  'floor-hands-back':   { section:'Sitting on the Floor', label:'Legs Out, Propped on Hands', hip:-85, knee:5, ankle:-70, spineBend:-15, shoulder:55, elbow:-10, wrist:60 },
  'floor-cross-lean':   { section:'Sitting on the Floor', label:'Ankles Crossed, Leaning In', hip:-95, knee:20, hipAbd:10, ankle:-60, spineBend:35 },
  'floor-kneel-reach':  { section:'Sitting on the Floor', label:'Kneeling, Reaching Up', knee:160, ankle:-75, spineBend:-10, shoulder:-175, elbow:-5 },

  // ── Squatting ─────────────────────────────────────────────────────────
  // Deep-squat baseline (~-125/145/-35) keeps the seat close to the ground
  // and the heel down; hipAbd controls whether the knees splay out or stay
  // tucked together, independent of the depth.
  'squat':              { section:'Squatting', label:'Squat, Knees Neutral', hip:-125, knee:145, ankle:-35, shoulder:-60, elbow:-90, wrist:-20 },
  'squat-knees-out':    { section:'Squatting', label:'Deep Squat, Knees Out', hip:-130, knee:150, ankle:-35, hipAbd:32, shoulder:60, elbow:-30, wrist:-45 },
  'squat-knees-in':     { section:'Squatting', label:'Squat, Knees Together', hip:-120, knee:140, ankle:-30, hipAbd:-8, shoulder:-55, elbow:-100, wrist:-20 },
  'squat-sumo':         { section:'Squatting', label:'Sumo Squat, Wide Stance', hip:-115, knee:135, ankle:-30, hipAbd:38, shoulder:60, elbow:-30, wrist:-45 },
  'squat-heels-up':     { section:'Squatting', label:'Squat, Heels Lifted', hip:-130, knee:155, ankle:15, shoulder:-40, elbow:-70, wrist:-20 },
  'squat-one-reach':    { section:'Squatting', label:'Squat, Reaching Forward', hip:-125, knee:145, ankle:-30, right:{shoulder:-90, elbow:0, wrist:-20}, left:{shoulder:20, elbow:-90, wrist:-15} },
  'squat-hands-clasped':{ section:'Squatting', label:'Squat, Hands Clasped', hip:-120, knee:140, ankle:-25, shoulder:-55, elbow:-100, wrist:-30, wristTurn:-90 },
  'squat-arms-up':      { section:'Squatting', label:'Squat, Arms Overhead', hip:-115, knee:130, ankle:-20, shoulder:-175, elbow:-5 },
  'squat-catcher':      { section:'Squatting', label:'Catcher Squat, Elbows on Knees', hip:-135, knee:155, ankle:-40, hipAbd:20, spineBend:30, shoulder:-57, shoulderAbd:-16, elbow:-40, wrist:-20 },
  'squat-pistol-prep':  { section:'Squatting', label:'One Leg Extended (Pistol Prep)', shoulderAbd:60, right:{hip:-90, knee:0, ankle:-70}, left:{hip:-135, knee:160, ankle:-40} },
  'squat-hands-ground': { section:'Squatting', label:'Squat, Hands on the Ground', hip:-140, knee:160, ankle:-45, shoulder:-95, elbow:-5, wrist:70 },
  'squat-tiptoe':       { section:'Squatting', label:'Squat, Balanced on Toes', hip:-115, knee:130, ankle:12, hipAbd:6 },
  'squat-knees-out-low':{ section:'Squatting', label:'Sitting on Heels, Knees Out', hip:-140, knee:170, ankle:-45, hipAbd:35 },
  'squat-look-up':      { section:'Squatting', label:'Squat, Looking Up', hip:-120, knee:140, ankle:-30, spineBend:-20 },
  'squat-lean-fwd':     { section:'Squatting', label:'Squat, Leaning Forward', hip:-125, knee:145, ankle:-35, spineBend:35, shoulder:35, elbow:-15, wrist:-15 },
  'squat-hands-hips':   { section:'Squatting', label:'Wide Squat, Hands on Hips', hip:-118, knee:135, ankle:-25, hipAbd:32, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35 },
  'squat-relaxed-wide': { section:'Squatting', label:'Relaxed Resting Squat', hip:-130, knee:150, ankle:-35, hipAbd:15, shoulder:-30, elbow:-70, wrist:-15 },
  'squat-shallow':      { section:'Squatting', label:'Shallow Squat', hip:-70, knee:80, ankle:-15 },
  'squat-pickup':       { section:'Squatting', label:'Picking Something Up', hip:-115, knee:135, ankle:-25, spineBend:15, shoulder:-100, elbow:-10, wrist:-30 },
  'squat-forearms-knee':{ section:'Squatting', label:'Resting Forearms on Knees', hip:-125, knee:145, ankle:-35, spineBend:30, shoulder:-57, shoulderAbd:-16, elbow:-40, wrist:-20 },

  // ── Stretching ────────────────────────────────────────────────────────
  'stretch-fold':       { section:'Stretching', label:'Standing Forward Fold', hip:-95, knee:5, ankle:-40, spineBend:90, shoulder:-90, elbow:-5, wrist:-15 },
  'stretch-toe-touch':  { section:'Stretching', label:'Toe Touch', hip:-90, ankle:-70, spineBend:100, shoulder:-100, wrist:-15 },
  'stretch-side-bend':  { section:'Stretching', label:'Side Bend', spineSide:35, right:{shoulder:-175, elbow:-5}, left:{shoulder:15, elbow:-20} },
  'stretch-overhead':   { section:'Stretching', label:'Overhead Reach', spineBend:-8, shoulder:-178, elbow:0 },
  'stretch-backbend':   { section:'Stretching', label:'Backbend', spineBend:-45, shoulder:-160, elbow:-10 },
  'stretch-quad':       { section:'Stretching', label:'Standing Quad Stretch', right:{hip:5, knee:150, ankle:20, shoulder:130, elbow:-150, wrist:-40} },
  'stretch-hamstring':  { section:'Stretching', label:'Hamstring Lunge Stretch', spineBend:50, right:{hip:-85, knee:0, ankle:-70}, left:{hip:60, knee:20, ankle:10} },
  'stretch-runner':     { section:'Stretching', label:"Runner's Lunge", right:{hip:-70, knee:75, ankle:-15}, left:{hip:70, knee:5, ankle:10} },
  'stretch-split-fwd':  { section:'Stretching', label:'Front Split', shoulderAbd:70, right:{hip:-85, knee:0, ankle:-70}, left:{hip:85, knee:0, ankle:20} },
  'stretch-split-side': { section:'Stretching', label:'Side Split', hipAbd:80, ankle:-10, shoulder:-95, elbow:-5 },
  'stretch-arm-cross':  { section:'Stretching', label:'Cross-Body Arm Stretch', right:{shoulder:-85, elbow:-30, shoulderAbd:-5}, left:{shoulder:-30, elbow:-90} },
  'stretch-tricep':     { section:'Stretching', label:'Overhead Tricep Stretch', right:{shoulder:-178, elbow:-150}, left:{shoulder:-20, elbow:-10} },
  'stretch-cat-cow':    { section:'Stretching', label:'Cat-Cow (Kneeling Arch)', spineBend:35, hip:-70, knee:95, shoulder:-90, elbow:-5, wrist:70 },
  'stretch-neck-side':  { section:'Stretching', label:'Side Neck/Spine Stretch', spineSide:20 },
  'stretch-figure-four':{ section:'Stretching', label:'Standing Figure-Four Stretch', right:{hip:-50, knee:100, hipAbd:35} },
  'stretch-wide-fold':  { section:'Stretching', label:'Seated Wide Forward Fold', hip:-90, knee:5, hipAbd:55, spineBend:75, shoulder:-90, elbow:-10, wrist:-15 },
  'stretch-calf':       { section:'Stretching', label:'Calf Stretch', shoulder:-60, elbow:-10, wrist:60, right:{hip:-25, knee:5, ankle:-40}, left:{hip:15, knee:5, ankle:15} },
  'stretch-shoulder':   { section:'Stretching', label:'Shoulder Stretch', right:{shoulder:-80, elbow:0, shoulderAbd:-10}, left:{shoulder:-20, elbow:-90} },
  'stretch-side-reach': { section:'Stretching', label:'Standing Side Reach, Both Arms', spineSide:15, shoulderAbd:70 },
  'stretch-lunge-twist':{ section:'Stretching', label:'Lunge with a Twist', spineTwist:-30, right:{hip:-55, knee:70, ankle:-10}, left:{hip:60, knee:30, ankle:10} },

  // ── Lying Down ────────────────────────────────────────────────────────
  'lie-back':           { section:'Lying Down', label:'On Back', shoulder:-10, root:-90 },
  'lie-back-starfish':  { section:'Lying Down', label:'On Back, Starfish', hipAbd:30, shoulderAbd:70, root:-90 },
  'lie-back-knee-up':   { section:'Lying Down', label:'On Back, One Knee Up', root:-90, right:{hip:-90, knee:110, ankle:-20} },
  'lie-back-overhead':  { section:'Lying Down', label:'On Back, Arms Overhead', root:-90, shoulder:-170, elbow:-5 },
  'lie-back-stomach':   { section:'Lying Down', label:'On Back, Hands on Stomach', root:-90, shoulder:35, elbow:-130, wrist:-30, wristTurn:60 },
  'lie-back-ankles-x':  { section:'Lying Down', label:'On Back, Ankles Crossed', root:-90, right:{hipAbd:8}, left:{hipAbd:-8} },
  'lie-back-knees-bent':{ section:'Lying Down', label:'On Back, Both Knees Bent', root:-90, hip:-90, knee:100, ankle:-10 },
  'lie-back-reading':   { section:'Lying Down', label:'On Back, Reading', root:-90, shoulder:-80, elbow:-90, wrist:-45, wristTurn:20, right:{hip:-40, knee:50} },
  'lie-back-legs-up':   { section:'Lying Down', label:'Legs Up the Wall', root:-90, hip:-90 },
  'lie-back-shoulderstand':{ section:'Lying Down', label:'Shoulder Stand', root:-95, hip:-100, shoulder:60, elbow:-90, wrist:60 },
  'lie-front':          { section:'Lying Down', label:'On Front', shoulder:-10, root:90 },
  'lie-front-chin':     { section:'Lying Down', label:'On Front, Propped on Elbows', root:90, shoulder:-150, elbow:-160, wrist:-20 },
  'lie-front-legs-bent':{ section:'Lying Down', label:'On Front, Legs Bent Up', root:90, right:{knee:130, ankle:-20} },
  'lie-front-overhead': { section:'Lying Down', label:'On Front, Arms Overhead', root:90, shoulder:-175, elbow:-5 },
  'lie-front-superman': { section:'Lying Down', label:'Superman Stretch', root:90, hip:15, knee:5, shoulder:-178, elbow:-5 },
  'lie-front-kick':     { section:'Lying Down', label:'On Front, Kicking Feet', root:90, right:{knee:100}, left:{knee:40} },
  'lie-side-curled':    { section:'Lying Down', label:'On Side, Curled Up', rootZ:88, hip:-90, knee:110, shoulder:-60, elbow:-110, wrist:-30 },
  'lie-side-relaxed':   { section:'Lying Down', label:'On Side, Relaxed', rootZ:88, hip:-25, knee:35, shoulder:35, elbow:-40, wrist:-15 },
  'lie-side-top-leg':   { section:'Lying Down', label:'On Side, Top Leg Forward', rootZ:88, right:{hip:-45, knee:45}, left:{hip:-10, knee:10} },

  // ── Handstand & Inversions ───────────────────────────────────────────
  // root:180 flips a standing pose upside down, so arms are posed as if
  // reaching OVERHEAD in a normal standing frame — once inverted, "overhead"
  // becomes "straight down to the ground", which is what actually supports
  // a handstand.
  'handstand':          { section:'Handstand & Inversions', label:'Straight Handstand', root:180, shoulder:175, elbow:-5, wrist:75 },
  'handstand-pike':     { section:'Handstand & Inversions', label:'Pike Handstand', root:180, shoulder:175, elbow:-5, hip:-70, knee:5, ankle:-20, wrist:75 },
  'handstand-split':    { section:'Handstand & Inversions', label:'Split Handstand', root:180, shoulder:175, elbow:-5, wrist:75, right:{hip:-25}, left:{hip:25} },
  'handstand-straddle': { section:'Handstand & Inversions', label:'Straddle Handstand', root:180, shoulder:175, elbow:-5, hipAbd:45, wrist:75 },
  'handstand-press':    { section:'Handstand & Inversions', label:'Bent-Arm Handstand Press', root:180, shoulder:160, elbow:-40, hip:-15, knee:10, wrist:70 },
  'handstand-one-arm':  { section:'Handstand & Inversions', label:'One-Arm Lean', root:180, hip:-10, right:{shoulder:175, elbow:-5, wrist:75}, left:{shoulder:70, elbow:-90, shoulderAbd:20, wrist:60} },
  'headstand':          { section:'Handstand & Inversions', label:'Headstand', root:180, shoulder:80, elbow:-90, shoulderAbd:20, wrist:-40, wristTurn:-90 },
  'headstand-pike':     { section:'Handstand & Inversions', label:'Headstand, Piked', root:180, shoulder:80, elbow:-90, shoulderAbd:20, hip:-60, knee:10, wrist:-40, wristTurn:-90 },
  'bridge-backbend':    { section:'Handstand & Inversions', label:'Bridge / Backbend', hip:-150, knee:120, ankle:-30, spineBend:-70, shoulder:170, elbow:-10, wrist:75 },
  'cartwheel-mid':      { section:'Handstand & Inversions', label:'Cartwheel, Mid-Motion', root:90, rootZ:45, hipAbd:60, shoulder:170, shoulderAbd:70 },
  'kick-up-prep':       { section:'Handstand & Inversions', label:'Kicking Up (Donkey Kick)', spineBend:85, shoulder:-90, elbow:-5, wrist:70, right:{hip:60, knee:20, ankle:20}, left:{hip:-95, knee:5, ankle:-60} },

  // ── Model Poses ──────────────────────────────────────────────────────
  'model-contrapposto': { section:'Model Poses', label:'Classic Contrapposto', spineSide:10, right:{hipAbd:14, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35}, left:{hipAbd:-3} },
  'model-hands-hips':   { section:'Model Poses', label:'Both Hands on Hips', spineSide:12, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35, right:{hipAbd:16} },
  'model-over-shoulder':{ section:'Model Poses', label:'Look Over Shoulder', spineTwist:45, spineSide:8 },
  'model-walk':         { section:'Model Poses', label:'Runway Stride', spineTwist:10, right:{hip:-30, knee:15, ankle:-15, shoulder:20}, left:{hip:35, knee:10, ankle:15, shoulder:-25} },
  'model-power':        { section:'Model Poses', label:'Power Stance, Arms Crossed', spineSide:-5, hipAbd:16, shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80 },
  'model-hair-flip':    { section:'Model Poses', label:'Hair Flip', spineSide:15, spineTwist:-15, right:{shoulder:-170, elbow:-30, wrist:-30, wristTurn:-20}, left:{shoulder:-10, elbow:-150, shoulderAbd:10} },
  'model-side-lean':    { section:'Model Poses', label:'Side Profile Lean', spineSide:20, right:{hipAbd:10}, left:{hipAbd:-14} },
  'model-editorial-crouch': { section:'Model Poses', label:'Editorial Crouch', spineBend:20, hip:-90, knee:110, hipAbd:20, ankle:-25, shoulder:-40, elbow:-70, wrist:-15 },
  'model-leg-point':    { section:'Model Poses', label:'Pointed Leg Forward', spineSide:8, right:{hip:-30, ankle:-70} },
  'model-glam-overhead':{ section:'Model Poses', label:'Glamour, Arms Overhead', spineSide:10, shoulder:-172, elbow:-15, right:{hipAbd:10} },
  'model-hand-face':    { section:'Model Poses', label:'Hand to Face', spineTwist:20, right:{shoulder:-60, shoulderAbd:22, elbow:-105, wrist:-35, wristTurn:-20} },
  'model-back-look':    { section:'Model Poses', label:'Back to Camera, Looking Back', spineTwist:70, right:{hipAbd:10} },
  'model-seated':       { section:'Model Poses', label:'Editorial Seated', spineTwist:20, hip:-90, knee:95, shoulder:-30, elbow:-80, wrist:-15, right:{hipAbd:22}, left:{hipAbd:-10} },
  'model-power-wide':   { section:'Model Poses', label:'Wide Power Stance', spineBend:-6, hipAbd:22, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35 },
  'model-runway-swing': { section:'Model Poses', label:'Runway Walk, Arms Swinging', right:{hip:-35, knee:10, shoulder:35}, left:{hip:30, knee:10, shoulder:-30} },
  'model-jacket-over':  { section:'Model Poses', label:'Jacket Over Shoulder', spineTwist:-15, right:{shoulder:60, elbow:-20, wrist:-40}, left:{shoulder:-40, elbow:-110, shoulderAbd:10, wrist:-15} },
  'model-lean-wall':    { section:'Model Poses', label:'Crossed Legs, Leaning', spineSide:18, shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80, right:{hipAbd:14}, left:{hip:8, hipAbd:-10} },
  'model-fierce-hips':  { section:'Model Poses', label:'Fierce, Hands on Hips', spineSide:-10, hipAbd:18, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35 },
  'model-collarbone':   { section:'Model Poses', label:'Elegant Hand at Collarbone', spineTwist:12, right:{shoulder:90, shoulderAbd:90, elbow:-158, wrist:-30, wristTurn:-20} },
  'model-dynamic-jump': { section:'Model Poses', label:'Dynamic Editorial Jump', spineSide:10, hipAbd:20, knee:20, shoulder:-40, shoulderAbd:65 },
};
// Re-apply any pose edits saved from a previous visit (see the Save button /
// GitHub helpers above). This is async (a network request), so — unlike the
// old localStorage version — it can't finish before the automatic hand-lock
// detection right below, the pose panel render at the bottom of the file, or
// the very first applyPose3D() call; those still run against the
// plain-literal defaults first, and pullPoseOverridesFromGitHub() re-applies
// the current pose on top once the fetch resolves a moment later.
pullPoseOverridesFromGitHub();


// ── Automatic hand-lock detection ───────────────────────────────────────
// "Does this hand need to stay in position (locked to a body surface), or
// is it loose (swinging/hovering, free to drift proportionally with the
// rest of the body)?" — rather than hand-annotating ~150 poses one by one,
// this recognizes the handful of exact shoulder/elbow/wrist angle
// combinations this file already reuses across many poses to mean the same
// real-world locked gesture (hands on hips, arms crossed over the chest...)
// and swaps them for the matching `handTarget` mesh-lock preset above.
// Anything NOT matching one of these signatures is left exactly as
// authored — a plain angle set with nothing to grab onto (an arm swinging
// at the side, reaching into open air overhead, a stretch) IS the "loose"
// case, and plain forward-kinematics angles already scale correctly with
// body size for those (nothing to snap onto means nothing to relock).
const HAND_LOCK_SIGNATURES = [
  // Hand flat on the hip (elbow bent back, wrist turned to lay it against
  // the hip bone) — 'stand-hands-hips', 'model-hands-hips', 'squat-hands-hips',
  // 'model-fierce-hips', 'model-power-wide', 'model-contrapposto', etc.
  { keys: ['shoulder', 'shoulderAbd', 'shoulderRoll', 'elbow', 'wrist', 'wristTurn'],
    values: [40, 25, -30, -80, -25, 35], handTarget: 'hip-side' },
  // Forearms folded across the chest so the hand lands on the OPPOSITE
  // upper arm — 'stand-arms-crossed', 'sit-arms-crossed', 'model-power', etc.
  { keys: ['shoulder', 'shoulderAbd', 'shoulderRoll', 'elbow', 'wrist', 'wristTurn'],
    values: [-5, 30, -70, -105, -70, 80], handTarget: 'opposite-shoulder' },
];
function signatureMatches3D(obj, sig) {
  return sig.keys.every((k, i) => (obj[k] || 0) === sig.values[i]);
}
function applyHandLockSignatures3D() {
  Object.values(POSES3D).forEach(pose => {
    [pose, pose.left, pose.right].forEach(side => {
      if (!side || side.handTarget) return; // already explicit
      const sig = HAND_LOCK_SIGNATURES.find(s => signatureMatches3D(side, s));
      if (sig) side.handTarget = sig.handTarget;
    });
  });
}
applyHandLockSignatures3D();

// Force the depth sliders back to their real defaults on every load — some
// browsers restore stale <input type=range> values from a previous session,
// which otherwise makes it look like the "default" depth silently drifted.
function resetDepthSlidersToDefault() {
  headDepthMult = 1.1; bodyDepthMult = 0.6; waistlinePct = 100;
  const headSlider = document.getElementById('depth-head'), headVal = document.getElementById('depth-head-val');
  const bodySlider = document.getElementById('depth-body'), bodyVal = document.getElementById('depth-body-val');
  const waistSlider = document.getElementById('waistline-pct'), waistVal = document.getElementById('waistline-pct-val');
  if (headSlider) headSlider.value = '1.1';
  if (headVal) headVal.textContent = '1.1×';
  if (bodySlider) bodySlider.value = '1.2';
  if (bodyVal) bodyVal.textContent = '1.2×';
  if (waistSlider) waistSlider.value = '100';
  if (waistVal) waistVal.textContent = '100%';
}
resetDepthSlidersToDefault();

// Pull the exact rendered geometry of every generated box (in cm, centered on the
// character's vertical midline, y=0 at the ground/PADDING_PX baseline). Also
// returns the shoulder pivot points and current arm-rotation state, measured
// with the arm rotation temporarily neutralized so widths/heights are the true,
// unrotated box sizes (not the larger diagonal bounding box of a rotated div).
function collectBodyBoxData3D() {
  // #preview must actually be laid out (not display:none) for
  // getBoundingClientRect() to return real sizes — unhide it for the
  // measurement if the 3D tab is the one currently showing.
  const wasPreviewHidden = preview.style.display === 'none';
  if (wasPreviewHidden) preview.style.display = 'flex';

  const savedLeftT = leftArmWrap ? leftArmWrap.style.transform : null;
  const savedRightT = rightArmWrap ? rightArmWrap.style.transform : null;
  if (leftArmWrap) leftArmWrap.style.transform = 'rotate(0deg)';
  if (rightArmWrap) rightArmWrap.style.transform = 'rotate(0deg)';

  const previewRect = preview.getBoundingClientRect();
  const toCm = (r) => ({
    xCm: (r.left - previewRect.left + r.width/2 - previewRect.width/2) * CM_PER_PX_3D,
    bottomCm: (previewRect.bottom - r.bottom) * CM_PER_PX_3D,
    wCm: r.width * CM_PER_PX_3D,
    hCm: r.height * CM_PER_PX_3D
  });

  const boxEls = preview.querySelectorAll('.head-box, .neck-box, .torso-box, .waist-box, .leg-box');
  const boxes = [];
  boxEls.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return; // skip the zero-width divider div
    const group = el.dataset.group || 'other';
    const side = leftArmWrap && leftArmWrap.contains(el) ? 'left'
               : rightArmWrap && rightArmWrap.contains(el) ? 'right' : null;
    boxes.push({ group, side, ...toCm(r) });
  });

  // Shoulder pivot points — the wrap is a 0×0 div, so its rect is just a point.
  const leftPivot = leftArmWrap ? toCm(leftArmWrap.getBoundingClientRect()) : null;
  const rightPivot = rightArmWrap ? toCm(rightArmWrap.getBoundingClientRect()) : null;

  if (leftArmWrap) leftArmWrap.style.transform = savedLeftT;
  if (rightArmWrap) rightArmWrap.style.transform = savedRightT;
  if (wasPreviewHidden) preview.style.display = 'none';

  const armRotated = document.getElementById('opt-armrotate')?.checked || false;
  return { boxes, leftPivot, rightPivot, armRotated };
}

function initScene3D() {
  if (sceneInited3D) return;
  const canvas = document.getElementById('body3DCanvas');
  const container = document.getElementById('preview3D');
  scene3D = new THREE.Scene();
  scene3D.background = new THREE.Color(0x161618);

  camera3D = new THREE.PerspectiveCamera(45, container.clientWidth/container.clientHeight, 0.1, 5000);
  camera3D.position.set(0, 100, 350);

  renderer3D = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
  renderer3D.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer3D.setSize(container.clientWidth, container.clientHeight);

  controls3D = new THREE.OrbitControls(camera3D, renderer3D.domElement);
  controls3D.enableDamping = true;
  controls3D.dampingFactor = 0.08;
  controls3D.screenSpacePanning = true;
  controls3D.minDistance = 20;
  controls3D.maxDistance = 2000;

  scene3D.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.1));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(150, 300, 250);
  scene3D.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dirLight2.position.set(-150, 100, -200);
  scene3D.add(dirLight2);

  bodyGroup3D = new THREE.Group();
  poseRootGroup3D = new THREE.Group();
  poseRootGroup3D.add(bodyGroup3D);
  scene3D.add(poseRootGroup3D);

  window.addEventListener('resize', resizeBody3D);
  sceneInited3D = true;
  animate3D();
}

function resizeBody3D() {
  if (!sceneInited3D) return;
  const container = document.getElementById('preview3D');
  if (container.style.display === 'none') return;
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  camera3D.aspect = w/h; camera3D.updateProjectionMatrix();
  renderer3D.setSize(w, h);
}

function animate3D() {
  requestAnimationFrame(animate3D);
  if (!sceneInited3D || document.getElementById('preview3D').style.display === 'none') return;
  controls3D.update();
  renderer3D.render(scene3D, camera3D);
}

// Recursively frees GPU resources for a mesh/group tree before it's discarded.
function disposeObject3D(obj) {
  obj.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material.dispose();
    }
  });
}

function makeBoxMesh(b, depthCm) {
  const geo = new THREE.BoxGeometry(b.wCm, b.hCm, depthCm);
  const mat = new THREE.MeshStandardMaterial({
    color: groupColor3D[b.group] || 0xaaaaaa, roughness: 0.6, metalness: 0.05,
    transparent: true, opacity: 0.92
  });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.35 }));
  mesh.add(edges);
  return mesh;
}

// A trapezoidal prism: width tapers linearly from bottomWidthCm (at local
// y=0) to topWidthCm (at local y=heightCm); depth (z) is constant. Centered
// on its own local origin exactly like BoxGeometry, so it drops into the
// same mesh.position.set(x,y,z) flow. Used for the hourglass waistline split.
function makeTrapezoidMesh(topWidthCm, bottomWidthCm, heightCm, depthCm, colorHex) {
  const shape = new THREE.Shape();
  shape.moveTo(-bottomWidthCm/2, 0);
  shape.lineTo(bottomWidthCm/2, 0);
  shape.lineTo(topWidthCm/2, heightCm);
  shape.lineTo(-topWidthCm/2, heightCm);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: depthCm, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, -heightCm/2, -depthCm/2);
  const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.6, metalness: 0.05, transparent: true, opacity: 0.92 });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.35 }));
  mesh.add(edges);
  return mesh;
}

// A joint sphere, diameter matched to the depth of the part(s) it connects.
function makeJointSphere(diameterCm) {
  const geo = new THREE.SphereGeometry(Math.max(diameterCm, 0.01) / 2, 16, 12);
  const mat = new THREE.MeshStandardMaterial({ color: groupColor3D.joint, roughness: 0.5, metalness: 0.05, transparent: true, opacity: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.2 }));
  mesh.add(edges);
  return mesh;
}

// Feet get boosted to ~this multiple of their own width for front-to-back depth.
const FOOT_DEPTH_WIDTH_MULT = 2;

// Depth (and, for feet, the forward z-shift needed to keep the heel aligned
// with the leg above it) for a body box, given the current sliders. Neck and
// arms are pinned to their OWN width — a thick torso/shoulder setting
// shouldn't inflate a thin neck's or arm's depth. Hands are pinned to their
// own width too, but flatter — half their width — since a hand is a flat shape.
function computeBodyDepth3D(b) {
  if (b.group === 'neck' || b.group === 'arms') return { depthCm: 1.2 * b.wCm, zOffset: 0 };
  if (b.group === 'hands') return { depthCm: 0.5 * b.wCm, zOffset: 0 };
  const normalDepthCm = bodyDepthMult * headWidthCm3D + 0.25 * b.wCm;
  if (b.group !== 'feet') return { depthCm: normalDepthCm, zOffset: 0 };
  const footDepthCm = FOOT_DEPTH_WIDTH_MULT * b.wCm;
  const depthCm = Math.max(normalDepthCm, footDepthCm);
  return { depthCm, zOffset: (depthCm - normalDepthCm) / 2 };
}

// ── Simple 2-bone arm IK ────────────────────────────────────────────────
// Lets a pose say "reach for this point on the head/torso mesh" instead of
// baking in fixed joint angles that only look right at one body size. Given
// the shoulder's position, a target point, and the actual (current) upper
// arm / forearm lengths, this solves for the shoulder's full orientation
// plus the elbow bend needed to put the WRIST exactly at that point — so it
// stays correct as shoulder width / arm length change.
//
// Why this needs the shoulder's full orientation (not just "aim the upper
// arm at roughly the right spot"): the elbow is a plain hinge, so it can
// only bend within whichever plane the shoulder's own twist has already
// set up. Picking flex/z to aim the upper arm while leaving that twist
// (the old "shoulderRoll") as a free/authored number means the elbow's
// hinge plane usually does NOT contain the target — the forearm swings
// off to the side and misses. So instead of fixing the twist, this SOLVES
// for it: the twist is exactly whatever's needed to put the elbow's hinge
// axis perpendicular to the shoulder/elbow/target plane, which is what
// actually guarantees an exact reach (verified numerically against the
// real chain: zero reach error across a wide range of shoulder widths and
// arm lengths). A "pole" direction — a rough "which way should the elbow
// point" hint — is still needed to pick which of the two possible planes
// (elbow out this way vs. that way) to use.
//
// ikContext3D is filled in during buildBody3D/buildArmSide with whatever
// current geometry (shoulder positions, arm segment lengths, head box) an
// IK-driven pose needs, so it always reflects the body size on screen.
let ikContext3D = { headBox: null, neckBox: null, torsoBox: null, waistBox: null, legBoxes: { left: null, right: null }, footBoxes: { left: null, right: null }, waistTopY: 0, shoulders: {}, armLens: {}, spineDeg: { bend: 0, twist: 0, side: 0 } };

// Shared helper: a point on/near the front face of a body box (head, torso,
// waist/hip...), given as fractions of that box's own width/height/depth —
// xFrac/yFrac measured from the box's own bottom-left-ish origin the same
// way the box's own geometry is (0.5 = the box's horizontal or vertical
// center), zFrac as a fraction of the box's own computed depth, where ±0.5
// is exactly the box's own front/back surface (the box spans z ∈
// [-depth/2, +depth/2], so anything past ±0.5 is already floating outside
// it — there's rarely a reason to go further than ~0.55-0.6). Returned in
// the spine's local frame (waistTopY subtracted out), same frame the
// shoulders/IK solve already use. Since every input is a fraction of the
// box's OWN current size, the resulting point automatically tracks that box
// at any body size — no baseline/rescale math needed.
function boxTargetPoint3D(box, xFrac, yFrac, zFrac) {
  if (!box) return null;
  const depthCm = computeBodyDepth3D(box).depthCm;
  return {
    x: box.xCm + xFrac * box.wCm,
    y: (box.bottomCm + yFrac * box.hCm) - ikContext3D.waistTopY,
    z: zFrac * depthCm,
  };
}

// The waist/hip box hangs directly off the PELVIS (bodyGroup3D) so it stays
// put while the torso leans/twists — but the reaching shoulder lives on the
// SPINE pivot (spineGroup), which a pose's spineBend/spineSide/spineTwist
// rotates. A target read straight off the hip box is therefore in a
// DIFFERENT frame than the shoulder as soon as any spine rotation is
// active (which most "hands on hips" poses use, for the model-y lean) —
// the two silently drift apart and the hand chases the wrong point. This
// undoes exactly that rotation on a pelvis-anchored point so it lands
// exactly where it visually should, however much the spine is bent.
function pelvisPointToSpineLocal3D(pt, bendDeg, twistDeg, sideDeg) {
  const euler = new THREE.Euler(deg2rad(bendDeg || 0), deg2rad(twistDeg || 0), deg2rad(sideDeg || 0), 'XYZ');
  const q = new THREE.Quaternion().setFromEuler(euler).invert();
  const v = new THREE.Vector3(pt.x, pt.y, pt.z).applyQuaternion(q);
  return { x: v.x, y: v.y, z: v.z };
}

// Recovers "which way did this gesture's ORIGINAL hand-tuned fixed angles
// point the upper arm" — used as the IK pole (the "which side does the
// elbow bend toward" hint) for a converted pose, so the IK solve reproduces
// the same natural elbow plane the pose was designed with, just re-aimed
// for exact reach instead of a baked angle. Mirrors setBallJoint's exact
// math (flex unsigned, abd/roll mirrored by side).
function poleFromAngles3D(side, flexDeg, abdDeg, rollDeg) {
  const sideSign = side === 'right' ? 1 : -1;
  const euler = new THREE.Euler(
    deg2rad(flexDeg || 0), deg2rad((rollDeg || 0) * sideSign), deg2rad((abdDeg || 0) * sideSign), 'XYZ'
  );
  const dir = new THREE.Vector3(0, -1, 0).applyEuler(euler);
  return { x: dir.x, y: dir.y, z: dir.z };
}

// Named "where the hand should reach for" presets, each returning a target
// point in the spine's own local frame (the same frame the shoulders and
// head already live in) so a pose can just say `handTarget: 'head-side'`.
// These are what make a "locked" hand (see HAND_LOCK_SIGNATURES) stay glued
// to the right spot on the body regardless of shoulder length or height —
// the target is always read fresh off the CURRENT mesh, every rebuild.
// A preset can carry a `.poleAngles` property (see poleFromAngles3D) to
// steer the elbow's bend plane; presets without one fall back to a generic
// forward/outward/down pole in applyArmIK.
const HAND_TARGET_PRESETS_3D = {
  // Salute: level with the brow, on the side of the head, pulled forward
  // just PAST the head's own front surface (zFrac just over 0.5, not deep
  // into it) — enough to clear the face without demanding more reach than
  // the arm actually has (an overshoot here is what makes an insufficient-
  // reach solve fall back to a point that cuts back through the head).
  'head-side': (side, geom) => {
    const sideSign = side === 'right' ? 1 : -1;
    return boxTargetPoint3D(geom.headBox, sideSign * 0.44, 0.62, 0.56);
  },
  // Hands on hips: the flare of the hip/waist box, just in front of its own
  // surface, roughly mid-height on that box. Pelvis-anchored (see
  // pelvisPointToSpineLocal3D) so a leaning/twisting torso doesn't pull it
  // off the actual hip.
  'hip-side': (side, geom) => {
    const sideSign = side === 'right' ? 1 : -1;
    const box = geom.waistBox || geom.torsoBox;
    const raw = boxTargetPoint3D(box, sideSign * 0.44, 0.5, 0.5);
    if (!raw) return null;
    const sd = geom.spineDeg || { bend: 0, twist: 0, side: 0 };
    return pelvisPointToSpineLocal3D(raw, sd.bend, sd.twist, sd.side);
  },
  // Hands/forearms crossed over the chest: each hand lands on the OPPOSITE
  // upper arm near the shoulder — reads off that side's own actual shoulder
  // position (ikContext3D.shoulders), so it also tracks a widened/narrowed
  // shoulder span, not just torso size. Both shoulders live on the SAME
  // spine pivot as the reaching arm, so — unlike hip-side — no extra frame
  // correction is needed even when the pose leans/twists the torso.
  'opposite-shoulder': (side, geom) => {
    const otherSide = side === 'right' ? 'left' : 'right';
    const otherShoulder = geom.shoulders[otherSide];
    if (!otherShoulder) return null;
    const otherSign = otherSide === 'right' ? 1 : -1;
    const unit = headWidthCm3D || 1; // proportional size reference, same one depth math uses
    return {
      x: otherShoulder.x + otherSign * -0.3 * unit,
      y: otherShoulder.y - 0.35 * unit,
      z: 0.35 * unit,
    };
  },
  // Hand flat on the stomach (e.g. lying on the back). Deliberately reads
  // the TORSO box, not the waist/hip box — the torso already hangs off the
  // spine pivot, so this needs no pelvis frame correction.
  'stomach': (side, geom) => {
    const sideSign = side === 'right' ? 1 : -1;
    return boxTargetPoint3D(geom.torsoBox, sideSign * 0.15, 0.25, 0.5);
  },
  // Hand resting at the chest/collarbone.
  'collarbone': (side, geom) => {
    const sideSign = side === 'right' ? 1 : -1;
    return boxTargetPoint3D(geom.torsoBox, sideSign * 0.18, 0.85, 0.5);
  },
  // Hand touching the cheek/side of the face.
  'face-cheek': (side, geom) => {
    const sideSign = side === 'right' ? 1 : -1;
    return boxTargetPoint3D(geom.headBox, sideSign * 0.3, 0.5, 0.55);
  },
};
HAND_TARGET_PRESETS_3D['hip-side'].poleAngles = { flex: 40, abd: 25, roll: -30 };
HAND_TARGET_PRESETS_3D['opposite-shoulder'].poleAngles = { flex: -5, abd: 30, roll: -70 };

// ---- Generic mesh-face pinning ---------------------------------------------
// The named presets above are hand-tuned one-off spots. This is the general
// case: pin a hand to ANY of the body's rest-position boxes (not just head/
// torso/waist), at any point on that box's face, given as fractions of that
// box's OWN current width/height/depth — exactly like boxTargetPoint3D's
// xFrac/yFrac/zFrac (0.5/0.5 = box center, ±0.5 on x or z = a side/front/
// back face, y:0/1 = the bottom/top face). Because the fractions are read
// fresh off that box's current size every rebuild, the pin automatically
// tracks the mesh through any resize with no extra math.
// Deliberately limited to boxes that sit at a fixed rest position relative
// to their own parent (pelvis or spine) — head, neck, torso, waist/hip, and
// the legs/feet. Arms and hands are themselves posed (rotated by whatever
// pose is active), so their CURRENT world position isn't recoverable from
// the flat 2D box alone; pinning a hand to another hand/arm still goes
// through a hand-tuned preset like 'opposite-shoulder' above.
// `pelvisAnchored: true` marks a box that hangs off the pelvis (bodyGroup3D)
// rather than the spine pivot — its raw point needs the same
// pelvisPointToSpineLocal3D correction 'hip-side' above uses, or a spine
// bend/twist will pull the pin off the mesh it's supposed to sit on.
const MESH_PIN_ANCHORS_3D = {
  head:       { get: geom => geom.headBox,        pelvisAnchored: false },
  neck:       { get: geom => geom.neckBox,        pelvisAnchored: false },
  torso:      { get: geom => geom.torsoBox,       pelvisAnchored: false },
  waist:      { get: geom => geom.waistBox,       pelvisAnchored: true },
  leftLeg:    { get: geom => geom.legBoxes.left,  pelvisAnchored: true },
  rightLeg:   { get: geom => geom.legBoxes.right, pelvisAnchored: true },
  leftFoot:   { get: geom => geom.footBoxes.left, pelvisAnchored: true },
  rightFoot:  { get: geom => geom.footBoxes.right,pelvisAnchored: true },
};

// Resolves a pose's `handTarget` field to a concrete spine-local point,
// whichever form it's given in: a named string preset (existing behavior,
// HAND_TARGET_PRESETS_3D above) or a generic mesh-pin descriptor object
// `{ box: 'waist'|'torso'|'head'|'neck'|'leftLeg'|'rightLeg'|'leftFoot'|
// 'rightFoot', x, y, z, poleAngles? }` (x/y/z default to 0/0.5/0.5, the
// box's front-center, if omitted). Returns null if the target can't be
// resolved (mesh not built this side, e.g. a missing leg), same as a
// preset returning null — applyArmIK already treats that as "skip IK".
function resolveHandTarget3D(side, targetSpec, geom) {
  if (!targetSpec) return null;
  if (typeof targetSpec === 'string') {
    const preset = HAND_TARGET_PRESETS_3D[targetSpec];
    if (!preset) return null;
    const point = preset(side, geom);
    return point ? { point, poleAngles: preset.poleAngles } : null;
  }
  const anchor = MESH_PIN_ANCHORS_3D[targetSpec.box];
  const box = anchor ? anchor.get(geom) : null;
  let point = boxTargetPoint3D(box, targetSpec.x ?? 0, targetSpec.y ?? 0.5, targetSpec.z ?? 0.5);
  if (point && anchor.pelvisAnchored) {
    const sd = geom.spineDeg || { bend: 0, twist: 0, side: 0 };
    point = pelvisPointToSpineLocal3D(point, sd.bend, sd.twist, sd.side);
  }
  return point ? { point, poleAngles: targetSpec.poleAngles } : null;
}

const v3 = (x, y, z) => ({ x, y, z });
const v3sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const v3dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const v3cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const v3len = (a) => Math.hypot(a.x, a.y, a.z);
const v3norm = (a) => { const l = v3len(a) || 1; return v3(a.x / l, a.y / l, a.z / l); };

// Builds the shoulder's Euler angles (matching three.js's default 'XYZ'
// Object3D rotation order, so this is exactly what gets assigned to
// rotation.x/.y/.z) from two things we actually know: the direction the
// upper arm should point (colY, negated — the rest pose points down local
// -y), and the direction the elbow's hinge axis should end up pointing
// (colX). The remaining local axis (colZ) is whatever completes a
// right-handed frame — its exact value doesn't matter, only that the
// frame is orthonormal, which colX/colY already are by construction below.
function eulerXYZFromAimAndHinge(aimDir, hingeDir) {
  const colY = v3(-aimDir.x, -aimDir.y, -aimDir.z);
  let colX = v3sub(hingeDir, v3(colY.x * v3dot(hingeDir, colY), colY.y * v3dot(hingeDir, colY), colY.z * v3dot(hingeDir, colY)));
  colX = v3norm(colX);
  const colZ = v3cross(colX, colY);
  // Standard 'XYZ' Euler extraction from a rotation matrix whose columns
  // are [colX, colY, colZ]: colZ.x = sin(roll); the rest follow.
  const sy = Math.max(-1, Math.min(1, colZ.x));
  const rollRad = Math.asin(sy);
  const cy = Math.cos(rollRad);
  let flexRad, zRad;
  if (Math.abs(cy) > 1e-6) {
    flexRad = Math.atan2(-colZ.y, colZ.z);
    zRad = Math.atan2(-colY.x, colX.x);
  } else {
    // Gimbal lock (roll ≈ ±90°) — extremely unlikely for these presets,
    // but fall back to something valid rather than producing NaN.
    flexRad = Math.atan2(colX.y, colY.y);
    zRad = 0;
  }
  return { flexRad, rollRad, zRad };
}

// Full 2-bone solve: shoulderPos/target in the spine's local frame, L1/L2
// the upper-arm/forearm lengths, pole a rough "which way the elbow points"
// direction (defaults to outward + a bit forward + a bit down, like a
// natural human elbow, unless the preset/pose gives its own).
function solveArmIK(shoulderPos, target, L1, L2, pole) {
  if (!target) return null;
  const toTarget = v3sub(target, shoulderPos);
  const rawD = v3len(toTarget);
  const maxReach = L1 + L2;
  // If the requested reach is longer than the arm's two segments can ever
  // cover — the "hand's facing position is too long for the elbow/shoulder
  // to connect" case — clamp the solve distance so the chain still forms a
  // valid (fully-extended) triangle, and report how far over we were so the
  // caller can visibly rotate the hand/wrist outward to sell the stretch
  // instead of just silently snapping the hand short of the real target.
  const d = Math.max(Math.abs(L1 - L2) + 0.01, Math.min(rawD, maxReach - 0.01));
  const overreachCm = Math.max(0, rawD - maxReach);
  const dirToTarget = rawD > 1e-6 ? v3norm(toTarget) : v3(0, -1, 0);
  // Angle at the shoulder between "straight at target" and "where the
  // upper arm actually points" (law of cosines on the S–Elbow–Target
  // triangle), and the elbow's own bend (our convention: negative).
  const cosAlpha = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
  const cosInterior = (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2);
  const interiorDeg = Math.acos(Math.max(-1, Math.min(1, cosInterior))) * 180 / Math.PI;
  const elbowDeg = -(180 - interiorDeg);
  // In-plane direction (perpendicular to dirToTarget) the elbow swings
  // toward, from projecting the pole hint into that plane.
  const dot = v3dot(dirToTarget, pole);
  let p = v3sub(pole, v3(dirToTarget.x * dot, dirToTarget.y * dot, dirToTarget.z * dot));
  if (v3len(p) < 1e-6) p = v3(1, 0, 0); // pole parallel to target dir — arbitrary fallback
  p = v3norm(p);
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const upperArmDir = v3(
    ca * dirToTarget.x + sa * p.x,
    ca * dirToTarget.y + sa * p.y,
    ca * dirToTarget.z + sa * p.z
  );
  // The hinge axis this specific bend needs is perpendicular to the plane
  // containing the shoulder, elbow and target — i.e. perpendicular to both
  // dirToTarget and p. This exact cross-product order is what makes a
  // NEGATIVE elbowDeg (this file's normal elbow-flexion sign) bend toward
  // the target rather than away from it.
  const hingeAxis = v3cross(dirToTarget, p);
  const euler = eulerXYZFromAimAndHinge(upperArmDir, hingeAxis);
  return { flexRad: euler.flexRad, rollRad: euler.rollRad, zRad: euler.zRad, elbowDeg, overreachCm };
}

// Runs the IK above for one arm and applies the result straight to the rig,
// using whatever the CURRENT body proportions are (from ikContext3D).
// Returns false if IK couldn't run at all, or an object {wristTurnBoost}
// on success — wristTurnBoost is 0 for a normal in-reach solve, and a small
// outward-rotation nudge (degrees, unsigned) when the target was farther
// than the arm can physically reach, so the caller can add it to the pose's
// own wristTurn and visibly sell the hand "reaching" rather than the arm
// silently coming up short of the mesh it was supposed to lock onto.
// targetSpec is whatever the pose's handTarget field holds — a named preset
// string or a generic mesh-pin descriptor object; see resolveHandTarget3D.
function applyArmIK(side, shoulderGrp, elbowGrp, targetSpec) {
  if (!shoulderGrp || !elbowGrp) return false;
  const resolved = resolveHandTarget3D(side, targetSpec, ikContext3D);
  if (!resolved) return false;
  const shoulderPos = ikContext3D.shoulders[side];
  const lens = ikContext3D.armLens[side];
  if (!shoulderPos || !lens) return false;
  const sideSign = side === 'right' ? 1 : -1;
  const pole = resolved.poleAngles
    ? poleFromAngles3D(side, resolved.poleAngles.flex, resolved.poleAngles.abd, resolved.poleAngles.roll)
    : { x: sideSign * 0.5, y: -0.3, z: 0.8 };
  const sol = solveArmIK(shoulderPos, resolved.point, lens.upper, lens.lower, pole);
  if (!sol) return false;
  shoulderGrp.rotation.x = sol.flexRad;
  shoulderGrp.rotation.y = sol.rollRad;
  shoulderGrp.rotation.z = sol.zRad;
  elbowGrp.rotation.x = deg2rad(sol.elbowDeg);
  const maxReach = (lens.upper + lens.lower) || 1;
  const wristTurnBoost = Math.min(30, (sol.overreachCm / maxReach) * 90);
  return { wristTurnBoost };
}

// (Re)builds every box mesh from the current 2D layout. Called automatically
// every time "Generate" runs, and whenever a depth or waistline slider changes.
function buildBody3D() {
  if (!sceneInited3D) initScene3D();
  while (bodyGroup3D.children.length) {
    disposeObject3D(bodyGroup3D.children.pop());
  }
  meshRecords3D = [];
  rig3D = {};
  const { boxes, leftPivot, rightPivot, armRotated } = collectBodyBoxData3D();
  if (!boxes.length) return;

  const gender = document.getElementById('genderSelect')?.value === 'female' ? 'female' : 'male';

  let minY=Infinity, maxY=-Infinity;
  const noteY = (b) => { minY = Math.min(minY, b.bottomCm); maxY = Math.max(maxY, b.bottomCm + b.hCm); };

  const headBox = boxes.find(b => b.group === 'head');
  headWidthCm3D = headBox ? headBox.wCm : (boxes[0] ? boxes[0].wCm : 1);

  const torsoBox = boxes.find(b => b.group === 'torso');
  const waistBox = boxes.find(b => b.group === 'waistbox');
  const neckBox = boxes.find(b => b.group === 'neck');
  // Legs/feet have no explicit side field of their own (see
  // collectBodyBoxData3D) — same left/right split buildLeg() itself uses
  // (negative x = left), so a mesh pin targeting 'leftLeg'/'rightFoot' etc.
  // always matches the same box the actual leg mesh was built from.
  const legBoxes = {
    left:  boxes.find(b => b.group === 'legs' && b.xCm < 0),
    right: boxes.find(b => b.group === 'legs' && b.xCm >= 0),
  };
  const footBoxes = {
    left:  boxes.find(b => b.group === 'feet' && b.xCm < 0),
    right: boxes.find(b => b.group === 'feet' && b.xCm >= 0),
  };
  const legBoxForPivot = boxes.find(b => b.group === 'legs');
  // Where the spine bends: the top of the waist/hip box (or, failing that,
  // the top of the legs) — i.e. roughly the real waistline. Everything
  // BELOW this (the waist box itself, the legs) stays fixed to the pelvis;
  // everything ABOVE it (torso, head, neck, arms) hangs off a spine pivot
  // instead, so a pose's spineBend/spineSide/spineTwist can move the whole
  // upper body as a unit without dragging the hips/legs along with it.
  const waistTopY = waistBox ? (waistBox.bottomCm + waistBox.hCm)
                   : (legBoxForPivot ? (legBoxForPivot.bottomCm + legBoxForPivot.hCm) : 0);
  // Refresh the IK context with this build's actual geometry — any
  // handTarget-driven pose reads current body size from here, never stale
  // numbers from a previous Generate/slider change.
  ikContext3D = { headBox, neckBox, torsoBox, waistBox, legBoxes, footBoxes, waistTopY, shoulders: {}, armLens: {}, spineDeg: ikContext3D.spineDeg || { bend: 0, twist: 0, side: 0 } };

  const spineGroup = new THREE.Group();
  spineGroup.position.set(0, waistTopY, 0);
  bodyGroup3D.add(spineGroup);
  rig3D.spine = spineGroup;

  // Arms/hands rotate as a rigid unit around the shoulder pivot, exactly like
  // the 2D "Rotate Arms Out 15°" option — mirrored sign because CSS rotation
  // is measured in a Y-down frame while our 3D scene is Y-up. They hang off
  // the spine pivot (not the pelvis) so a spine bend/twist carries the arms
  // along with the torso, the way a real body actually moves. The 15° base
  // offset is stashed in userData so a pose's own shoulder-abduction can be
  // added on top of it instead of overwriting it.
  const leftArmGroup = new THREE.Group();
  const rightArmGroup = new THREE.Group();
  if (leftPivot) {
    leftArmGroup.position.set(leftPivot.xCm, leftPivot.bottomCm - waistTopY, 0);
    leftArmGroup.userData.baseZ = deg2rad(armRotated ? -15 : 0);
    leftArmGroup.rotation.z = leftArmGroup.userData.baseZ;
  }
  if (rightPivot) {
    rightArmGroup.position.set(rightPivot.xCm, rightPivot.bottomCm - waistTopY, 0);
    rightArmGroup.userData.baseZ = deg2rad(armRotated ? 15 : 0);
    rightArmGroup.rotation.z = rightArmGroup.userData.baseZ;
  }
  spineGroup.add(leftArmGroup, rightArmGroup);
  rig3D.leftShoulder = leftArmGroup;
  rig3D.rightShoulder = rightArmGroup;

  // ---- Torso & hip/waist box: a plain rectangular box, or an hourglass
  // split into two trapezoids (pinched at the box's own vertical midpoint)
  // for whichever box matches the current gender. The pinch width is a % of
  // THAT box's own width, so 100% always reproduces the box's real width
  // (no pinch) regardless of how the torso and waist box widths compare.
  // targetGroup/yOffset let the torso hang off the spine pivot while the
  // waist/hip box stays fixed to the pelvis (bodyGroup3D, yOffset 0). ----
  function addTorsoOrWaistBox(box, splitIt, targetGroup, yOffset) {
    if (!box) return;
    const { depthCm, zOffset } = computeBodyDepth3D(box);
    if (!splitIt) {
      const mesh = makeBoxMesh(box, depthCm);
      mesh.position.set(box.xCm, box.bottomCm + box.hCm/2 - yOffset, zOffset);
      targetGroup.add(mesh);
      meshRecords3D.push({ mesh, group: box.group, wCm: box.wCm, hCm: box.hCm });
      noteY(box);
      return;
    }
    const pinchWidthCm = (waistlinePct / 100) * box.wCm;
    const halfH = box.hCm / 2;
    const color = groupColor3D[box.group] || 0xaaaaaa;
    // Lower half: full width at the box's own bottom edge, pinched at the middle.
    const lower = makeTrapezoidMesh(pinchWidthCm, box.wCm, halfH, depthCm, color);
    lower.position.set(box.xCm, box.bottomCm + halfH/2 - yOffset, zOffset);
    targetGroup.add(lower);
    meshRecords3D.push({ mesh: lower, group: box.group, wCm: box.wCm, hCm: halfH });
    // Upper half: full width at the box's own top edge, pinched at the middle.
    const upper = makeTrapezoidMesh(box.wCm, pinchWidthCm, halfH, depthCm, color);
    upper.position.set(box.xCm, box.bottomCm + halfH + halfH/2 - yOffset, zOffset);
    targetGroup.add(upper);
    meshRecords3D.push({ mesh: upper, group: box.group, wCm: box.wCm, hCm: halfH });
    noteY(box);
  }
  addTorsoOrWaistBox(torsoBox, gender === 'male', spineGroup, waistTopY);
  addTorsoOrWaistBox(waistBox, gender === 'female', bodyGroup3D, 0);

  // ---- Everything else — just head & neck now, also hung off the spine
  // pivot. Arms/hands and legs/feet are handled below separately so they can
  // carry their joints and bend. ----
  boxes.forEach(b => {
    if (b.group === 'torso' || b.group === 'waistbox' || b.group === 'arms' || b.group === 'legs'
      || b.group === 'hands' || b.group === 'feet') return;
    let depthCm, zOffset = 0;
    if (b.group === 'head') { depthCm = headDepthMult * b.wCm; }
    else { const r = computeBodyDepth3D(b); depthCm = r.depthCm; zOffset = r.zOffset; }
    const mesh = makeBoxMesh(b, depthCm);
    const yCenter = b.bottomCm + b.hCm/2;
    mesh.position.set(b.xCm, yCenter - waistTopY, zOffset);
    spineGroup.add(mesh);
    meshRecords3D.push({ mesh, group: b.group, wCm: b.wCm, hCm: b.hCm });
    noteY(b);
  });

  // ---- Arms: split into upper arm / forearm at the elbow. The upper arm
  // sits directly in the shoulder-pivot group; the forearm AND hand sit in
  // a nested elbow-pivot group, so the elbow can bend independently of the
  // shoulder and the hand just follows along without bending on its own. ----
  function buildArmSide(group, pivot, side) {
    if (!pivot) return;
    const armBox = boxes.find(b => b.side === side && b.group === 'arms');
    if (!armBox) return;
    const handBox = boxes.find(b => b.side === side && b.group === 'hands');
    const armDepthCm = computeBodyDepth3D(armBox).depthCm;
    const armLocalX = armBox.xCm - pivot.xCm;
    const handHcm = handBox ? handBox.hCm : 0;
    // Elbow sits at (arm + hand length − half the hand length) ÷ 2 below the shoulder.
    const elbowOffsetCm = (armBox.hCm + handHcm/2) / 2;
    const upperH = elbowOffsetCm;
    const lowerH = armBox.hCm - upperH;
    // Record this side's shoulder position (in the spine's local frame,
    // same frame HAND_TARGET_PRESETS_3D targets are given in) and segment
    // lengths, so an IK-driven pose can reach for a target using this
    // build's actual proportions.
    ikContext3D.shoulders[side] = { x: armBox.xCm, y: pivot.bottomCm - waistTopY, z: 0 };
    ikContext3D.armLens[side] = { upper: upperH, lower: lowerH };

    const upper = makeBoxMesh({ wCm: armBox.wCm, hCm: upperH, group: 'arms' }, armDepthCm);
    upper.position.set(armLocalX, -upperH/2, 0);
    group.add(upper);
    meshRecords3D.push({ mesh: upper, group: 'arms', wCm: armBox.wCm, hCm: upperH });

    const shoulderJoint = makeJointSphere(armDepthCm);
    shoulderJoint.position.set(armLocalX, 0, 0);
    group.add(shoulderJoint);
    meshRecords3D.push({ mesh: shoulderJoint, group: 'joint', wCm: armDepthCm, hCm: armDepthCm });

    // Elbow pivot: forearm + hand hang from here, in their own local frame
    // (y=0 at the elbow), so a pose can bend the elbow on top of whatever
    // the shoulder is doing.
    const elbowGroup = new THREE.Group();
    elbowGroup.position.set(armLocalX, -upperH, 0);
    group.add(elbowGroup);

    const lower = makeBoxMesh({ wCm: armBox.wCm, hCm: lowerH, group: 'arms' }, armDepthCm);
    lower.position.set(0, -lowerH/2, 0);
    elbowGroup.add(lower);
    meshRecords3D.push({ mesh: lower, group: 'arms', wCm: armBox.wCm, hCm: lowerH });
    // Kept so applyPose3D can recolor it red/blue for flipped/unflipped
    // (palm/dorsum) every time the pose or a hand/wrist override changes.
    rig3D[side + 'ForearmMesh'] = lower;

    const elbowJoint = makeJointSphere(armDepthCm);
    elbowJoint.position.set(0, 0, 0);
    elbowGroup.add(elbowJoint);
    meshRecords3D.push({ mesh: elbowJoint, group: 'joint', wCm: armDepthCm, hCm: armDepthCm });

    // Wrist pivot: the hand hangs from here, in its own local frame (y=0 at
    // the wrist), nested inside the elbow group so a pose can bend/turn the
    // hand independently of whatever the shoulder and elbow are doing. This
    // is the joint that actually lets a hand lie flat against a hip, tuck
    // under an opposite forearm, or curl to support a chin — without it the
    // hand can only ever trail along as a rigid extension of the forearm.
    const wristGroup = new THREE.Group();
    wristGroup.position.set(0, -lowerH, 0);
    elbowGroup.add(wristGroup);
    rig3D[side + 'Wrist'] = wristGroup;

    if (handBox) {
      const handDepthCm = computeBodyDepth3D(handBox).depthCm;
      const wristJointCm = handBox.wCm * 0.6;
      const wristJoint = makeJointSphere(wristJointCm);
      wristJoint.position.set(0, 0, 0);
      wristGroup.add(wristJoint);
      meshRecords3D.push({ mesh: wristJoint, group: 'joint', wCm: wristJointCm, hCm: wristJointCm });

      const hand = makeBoxMesh({ wCm: handBox.wCm, hCm: handBox.hCm, group: 'hands' }, handDepthCm);
      hand.position.set(0, -handBox.hCm/2, 0);
      wristGroup.add(hand);
      meshRecords3D.push({ mesh: hand, group: 'hands', wCm: handBox.wCm, hCm: handBox.hCm });

      // Thumb: a small block on the hand's edge, near the wrist end, so the
      // hand's facing (which way is palm vs. back, which edge is which) is
      // readable at a glance instead of guessed from a flat rectangle. Built
      // here at its base edge (+x for the right hand / -x for the left) —
      // CONFIRMED against the render as the palm edge, same baseSign
      // applyHandFlipVisuals3D uses — and immediately corrected to whichever
      // edge the CURRENT wristTurn actually calls for by the
      // applyHandFlipVisuals3D() call after buildArmSide returns (and again
      // on every later pose/override change), angled out a little from the
      // hand's own plane to read clearly in 3D. rig3D keeps the pivot + the
      // geometry it needs so that later repositioning doesn't have to
      // rebuild the mesh.
      const thumbSign = side === 'right' ? 1 : -1;
      const thumbW = handBox.wCm * 0.32, thumbH = handBox.hCm * 0.4, thumbD = handDepthCm * 0.8;
      const thumb = makeBoxMesh({ wCm: thumbW, hCm: thumbH, group: 'hands' }, thumbD);
      const thumbPivot = new THREE.Group();
      thumbPivot.position.set(thumbSign * handBox.wCm * 0.42, -handBox.hCm * 0.18, 0);
      thumbPivot.rotation.z = deg2rad(thumbSign * 35);
      thumb.position.set(0, -thumbH/2, 0);
      thumbPivot.add(thumb);
      wristGroup.add(thumbPivot);
      meshRecords3D.push({ mesh: thumb, group: 'hands', wCm: thumbW, hCm: thumbH });
      rig3D[side + 'ThumbPivot'] = thumbPivot;
      rig3D[side + 'ThumbGeom'] = { wCm: handBox.wCm, hCm: handBox.hCm };
    }

    noteY(armBox);
    rig3D[side + 'Elbow'] = elbowGroup;
  }
  buildArmSide(leftArmGroup, leftPivot, 'left');
  buildArmSide(rightArmGroup, rightPivot, 'right');

  // ---- Legs: split at the knee (the exact vertical midpoint of the leg
  // box — this already matches where the 2D "Knee line" is drawn). Thigh
  // hangs from a hip pivot; shin hangs from a knee pivot nested inside the
  // hip pivot; the foot hangs from an ankle pivot nested inside the knee
  // pivot — so each joint can bend independently for poses. ----
  function buildLeg(legBox) {
    const legDepthCm = computeBodyDepth3D(legBox).depthCm;
    // Knee & ankle joints are sized off the leg box's own WIDTH, not its
    // depth — the old depth-matched spheres were oversized.
    const legJointCm = legBox.wCm;
    // Hip joint is sized off half the DEPTH of the waist/hip box.
    const hipJointCm = 0.5 * (waistBox ? computeBodyDepth3D(waistBox).depthCm : legDepthCm);
    const halfH = legBox.hCm / 2; // thigh height == shin height
    const hipY = legBox.bottomCm + legBox.hCm;
    const side = legBox.xCm < 0 ? 'left' : 'right';

    // Hip pivot: thigh + knee + shin + ankle + foot all hang from here, at
    // the leg's own (narrower) centerline, so the whole leg swings as a unit.
    const hipGroup = new THREE.Group();
    hipGroup.position.set(legBox.xCm, hipY, 0);
    bodyGroup3D.add(hipGroup);
    rig3D[side + 'Hip'] = hipGroup;

    const thigh = makeBoxMesh({ wCm: legBox.wCm, hCm: halfH, group: 'legs' }, legDepthCm);
    thigh.position.set(0, -halfH/2, 0);
    hipGroup.add(thigh);
    meshRecords3D.push({ mesh: thigh, group: 'legs', wCm: legBox.wCm, hCm: halfH });

    // Hip joint sphere: fixed to the pelvis (NOT the hip pivot), sitting on
    // the waist/hip box's own side edge, so it stays put in its socket while
    // the leg swings beneath it. Its center sits exactly on that edge, so
    // roughly half the sphere pokes out past the box's side.
    const sideSign = Math.sign(legBox.xCm) || 1;
    const hipSphereX = waistBox ? waistBox.xCm + sideSign * (waistBox.wCm / 2) : legBox.xCm;
    const hip = makeJointSphere(hipJointCm);
    hip.position.set(hipSphereX, hipY, 0);
    bodyGroup3D.add(hip);
    meshRecords3D.push({ mesh: hip, group: 'joint', wCm: hipJointCm, hCm: hipJointCm });

    // Knee pivot: shin + ankle + foot hang from here, local y=0 at the knee.
    const kneeGroup = new THREE.Group();
    kneeGroup.position.set(0, -halfH, 0);
    hipGroup.add(kneeGroup);
    rig3D[side + 'Knee'] = kneeGroup;

    const shin = makeBoxMesh({ wCm: legBox.wCm, hCm: halfH, group: 'legs' }, legDepthCm);
    shin.position.set(0, -halfH/2, 0);
    kneeGroup.add(shin);
    meshRecords3D.push({ mesh: shin, group: 'legs', wCm: legBox.wCm, hCm: halfH });

    const knee = makeJointSphere(legJointCm);
    knee.position.set(0, 0, 0);
    kneeGroup.add(knee);
    meshRecords3D.push({ mesh: knee, group: 'joint', wCm: legJointCm, hCm: legJointCm });

    // Ankle pivot: the foot hangs from here, local y=0 at the ankle.
    const ankleGroup = new THREE.Group();
    ankleGroup.position.set(0, -halfH, 0);
    kneeGroup.add(ankleGroup);
    rig3D[side + 'Ankle'] = ankleGroup;

    const ankle = makeJointSphere(legJointCm);
    ankle.position.set(0, 0, 0);
    ankleGroup.add(ankle);
    meshRecords3D.push({ mesh: ankle, group: 'joint', wCm: legJointCm, hCm: legJointCm });

    const footBox = boxes.find(b => b.group === 'feet' && Math.sign(b.xCm) === Math.sign(legBox.xCm));
    if (footBox) {
      const { depthCm: footDepthCm, zOffset: footZOffset } = computeBodyDepth3D(footBox);
      const foot = makeBoxMesh({ wCm: footBox.wCm, hCm: footBox.hCm, group: 'feet' }, footDepthCm);
      // Foot's top sits at the ankle; it hangs straight down from there by
      // default, pushed forward the same way it always was.
      foot.position.set(0, -footBox.hCm/2, footZOffset);
      ankleGroup.add(foot);
      meshRecords3D.push({ mesh: foot, group: 'feet', wCm: footBox.wCm, hCm: footBox.hCm });
    }

    noteY(legBox);
  }
  boxes.filter(b => b.group === 'legs').forEach(buildLeg);

  const centerY = (minY + maxY) / 2, totalHeight = maxY - minY;
  controls3D.target.set(0, centerY, 0);
  if (!buildBody3D._hasFramed) {
    camera3D.position.set(0, centerY, totalHeight * 1.6 + 60);
    buildBody3D._hasFramed = true;
  }
  controls3D.update();

  // Rebuilding wipes every pivot's rotation back to 0, so silently
  // re-apply whichever pose was active (without yanking the camera —
  // that only happens when the person explicitly picks a pose).
  applyPose3D(currentPose3D, { reframe: false });
}

// Sets every joint pivot's rotation from a POSES3D entry, tilts the whole
// body for lying poses, and re-grounds the model so its lowest point always
// rests at y=0 (the floor) — whichever part that turns out to be (feet for
// a standing/seated pose, the back of the torso for lying down, etc). Pass
// { reframe:true } to also re-fit the camera to the new silhouette, which
// setPose3D() does for an explicit pose pick; buildBody3D()'s automatic
// re-apply after a rebuild does not, so it doesn't disturb the camera.
function applyPose3D(poseName, { reframe = false } = {}) {
  const pose = POSES3D[poseName] || POSES3D['stand-relaxed'];
  currentPose3D = POSES3D[poseName] ? poseName : 'stand-relaxed';
  const p = expandPose3D(pose);

  // Hand/Wrist Facing panel overrides win over whatever the named pose set,
  // on whichever side(s) have an override active.
  if (handRotationOverride.left)  p.wristTurnL = HAND_ROTATION_DEG.left[handRotationOverride.left];
  if (handRotationOverride.right) p.wristTurnR = HAND_ROTATION_DEG.right[handRotationOverride.right];
  if (wristRotationOverride.left)  p.wristL = WRIST_ROTATION_DEG[wristRotationOverride.left];
  if (wristRotationOverride.right) p.wristR = WRIST_ROTATION_DEG[wristRotationOverride.right];

  // side is -1 for left, +1 for right, so a positive hipAbd/shoulderAbd in
  // pose data always reads as "swing outward, away from the midline" on
  // BOTH sides — the pose data itself never needs to know which sign is
  // which side. Shoulder groups keep whatever base Z rotation buildBody3D
  // gave them (the 2D "Rotate Arms Out 15°" option) and add abduction on
  // top of it, rather than overwriting it.
  const setBallJoint = (grp, flexDeg, abdDeg, side) => {
    if (!grp) return;
    grp.rotation.x = deg2rad(flexDeg || 0);
    const baseZ = (grp.userData && grp.userData.baseZ) || 0;
    grp.rotation.z = baseZ + deg2rad((abdDeg || 0) * side);
  };
  const setHinge = (grp, deg) => { if (grp) grp.rotation.x = deg2rad(deg || 0); };
  const setAnkle = (grp, flexDeg, turnDeg) => {
    if (!grp) return;
    grp.rotation.x = deg2rad(flexDeg || 0);
    grp.rotation.y = deg2rad(turnDeg || 0);
  };

  setBallJoint(rig3D.leftHip,  p.hipL,  p.hipAbdL,  -1);
  setBallJoint(rig3D.rightHip, p.hipR,  p.hipAbdR,   1);
  if (rig3D.leftHip)  rig3D.leftHip.rotation.y  = deg2rad((p.hipTurnL || 0) * -1);
  if (rig3D.rightHip) rig3D.rightHip.rotation.y = deg2rad((p.hipTurnR || 0) *  1);
  setHinge(rig3D.leftKnee, p.kneeL);   setHinge(rig3D.rightKnee, p.kneeR);
  setAnkle(rig3D.leftAnkle,  p.ankleL,  p.ankleTurnL);
  setAnkle(rig3D.rightAnkle, p.ankleR,  p.ankleTurnR);
  // IK-driven arms (pose sets handTarget) reach for a mesh directly and
  // skip the fixed-angle path entirely; everything else still uses the
  // authored flex/abd/roll/elbow numbers exactly as before. Pelvis-anchored
  // targets (hip-side) need to know how much the spine is currently
  // bent/twisted/leaned to stay correctly locked — see
  // pelvisPointToSpineLocal3D — so stamp that onto ikContext3D right before
  // solving, using this pose's own spine numbers.
  ikContext3D.spineDeg = { bend: p.spineBend || 0, twist: p.spineTwist || 0, side: p.spineSide || 0 };
  const leftIK = p.handTargetL ? applyArmIK('left', rig3D.leftShoulder, rig3D.leftElbow, p.handTargetL) : false;
  // Actually-applied elbow bend/lift for this render — defaults to the
  // pose's own numbers (untouched) for an IK-driven side, and gets replaced
  // inside the non-IK branch below when an override is active. Declared out
  // here (rather than as consts inside the branch) so the Save button below
  // can read back exactly what was rendered, regardless of which path ran.
  let leftElbowBend = p.elbowL, leftElbowLift = 0;
  if (!leftIK) {
    // Clamp wristTurn to its physical range BEFORE positioning the shoulder,
    // so any overshoot can be folded into this same shoulder call as extra
    // abduction (elbow lift) rather than silently vanishing. The Hand/Wrist
    // Facing panel's elbow inputs stack on top of/replace these the same
    // way its hand/wrist word presets already override p.wristTurnL/p.wristL
    // above: elbowLiftOverride ADDS to the auto lift (manual lift on top of
    // whatever the wristTurn clamp already contributed), while
    // elbowBendOverride REPLACES the pose's own elbow angle outright.
    const leftWrist = clampWristTurn('left', p.wristTurnL);
    p.wristTurnL = leftWrist.clamped;
    leftElbowLift = leftWrist.elbowLift + (elbowLiftOverride.left || 0);
    leftElbowBend = elbowBendOverride.left != null ? elbowBendOverride.left : p.elbowL;
    setBallJoint(rig3D.leftShoulder, p.shoulderL, (p.shoulderAbdL || 0) + leftElbowLift, -1);
    if (rig3D.leftShoulder) rig3D.leftShoulder.rotation.y = deg2rad((p.shoulderRollL || 0) * -1);
    setHinge(rig3D.leftElbow, leftElbowBend);
  } else if (leftIK.wristTurnBoost) {
    // Target was farther than the arm can reach — rotate the wrist a bit
    // further outward on top of whatever the pose authored, instead of
    // letting the hand quietly stop short of the mesh it's locked onto.
    // Added the same way other shared "outward" fields (hipAbd/shoulderAbd)
    // are authored — the per-side ×(-1)/×(+1) mirroring below turns this
    // single positive number into "outward" on whichever side it's on.
    // IK already fixed the shoulder/elbow to reach the target, so an
    // overshoot here just clamps (no elbow-lift compensation — lifting the
    // elbow now would pull the hand off the target it's locked onto).
    p.wristTurnL = clampWristTurn('left', (p.wristTurnL || 0) + leftIK.wristTurnBoost).clamped;
  }
  const rightIK = p.handTargetR ? applyArmIK('right', rig3D.rightShoulder, rig3D.rightElbow, p.handTargetR) : false;
  let rightElbowBend = p.elbowR, rightElbowLift = 0;
  if (!rightIK) {
    const rightWrist = clampWristTurn('right', p.wristTurnR);
    p.wristTurnR = rightWrist.clamped;
    rightElbowLift = rightWrist.elbowLift + (elbowLiftOverride.right || 0);
    rightElbowBend = elbowBendOverride.right != null ? elbowBendOverride.right : p.elbowR;
    setBallJoint(rig3D.rightShoulder, p.shoulderR, (p.shoulderAbdR || 0) + rightElbowLift, 1);
    // shoulderRoll: same mirroring convention as hipTurn — applied AFTER the
    // ball joint's flex/abd, on the same shoulder group, so it re-aims the
    // elbow's hinge axis without disturbing flex/abd.
    if (rig3D.rightShoulder) rig3D.rightShoulder.rotation.y = deg2rad((p.shoulderRollR || 0) * 1);
    setHinge(rig3D.rightElbow, rightElbowBend);
  } else if (rightIK.wristTurnBoost) {
    p.wristTurnR = clampWristTurn('right', (p.wristTurnR || 0) + rightIK.wristTurnBoost).clamped;
  }
  // wrist: bend is a hinge exactly like the elbow (same fixed sign
  // convention — see the pose-authoring notes above); wristTurn re-aims
  // which way the hand block faces by rotating it about the forearm's own
  // long axis, applied AFTER the bend, the same way shoulderRoll is applied
  // after the shoulder's own flex/abd. Mirrored the same way as
  // shoulderRoll/hipTurn: a shared value turns the hands to face each other
  // (useful for clasped hands), not the same way.
  setHinge(rig3D.leftWrist, p.wristL); setHinge(rig3D.rightWrist, p.wristR);
  if (rig3D.leftWrist)  rig3D.leftWrist.rotation.y  = deg2rad((p.wristTurnL || 0) * -1);
  if (rig3D.rightWrist) rig3D.rightWrist.rotation.y = deg2rad((p.wristTurnR || 0) *  1);

  // Forearm flip state, color AND thumb edge — all derived from the same
  // wristTurn values just applied above, in one place, so they can never
  // read as three different hand orientations at once.
  applyHandFlipVisuals3D('left',  p.wristTurnL);
  applyHandFlipVisuals3D('right', p.wristTurnR);

  if (rig3D.spine) {
    rig3D.spine.rotation.x = deg2rad(p.spineBend || 0);
    rig3D.spine.rotation.y = deg2rad(p.spineTwist || 0);
    rig3D.spine.rotation.z = deg2rad(p.spineSide || 0);
  }
  if (poseRootGroup3D) {
    poseRootGroup3D.rotation.x = deg2rad(p.root || 0);
    poseRootGroup3D.rotation.z = deg2rad(p.rootZ || 0);
  }
  // Snapshot of exactly what got rendered this call — the Save button in the
  // Hand/Wrist Facing panel reads this rather than re-deriving it, so what
  // gets written to POSES3D is guaranteed to match what's on screen. isIK
  // sides are flagged so Save knows to leave their handTarget-driven fields
  // alone instead of writing dead angle numbers the IK path would ignore.
  lastPoseResolved3D = {
    left:  { wristTurn: p.wristTurnL, wrist: p.wristL, elbow: leftElbowBend,  shoulderAbd: (p.shoulderAbdL || 0) + leftElbowLift,  isIK: !!leftIK },
    right: { wristTurn: p.wristTurnR, wrist: p.wristR, elbow: rightElbowBend, shoulderAbd: (p.shoulderAbdR || 0) + rightElbowLift, isIK: !!rightIK },
  };
  groundBody3D(reframe);
}

// Re-grounds the posed model (translates poseRootGroup3D vertically so the
// model's lowest point touches y=0, whatever part that is for the current
// pose) using a real world-space bounding box — robust to any combination
// of joint and root rotation, unlike a per-box half-height estimate.
// Optionally also re-fits the camera to the new silhouette.
function groundBody3D(reframe) {
  if (!poseRootGroup3D || !bodyGroup3D || !meshRecords3D.length) return;
  poseRootGroup3D.position.y = 0;
  poseRootGroup3D.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(bodyGroup3D);
  if (!isFinite(box.min.y)) return;
  poseRootGroup3D.position.y = -box.min.y;
  poseRootGroup3D.updateMatrixWorld(true);
  if (reframe) {
    const box2 = new THREE.Box3().setFromObject(bodyGroup3D);
    const center = box2.getCenter(new THREE.Vector3());
    const size = box2.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.y, size.z) * 1.6 + 60;
    controls3D.target.set(center.x, center.y, center.z);
    camera3D.position.set(center.x, center.y, center.z + dist);
    controls3D.update();
  }
}

// Builds the Pose panel's buttons from POSES3D, grouped into the labeled
// sections each entry declares (Standing, Sitting, Squatting, etc) — add a
// new pose to POSES3D and it shows up here automatically, no HTML to touch.
function renderPosePanel3D() {
  const container = document.getElementById('poseSections');
  if (!container) return;
  const sections = {};
  Object.keys(POSES3D).forEach(key => {
    const pose = POSES3D[key];
    (sections[pose.section] = sections[pose.section] || []).push({ key, ...pose });
  });
  container.innerHTML = Object.keys(sections).map(sectionName => `
    <div class="pose-section">
      <div class="pose-section-title">${sectionName}</div>
      <div class="pose-btn-row">
        ${sections[sectionName].map(p => `<button type="button" class="pose-btn${p.key === currentPose3D ? ' active' : ''}" data-pose="${p.key}" onclick="setPose3D('${p.key}')">${p.label}</button>`).join('')}
      </div>
    </div>
  `).join('');
}
renderPosePanel3D();

// Called from the Pose panel buttons: switches to a named pose, snaps it to
// the floor, and re-frames the camera to the new silhouette.
function setPose3D(poseName) {
  if (!sceneInited3D || !meshRecords3D.length) return;
  applyPose3D(poseName, { reframe: true });
  document.querySelectorAll('.pose-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pose === currentPose3D);
  });
}


// Head depth is relative to the head's own width — never the 2D width/height.
// (Head is always a plain box, so an in-place geometry resize is safe here.)
function updateHeadDepth(value) {
  headDepthMult = parseFloat(value);
  const valEl = document.getElementById('depth-head-val');
  if (valEl) valEl.textContent = headDepthMult.toFixed(1) + '×';
  meshRecords3D.forEach(rec => {
    if (rec.group !== 'head') return;
    rec.mesh.geometry.dispose();
    rec.mesh.geometry = new THREE.BoxGeometry(rec.wCm, rec.hCm, headDepthMult * rec.wCm);
    rec.mesh.children.forEach(c => {
      if (c.geometry) { c.geometry.dispose(); c.geometry = new THREE.EdgesGeometry(rec.mesh.geometry); }
    });
  });
}

// Body depth affects torso/waist/legs/feet (and, via the hourglass
// split, tapers into trapezoid meshes rather than plain boxes) — a mix of
// geometry types that can't all be resized in place, so this just rebuilds
// the whole model from the current 2D layout.
function updateBodyDepth(value) {
  bodyDepthMult = parseFloat(value);
  const valEl = document.getElementById('depth-body-val');
  if (valEl) valEl.textContent = bodyDepthMult.toFixed(1) + '×';
  buildBody3D();
}

// Hourglass pinch amount, as a % of the waist/hip box's own width. Rebuilds
// for the same reason as updateBodyDepth (trapezoid geometry, not a resize).
function updateWaistlinePct(value) {
  waistlinePct = parseFloat(value);
  const valEl = document.getElementById('waistline-pct-val');
  if (valEl) valEl.textContent = Math.round(waistlinePct) + '%';
  buildBody3D();
}

function recenterBody3D() {
  if (!sceneInited3D || !meshRecords3D.length) return;
  buildBody3D._hasFramed = false;
  groundBody3D(true);
}

function switchBodyView(view) {
  const el2D = document.getElementById('preview'), el3D = document.getElementById('preview3D');
  const btn2D = document.getElementById('view2DBtn'), btn3D = document.getElementById('view3DBtn');
  const depthPanel = document.getElementById('depthPanel');
  const poseModalToggle = document.getElementById('poseModalToggle');
  if (view === '3d') {
    el2D.style.display = 'none'; el3D.style.display = 'block'; depthPanel.style.display = 'block';
    if (poseModalToggle) poseModalToggle.classList.add('visible');
    btn2D.classList.remove('active'); btn3D.classList.add('active');
    if (!sceneInited3D) { initScene3D(); buildBody3D(); }
    requestAnimationFrame(resizeBody3D);
  } else {
    el2D.style.display = 'flex'; el3D.style.display = 'none'; depthPanel.style.display = 'none';
    if (poseModalToggle) poseModalToggle.classList.remove('visible');
    closePoseModal();
    btn3D.classList.remove('active'); btn2D.classList.add('active');
  }
}

// ---- Pose / Hand-Wrist popup (stage 7) -------------------------------------
// The Pose panel and Hand/Wrist Facing panel used to sit permanently inline
// below the 3D canvas (shown/hidden only by switchBodyView above); they now
// live inside this popup instead so the 3D view itself has room to breathe.
// Nothing about how the panels WORK changed — setPose3D, setHandWristTargetSide,
// savePoseFromHandWristPanel etc. all still just look up the same element IDs,
// which still exist, just nested one level deeper in the DOM now.
function openPoseModal() {
  const overlay = document.getElementById('poseModalOverlay');
  if (overlay) overlay.classList.add('open');
}
function closePoseModal() {
  const overlay = document.getElementById('poseModalOverlay');
  if (overlay) overlay.classList.remove('open');
}
function switchPoseModalTab(tab) {
  const poseTab = document.getElementById('poseModalTabPose');
  const handTab = document.getElementById('poseModalTabHand');
  const poseBtn = document.getElementById('poseModalTabPoseBtn');
  const handBtn = document.getElementById('poseModalTabHandBtn');
  if (poseTab) poseTab.classList.toggle('active', tab === 'pose');
  if (handTab) handTab.classList.toggle('active', tab === 'hand');
  if (poseBtn) poseBtn.classList.toggle('active', tab === 'pose');
  if (handBtn) handBtn.classList.toggle('active', tab === 'hand');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePoseModal();
});
