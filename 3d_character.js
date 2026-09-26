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
const rad2deg = r => r * 180 / Math.PI;

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
// Wrist bend (hinge) limit: about 80° each way (negative = flexion, positive =
// extension). Applied to every source (poses, dropdowns, typed numbers, drag).
const WRIST_BEND_RANGE = [-80, 80];
const clampWristBend = (deg) => Math.min(WRIST_BEND_RANGE[1], Math.max(WRIST_BEND_RANGE[0], deg || 0));
// Wrist swing (side-to-side, in the HAND's own frame — radial/ulnar deviation).
// Positive = toward the thumb side (radial, small range), negative = toward the
// pinky side (ulnar, larger range). Same number on both hands = mirrored pair.
const WRIST_SWING_RANGE = [-40, 20];
const clampWristSwing = (deg) => Math.min(WRIST_SWING_RANGE[1], Math.max(WRIST_SWING_RANGE[0], deg || 0));
// Overrides hold a preset word ('front'...) or a plain number of degrees.
// The pose's own built-in facing for one side, ignoring anything saved on top.
function literalFacing3D(poseName, side) {
  const pose = POSES3D[poseName]; if (!pose) return { turn: 0, wrist: 0 };
  const rec = Object.assign({}, pose[side]);
  ['wristTurn', 'wrist', 'handRotation', 'wristRotation', 'wristTurnEdit'].forEach(f => delete rec[f]);
  Object.assign(rec, (poseLiteralFacing3D && poseLiteralFacing3D[poseName] && poseLiteralFacing3D[poseName][side]) || {});
  const ex = expandPose3D(Object.assign({}, pose, { [side]: rec }));
  return side === 'left' ? { turn: ex.wristTurnL, wrist: ex.wristL } : { turn: ex.wristTurnR, wrist: ex.wristR };
}
const ovSet = (v) => v !== null && v !== undefined && v !== '';
const handOvDeg = (side, v) => typeof v === 'number' ? v : HAND_ROTATION_DEG[side][v];
const wristOvDeg = (v) => typeof v === 'number' ? v : WRIST_ROTATION_DEG[v];
const clampTurnFree = (deg) => Math.min(180, Math.max(-180, deg || 0));
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
  // Palm vs back is decided by how far the hand is actually turned about the
  // forearm (left turns by -t, right by +t), so it also reads correctly for
  // mirrored values outside a hand's usual range. Same result as before for
  // in-range values.
  const t = wristTurnDeg || 0;
  let y = side === 'left' ? -t : t;
  y = ((y + 180) % 360 + 360) % 360 - 180;
  return Math.abs(y) < 90;
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
    wristSwingL: pick(L, 'wristSwing'), wristSwingR: pick(R, 'wristSwing'),
    wristTurnEditL: L.wristTurnEdit, wristTurnEditR: R.wristTurnEdit, // saved edits: not limited to the hand's usual range (so a mirrored hand can be saved)
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

// ---- Pinned Mesh / Pinned Face Part dropdowns ----
// Reuses the same fixed-mesh anchors the old system indexed by name (head,
// neck, torso, waist, legs, feet) — see MESH_PIN_ANCHORS_3D further down.
// FACE_FRACS_3D turns a face name into the box-fraction coordinates
// boxTargetPoint3D already understands (0/1 on y = bottom/top, ±0.5 on x/z
// = the side/front/back surfaces, 0 = center on any axis).
const FACE_FRACS_3D = {
  front:  { x: 0,    y: 0.5, z: 0.5  },
  back:   { x: 0,    y: 0.5, z: -0.5 },
  left:   { x: -0.5, y: 0.5, z: 0    },
  right:  { x: 0.5,  y: 0.5, z: 0    },
  top:    { x: 0,    y: 1,   z: 0    },
  bottom: { x: 0,    y: 0,   z: 0    },
};
const PIN_MESH_LABELS_3D = { head: 'Head', neck: 'Neck', torso: 'Torso', waist: 'Waist/Hip', leftLeg: 'Left Leg', rightLeg: 'Right Leg', leftFoot: 'Left Foot', rightFoot: 'Right Foot' };
const PIN_FACE_LABELS_3D = { front: 'Front', back: 'Back', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };

// Resolves a mesh+face pin descriptor to a concrete spine-local point on
// that face, given the CURRENT body geometry — used both to establish the
// offset the moment a pin is picked, and every render afterward to see how
// far that face has moved since. Returns null if the mesh isn't built this
// side (e.g. a missing leg).
function resolvePinFacePoint3D(meshKey, faceKey, geom) {
  const anchor = MESH_PIN_ANCHORS_3D[meshKey];
  if (!anchor) return null;
  const box = anchor.get(geom);
  if (!box) return null;
  const frac = FACE_FRACS_3D[faceKey] || FACE_FRACS_3D.front;
  let point = boxTargetPoint3D(box, frac.x, frac.y, frac.z);
  if (point && anchor.pelvisAnchored) {
    const sd = geom.spineDeg || { bend: 0, twist: 0, side: 0 };
    point = pelvisPointToSpineLocal3D(point, sd.bend, sd.twist, sd.side);
  }
  return point;
}
// Current absolute (spine-local) wrist position for a side, reading
// whatever's actually being rendered right now (works whether that side is
// currently pinned, at its default, or still on the legacy fixed-angle
// path) — used the instant a mesh/face dropdown changes, so "how far is the
// hand from that face" is measured from wherever the hand visually is.
function currentWristSpineLocalPos3D(side) {
  const grp = rig3D[side + 'Wrist'];
  if (!grp || !rig3D.spine) return null;
  rig3D.spine.updateMatrixWorld(true);
  const w = new THREE.Vector3();
  grp.getWorldPosition(w);
  return rig3D.spine.worldToLocal(w);
}
// "Pinned Mesh" dropdown — picks which fixed body mesh this hand tracks.
// Clearing it (empty value) unpins the hand back to its Default Setter
// position. Changing the mesh with no face chosen yet defaults to 'front'.
function setPinnedMesh3D(side, meshKey) {
  const pose = POSES3D[currentPose3D];
  if (!pose) return;
  if (!meshKey) { unpinHandWrist3D(side); return; }
  const existing = pose[side] && pose[side].handTarget;
  const face = (existing && existing.face) || 'front';
  commitHandPin3D(side, meshKey, face);
}
// "Pinned Face Part" dropdown — picks which face of the already-chosen mesh
// this hand tracks. No-op if no mesh is chosen yet.
function setPinnedFace3D(side, faceKey) {
  const pose = POSES3D[currentPose3D];
  const existing = pose && pose[side] && pose[side].handTarget;
  if (!existing || !existing.mesh) return;
  commitHandPin3D(side, existing.mesh, faceKey);
}
// Shared by both dropdowns: measures the hand's CURRENT position, computes
// its offset from the chosen face at the CURRENT body size, and saves that
// as the pin — the hand does not move when this runs (see the block
// comment above FACE_FRACS_3D).
function commitHandPin3D(side, meshKey, faceKey) {
  const pose = POSES3D[currentPose3D];
  if (!pose) return;
  const facePoint = resolvePinFacePoint3D(meshKey, faceKey, ikContext3D);
  const wristPos = currentWristSpineLocalPos3D(side);
  if (!facePoint || !wristPos) { alert("Can't pin — that mesh isn't built on this side/body."); return; }
  pose[side] = pose[side] || {};
  pose[side].handTarget = {
    mesh: meshKey, face: faceKey,
    offset: { x: round2(wristPos.x - facePoint.x), y: round2(wristPos.y - facePoint.y), z: round2(wristPos.z - facePoint.z) },
  };
  jointEditorPinDirty3D[side] = true;
  setPinSaveStatus3D(`Pinned ${side} hand to ${describePin3D(pose[side].handTarget)}`);
  schedulePinSave3D(currentPose3D, side);
  updateJePinStatus3D();
  applyPose3D(currentPose3D, { reframe: false });
}
// Clears a hand's pin — it goes back to tracking the Default Setter's saved
// wrist position (or the legacy fixed-angle path if no default is captured
// yet). Renamed from the old unpinHandWrist (kept as a thin alias below for
// anything still calling the old name/signature).
function unpinHandWrist3D(side) {
  const pose = POSES3D[currentPose3D];
  if (!pose || !pose[side] || pose[side].handTarget === undefined) return;
  delete pose[side].handTarget;
  jointEditorPinDirty3D[side] = true;
  schedulePinSave3D(currentPose3D, side);
  updateJePinStatus3D();
  applyPose3D(currentPose3D, { reframe: false });
}

// ---- Default Setter ----
// Reference body this project's poses/pins are captured against: 175cm
// height, male, BASELINE_SHOULDER_LENGTH_CM (21.4cm) shoulder length — the
// same baseline already documented above for the fixed-angle poses. Dial
// the Height/Gender inputs to this (shoulder/waist length follow from the
// 2D layout automatically) and tap "Set as Default" once; from then on
// every side's pin/elbow math is relative to whatever got captured here.
const PIN_DEFAULT_REF_3D = { heightCm: 175, gender: 'male', shoulderLengthCm: BASELINE_SHOULDER_LENGTH_CM, waistLengthCm: BASELINE_SHOULDER_LENGTH_CM };
// { left: {shoulder:{x,y,z}, elbow:{x,y,z}, wrist:{x,y,z}}, right: {...} } —
// captured once by captureDefaultSetter3D(), persisted alongside the other
// 3D-editor state (see PIN_DEFAULTS_KEY / quickSaveJointsToGitHub3D).
let pinDefaults3D = { left: null, right: null };
function jointWorldPosSpineLocal3D(side, jointName) {
  const grp = rig3D[side + jointName];
  if (!grp || !rig3D.spine) return null;
  rig3D.spine.updateMatrixWorld(true);
  const w = new THREE.Vector3();
  grp.getWorldPosition(w);
  const p = rig3D.spine.worldToLocal(w);
  return { x: round2(p.x), y: round2(p.y), z: round2(p.z) };
}
// Captures the CURRENT rig's wrist/elbow/shoulder positions as the default
// for one side (or both). Meant to be run once the Height/Gender inputs
// match PIN_DEFAULT_REF_3D and the pose is a neutral/relaxed one — but
// nothing stops it being re-run at any time if a different baseline is
// wanted; whatever's captured here simply becomes every future render's
// "default" reference for that side.
function captureDefaultSetter3D(side) {
  const sides = (side === 'left' || side === 'right') ? [side] : ['left', 'right'];
  const h = parseFloat(document.getElementById('heightInput') && document.getElementById('heightInput').value);
  const g = document.getElementById('genderSelect') && document.getElementById('genderSelect').value;
  if (Math.abs((h || 0) - PIN_DEFAULT_REF_3D.heightCm) > 0.5 || g !== PIN_DEFAULT_REF_3D.gender) {
    if (!confirm(`Default Setter is meant to be captured at ${PIN_DEFAULT_REF_3D.heightCm}cm / ${PIN_DEFAULT_REF_3D.gender} (currently ${h || '?'}cm / ${g || '?'}). Capture anyway?`)) return;
  }
  sides.forEach(sd => {
    const shoulder = jointWorldPosSpineLocal3D(sd, 'Shoulder');
    const elbow = jointWorldPosSpineLocal3D(sd, 'Elbow');
    const wrist = jointWorldPosSpineLocal3D(sd, 'Wrist');
    if (shoulder && elbow && wrist) pinDefaults3D[sd] = { shoulder, elbow, wrist };
  });
  schedulePinSave3D(currentPose3D, 'left'); // piggybacks the existing GitHub push chain (see PIN_DEFAULTS_KEY below)
  setPinSaveStatus3D('Default Setter captured — pins and elbows now relative to this.');
  applyPose3D(currentPose3D, { reframe: false });
}

// ── (legacy click-to-pin section removed — superseded by the Pinned Mesh /
// Pinned Face Part dropdowns above) ─────────────────────────────────────
// round2: rounds to 2 decimal places (cm-precision offsets/positions).
const round2 = n => Math.round(n * 100) / 100;

// Lazily records the current pose's pins the first time the editor changes
// them this session, so Cancel can put them back. Shape-agnostic — clones
// whatever `handTarget` currently holds (the new {mesh,face,offset} pin
// format), so it doesn't need to know the pin's internal fields.
function snapshotPinsForCancel3D() {
  if (jointEditorPinCopySnapshot3D) return;
  const cur = POSES3D[currentPose3D];
  const snap = { key: currentPose3D };
  ['left', 'right'].forEach(sd => {
    const t = cur && cur[sd] && cur[sd].handTarget;
    snap[sd] = t === undefined ? undefined : JSON.parse(JSON.stringify(t));
  });
  jointEditorPinCopySnapshot3D = snap;
}

// Human-readable summary of a pin in the new {mesh, face, offset} shape.
function describePin3D(ht) {
  if (!ht || !ht.mesh) return 'not pinned';
  const mesh = PIN_MESH_LABELS_3D[ht.mesh] || ht.mesh;
  const face = PIN_FACE_LABELS_3D[ht.face] || ht.face || '';
  const off = pinOffsetText3D(ht);
  return (face ? `${mesh} — ${face}` : mesh) + off;
}
// ", 3.2 cm off" — how far the hand currently sits from the pinned face.
function pinOffsetText3D(ht) {
  if (!ht || !ht.offset) return '';
  const d = Math.hypot(ht.offset.x || 0, ht.offset.y || 0, ht.offset.z || 0);
  return `, ${d.toFixed(1)} cm off`;
}
// Editor wrist-panel readout for the selected side's current pin — also
// keeps the Pinned Mesh / Pinned Face Part dropdowns in sync with it.
function updateJePinStatus3D() {
  const el = document.getElementById('jePinStatus');
  if (!selectedJoint3D || selectedJoint3D.jointType !== 'wrist') { if (el) el.textContent = ''; return; }
  const pose = POSES3D[currentPose3D];
  const side = selectedJoint3D.side;
  const ht = pose && pose[side] && pose[side].handTarget;
  if (el) el.textContent = ht ? `Pinned to: ${describePin3D(ht)}` : 'Not pinned — using the Default Setter position';
  const meshSel = document.getElementById('jePinnedMesh');
  if (meshSel) meshSel.value = (ht && ht.mesh) || '';
  const faceSel = document.getElementById('jePinnedFace');
  if (faceSel) { faceSel.disabled = !(ht && ht.mesh); faceSel.value = (ht && ht.face) || 'front'; }
  if (typeof updatePinGlow3D === 'function') updatePinGlow3D();
}

// ---- Saving pins/defaults to GitHub (same pose-overrides.json as pose edits) ----
// Pins ride in the same per-pose, per-side records as wrist/elbow edits, under
// a `handTarget` field (null = "unpinned"), so the existing pull re-applies
// them on load. Debounced and serialized so several quick pin changes become
// one commit and never race each other's file sha. The Default Setter's
// captured positions ride along in the same file under PIN_DEFAULTS_KEY (see
// quickSaveJointsToGitHub3D/quickLoadJointsFromGitHub3D near the bottom).
let pinPushChain3D = Promise.resolve();
const pinPushTimers3D = {};
function setPinSaveStatus3D(msg, ms) {
  const el = document.getElementById('hwSaveStatus');
  if (!el) return;
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => { el.style.opacity = '0'; }, ms || 2600);
}
function flushPinSave3D(poseKey, side) {
  const run = async () => {
    const pose = POSES3D[poseKey];
    const s = ghGetSettings();
    if (!pose || !s.token || !s.owner || !s.repo) return; // no token entered yet: session-only, same as other edits
    const ht = pose[side] && pose[side].handTarget;
    try {
      await pushPoseOverrideToGitHub(poseKey, side, { handTarget: ht === undefined ? null : ht });
      await pushPinDefaultsToGitHub3D();
      setPinSaveStatus3D(`Saved ${side} hand pin for "${pose.label}" to GitHub`);
    } catch (e) { setPinSaveStatus3D(`Pin save to GitHub failed: ${e.message}`, 4000); }
  };
  pinPushChain3D = pinPushChain3D.then(run, run);
  return pinPushChain3D;
}
function schedulePinSave3D(poseKey, side) {
  const k = poseKey + '|' + side;
  clearTimeout(pinPushTimers3D[k]);
  pinPushTimers3D[k] = setTimeout(() => { delete pinPushTimers3D[k]; flushPinSave3D(poseKey, side); }, 1200);
}
// Persists pinDefaults3D (the Default Setter's captured positions) into the
// same pose-overrides.json file, under its own top-level key so the regular
// per-pose Load logic ignores it harmlessly (same pattern as JOINT_EDITS_KEY).
const PIN_DEFAULTS_KEY = '__pinDefaults3D';
async function pushPinDefaultsToGitHub3D() {
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) return;
  if (!pinDefaults3D.left && !pinDefaults3D.right) return;
  await githubUpdatePoseOverrides3D('Save Default Setter positions', all => { all[PIN_DEFAULTS_KEY] = pinDefaults3D; });
}
// Clears the pin for one side (or both, via the side selector), reverting
// that hand to its Default Setter position (or the legacy fixed-angle path
// if no default has been captured yet).
function unpinHandWrist() {
  const sides = handWristTargetSide === 'both' ? ['left', 'right'] : [handWristTargetSide];
  sides.forEach(s => unpinHandWrist3D(s));
  refreshHandWristButtons();
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
// Remembers the hard-coded pins so Reset can undo unsaved (and stale) ones.
function capturePoseLiteralPins3D() {
  if (poseLiteralPins3D || typeof POSES3D === 'undefined') return;
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
  poseLiteralPins3D = {};
  Object.keys(POSES3D).forEach(k => {
    poseLiteralPins3D[k] = {};
    ['left', 'right'].forEach(side => {
      const t = POSES3D[k][side] && POSES3D[k][side].handTarget;
      if (t !== undefined) poseLiteralPins3D[k][side] = JSON.parse(JSON.stringify(t));
    });
  });
}
// Applies a parsed pose-overrides.json (everything except the joint-edit blob)
// on top of POSES3D.
function applyPoseOverridesData3D(all) {
  Object.keys(all).forEach(poseKey => {
    if (poseKey === '_jointEdits') return; // joint-editor save blob, handled separately
    const pose = POSES3D[poseKey];
    if (!pose) return;
    ['left', 'right'].forEach(side => {
      const fields = all[poseKey][side];
      if (!fields) return;
      pose[side] = pose[side] || {};
      const f = Object.assign({}, fields);
      // handTarget: null is a saved "unpinned" — remove it rather than assign null
      if ('handTarget' in f && f.handTarget == null) { delete pose[side].handTarget; delete f.handTarget; }
      Object.assign(pose[side], f);
    });
  });
}
async function pullPoseOverridesFromGitHub() {
  capturePoseLiteralPins3D();
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
    // Default Setter positions ride in the same file too (see PIN_DEFAULTS_KEY).
    if (all[PIN_DEFAULTS_KEY]) { pinDefaults3D = all[PIN_DEFAULTS_KEY]; if (sceneInited3D) applyPose3D(currentPose3D, { reframe: false }); }
  } catch (e) { console.warn('Could not load pose edits from GitHub:', e); }
}
// Pushes one side's saved fields for one pose up to the GitHub file,
// merging with whatever's already saved for other poses/sides (fetches the
// current file first so this doesn't clobber edits saved from elsewhere).
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
async function pushPoseOverrideToGitHub(poseKey, side, fields) {
  await githubUpdatePoseOverrides3D(`Save pose edit: ${poseKey} (${side})`, all => {
    all[poseKey] = all[poseKey] || {};
    all[poseKey][side] = Object.assign({}, all[poseKey][side], fields);
    // null = remove that saved field (handTarget:null is a real saved "unpinned", keep it)
    Object.keys(fields).forEach(k => { if (fields[k] === null && k !== 'handTarget') delete all[poseKey][side][k]; });
  });
}
// Wipes the saved pose-edits file from the repo and reloads, so POSES3D
// comes back purely from the hardcoded literal below with nothing re-applied
// on top — the escape hatch if a saved edit needs undoing back to original.
async function clearAllSavedPoseEdits() {
  const s = ghGetSettings();
  if (!s.token || !s.owner || !s.repo) { alert('Set your GitHub token in the GitHub Presets panel first (needed to clear saved edits).'); return; }
  if (!confirm('Delete the pose-edits file from GitHub (pose edits, hand pins AND saved 3D joint edits) and reload the page?')) return;
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
// whichever fields haven't been). wristTurn/wrist/wristSwing (hand facing)
// are always real, pose-authored numbers now — position-based pinning only
// ever drives the shoulder/elbow (see applyArmPosition3D), never the hand's
// own facing — so they always save normally. elbow/shoulderAbd are
// different: on a side currently running the position-based system
// (isPositioned) those are pure by-products of the 3D aim solve every
// render, so baking in raw numbers would just leave dead fields that path
// ignores; only a fixed-angle side saves them. Any handTarget (mesh/face
// pin) already on the pose is left exactly as authored either way — this
// is the "/pin" part of the panel state: nothing here overwrites it.
// Also pushes the same fields to a JSON file in your GitHub repo (see
// above) so the edit survives a page reload, not just the rest of this
// session — needs owner/repo/token filled in on the GitHub Presets panel.
async function savePoseFromHandWristPanel() {
  const pose = POSES3D[currentPose3D];
  if (!pose || !lastPoseResolved3D) return;
  const toPush = [];
  ['left', 'right'].forEach(side => {
    const resolved = lastPoseResolved3D[side];
    if (!resolved) return;
    pose[side] = pose[side] || {};
    pose[side].wristTurn = round1(resolved.wristTurn);
    pose[side].wrist = round1(resolved.wrist);
    pose[side].wristSwing = round1(resolved.swing || 0);
    const fields = { wristTurn: pose[side].wristTurn, wrist: pose[side].wrist, wristSwing: pose[side].wristSwing };
    if (!resolved.isPositioned) {
      pose[side].elbow = round1(resolved.elbow);
      pose[side].shoulderAbd = round1(resolved.shoulderAbd);
      fields.elbow = pose[side].elbow;
      fields.shoulderAbd = pose[side].shoulderAbd;
    }
    // The values above are now the per-side source of truth going forward,
    // so drop any word-alias fields on this side that would otherwise still
    // take priority over a *shared* (non-side) raw field per expandPose3D's
    // pick order — they can't out-rank what we just wrote on the same side,
    // but leaving stale ones around is just confusing to read later.
    delete pose[side].handRotation;
    delete pose[side].wristRotation;
    toPush.push({ side, fields });
  });
  // The pose's own numbers now already equal what the overrides were
  // producing, so clear the overrides — leaving them active would just be
  // silently re-applying the same values on top of their new home.
  handRotationOverride = { left: null, right: null };
  wristRotationOverride = { left: null, right: null };
  wristSwingOverride = { left: null, right: null };
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
  'stand-hands-hips':      { section:'Standing', label:'Hands on Hips', shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35, right:{}, left:{} },
  'stand-arms-overhead':   { section:'Standing', label:'Arms Overhead', shoulder:-175, elbow:-5 },
  'stand-arms-crossed':    { section:'Standing', label:'Arms Crossed', shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80 },
  'stand-one-hand-hip':    { section:'Standing', label:'One Hand on Hip', right:{shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35} },
  'stand-weight-shift':    { section:'Standing', label:'Weight on One Hip', spineSide:6, right:{hipAbd:9}, left:{hipAbd:2} },
  'stand-hip-pop':         { section:'Standing', label:'Hip Pop', spineSide:10, right:{hipAbd:15}, left:{hipAbd:-2} },
  'stand-arms-behind':     { section:'Standing', label:'Arms Behind Back', shoulder:55, elbow:-90, wrist:-15, wristTurn:-90, right:{}, left:{} },
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
  'squat-hands-hips':   { section:'Squatting', label:'Wide Squat, Hands on Hips', hip:-118, knee:135, ankle:-25, hipAbd:32, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35, right:{}, left:{} },
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
  'model-hands-hips':   { section:'Model Poses', label:'Both Hands on Hips', spineSide:12, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35, right:{hipAbd:16}, left:{} },
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
  'model-power-wide':   { section:'Model Poses', label:'Wide Power Stance', spineBend:-6, hipAbd:22, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35, right:{}, left:{} },
  'model-runway-swing': { section:'Model Poses', label:'Runway Walk, Arms Swinging', right:{hip:-35, knee:10, shoulder:35}, left:{hip:30, knee:10, shoulder:-30} },
  'model-jacket-over':  { section:'Model Poses', label:'Jacket Over Shoulder', spineTwist:-15, right:{shoulder:60, elbow:-20, wrist:-40}, left:{shoulder:-40, elbow:-110, shoulderAbd:10, wrist:-15} },
  'model-lean-wall':    { section:'Model Poses', label:'Crossed Legs, Leaning', spineSide:18, shoulder:-5, shoulderAbd:30, shoulderRoll:-70, elbow:-105, wrist:-70, wristTurn:80, right:{hipAbd:14}, left:{hip:8, hipAbd:-10} },
  'model-fierce-hips':  { section:'Model Poses', label:'Fierce, Hands on Hips', spineSide:-10, hipAbd:18, shoulder:40, shoulderAbd:25, shoulderRoll:-30, elbow:-80, wrist:-25, wristTurn:35, right:{}, left:{} },
  'model-collarbone':   { section:'Model Poses', label:'Elegant Hand at Collarbone', spineTwist:12, right:{shoulder:90, shoulderAbd:90, elbow:-158, wrist:-30, wristTurn:-20} },
  'model-dynamic-jump': { section:'Model Poses', label:'Dynamic Editorial Jump', spineSide:10, hipAbd:20, knee:20, shoulder:-40, shoulderAbd:65 },
};
// Re-apply any pose edits saved from a previous visit (see the Save button /
// GitHub helpers above). This is async (a network request), so it can't
// finish before the pose panel render at the bottom of the file or the very
// first applyPose3D() call; those still run against the plain-literal
// defaults first, and pullPoseOverridesFromGitHub() re-applies the current
// pose on top once the fetch resolves a moment later.
pullPoseOverridesFromGitHub();

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
  initJointEditor3D();
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
  updateWristSliderOverlay3D();
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
let ikContext3D = { headBox: null, neckBox: null, torsoBox: null, waistBox: null, legBoxes: { left: null, right: null }, footBoxes: { left: null, right: null }, waistTopY: 0, shoulders: {}, armLens: {}, handDepths: {}, spineDeg: { bend: 0, twist: 0, side: 0 } };

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

// ---- Generic mesh-face pinning ---------------------------------------------
// Pin a hand to ANY of the body's rest-position boxes (not just head/torso/
// waist), at a named FACE of that box (front/back/left/right/top/bottom —
// see FACE_FRACS_3D above), given as fractions of that box's OWN current
// width/height/depth. Because the fractions are read fresh off that box's
// current size every rebuild, a pinned face automatically tracks the mesh
// through any resize with no extra math — see resolvePinFacePoint3D above.
// Deliberately limited to boxes that sit at a fixed rest position relative
// to their own parent (pelvis or spine) — head, neck, torso, waist/hip, and
// the legs/feet. Arms and hands are themselves posed (rotated by whatever
// the shoulder/elbow are doing), so their CURRENT world position isn't
// recoverable from the flat 2D box alone — pinning a hand to the OTHER hand/
// arm isn't supported by this system.
// `pelvisAnchored: true` marks a box that hangs off the pelvis (bodyGroup3D)
// rather than the spine pivot — its raw point needs the same
// pelvisPointToSpineLocal3D correction, or a spine bend/twist will pull the
// pin off the mesh it's supposed to sit on.
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

const v3 = (x, y, z) => ({ x, y, z });
const v3sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const v3add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const v3dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const v3cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const v3len = (a) => Math.hypot(a.x, a.y, a.z);
const v3norm = (a) => { const l = v3len(a) || 1; return v3(a.x / l, a.y / l, a.z / l); };
const v3scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);

// Builds a bone's Euler angles (matching three.js's default 'XYZ' Object3D
// rotation order, so this is exactly what gets assigned to
// rotation.x/.y/.z) from two things: the direction the bone should point
// (aimDir, negated — the rest pose points down local -y), and a rough
// "which way is up" hint (hingeDir) used only to fix the otherwise-
// ambiguous roll about the bone's own long axis. Both vectors are in the
// SAME local frame as the bone's parent (i.e. the frame the bone's own
// position/rotation are defined in).
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
    // Gimbal lock (roll ≈ ±90°) — extremely unlikely in practice, but fall
    // back to something valid rather than producing NaN.
    flexRad = Math.atan2(colX.y, colY.y);
    zRad = 0;
  }
  return { flexRad, rollRad, zRad };
}
// Fixed "which way is up" hint used to resolve the shoulder/elbow's roll
// ambiguity when aiming a bone at a target point (see eulerXYZFromAimAndHinge
// above) — mirrors outward/forward/down per side, like a natural human
// elbow, since there's no pose-authored pole vector in this position-only
// system.
function defaultAimHint3D(side) {
  const sideSign = side === 'right' ? 1 : -1;
  return v3(sideSign * 0.5, -0.3, 0.8);
}

// ═══════════════════════════════════════════════════════════════════════
// New position-based hand pin + elbow system.
//
// resolveHandAbsolutePos3D gives the wrist's absolute (spine-local) target
// position for a side: the pinned face + its stored offset if pinned,
// otherwise the Default Setter's saved wrist position (captureDefaultSetter3D)
// shifted by however far the shoulder has moved since capture, otherwise
// null (caller falls back to the legacy fixed-angle rig).
//
// applyArmPosition3D then solves the shoulder→elbow→wrist chain as a proper
// two-bone (law-of-cosines) IK aimed at that target, using the Default
// Setter's captured elbow position only as a POLE HINT for which way the
// elbow bends — never as a literal position — so the target is reached
// exactly whenever it's within the arm's physical reach, regardless of
// where the shoulder itself currently sits (shoulder length, height, etc.
// all resolve fresh every render). The only time the hand lands off-target
// at all is when the target is genuinely out of reach, in which case it's
// pulled in to the nearest reachable point along the same line — the
// smallest possible correction, never a bigger one.
// ═══════════════════════════════════════════════════════════════════════
function resolveHandAbsolutePos3D(side, pose) {
  const ht = pose && pose[side] && pose[side].handTarget;
  if (ht && ht.mesh && ht.offset) {
    const facePoint = resolvePinFacePoint3D(ht.mesh, ht.face, ikContext3D);
    if (facePoint) return v3add(facePoint, ht.offset);
    // Mesh not built this side/body (e.g. a missing leg) — fall through to
    // the default position rather than leaving the hand stranded.
  }
  const def = pinDefaults3D[side];
  if (!def || !def.wrist) return null;
  const wristDefault = v3(def.wrist.x, def.wrist.y, def.wrist.z);
  // Carry the default wrist target along with any shoulder movement since
  // capture (wider/narrower shoulders, a height change, etc.) — otherwise an
  // unpinned hand stays glued to the exact cm point it was captured at while
  // the shoulder it's attached to moves away from it.
  const shoulderNow = ikContext3D.shoulders && ikContext3D.shoulders[side];
  if (def.shoulder && shoulderNow) {
    const shoulderDelta = v3sub(shoulderNow, v3(def.shoulder.x, def.shoulder.y, def.shoulder.z));
    return v3add(wristDefault, shoulderDelta);
  }
  return wristDefault;
}
// Aims shoulderGrp/elbowGrp with a proper two-bone (law-of-cosines) IK solve
// so wristAbsPos is landed on EXACTLY whenever it's within reach of the two
// rigid segments (lens.upper + lens.lower), no matter where the shoulder
// itself currently sits — a shoulder-length change moves shoulderPos, and
// this re-solves fresh from wherever that now is, every render. The
// Default Setter's captured elbow position is used only as a POLE HINT
// (which side the elbow bends toward), never as a literal position to aim
// at — that's what let the old approach drift off a pinned target as soon
// as the shoulder moved: it treated a hint as a target. If wristAbsPos is
// further than the arm can reach (or closer than |upper-lower|), the
// target is pulled in to the nearest reachable point along the same
// direction — the smallest possible correction, never a bigger one.
// Returns true if it ran (defaults are captured for this side), false if
// the caller should fall back to the legacy fixed-angle rig.
function applyArmPosition3D(side, shoulderGrp, elbowGrp, pose) {
  const def = pinDefaults3D[side];
  const shoulderPos = ikContext3D.shoulders[side];
  const lens = ikContext3D.armLens[side];
  if (!def || !def.elbow || !def.wrist || !shoulderGrp || !elbowGrp || !shoulderPos || !lens) return false;
  const wristAbsPos = resolveHandAbsolutePos3D(side, pose);
  if (!wristAbsPos) return false;
  const L1 = lens.upper, L2 = lens.lower;

  // Pole hint: the direction from the CURRENT shoulder toward the Default
  // Setter's captured elbow position — preserves the pose's natural elbow
  // orientation (front/back/out) without pinning the elbow to a stale
  // absolute point.
  let poleDir = v3sub(v3(def.elbow.x, def.elbow.y, def.elbow.z), shoulderPos);
  if (v3len(poleDir) < 1e-6) poleDir = defaultAimHint3D(side);
  poleDir = v3norm(poleDir);

  let toWrist = v3sub(wristAbsPos, shoulderPos);
  let d = v3len(toWrist);
  if (d < 1e-6) toWrist = poleDir, d = 1e-6; // degenerate target — reach straight along the pole, never breaks
  const dirToWrist = v3norm(toWrist);
  const maxReach = L1 + L2, minReach = Math.abs(L1 - L2);
  const dClamped = Math.min(maxReach - 1e-4, Math.max(minReach + 1e-4, d));

  // Law of cosines: angle at the shoulder between the upper-arm segment and
  // the straight line to the (possibly clamped) target.
  const cosA = Math.max(-1, Math.min(1, (L1 * L1 + dClamped * dClamped - L2 * L2) / (2 * L1 * dClamped)));
  const angleAtShoulder = Math.acos(cosA);

  // Bend direction: the pole hint flattened into the plane perpendicular to
  // dirToWrist, so it only ever decides WHICH WAY the elbow bends, never how
  // far the arm reaches.
  let bendDir = v3sub(poleDir, v3scale(dirToWrist, v3dot(poleDir, dirToWrist)));
  if (v3len(bendDir) < 1e-6) {
    const hint = defaultAimHint3D(side);
    bendDir = v3sub(hint, v3scale(dirToWrist, v3dot(hint, dirToWrist)));
  }
  bendDir = v3len(bendDir) < 1e-6 ? v3(1, 0, 0) : v3norm(bendDir);

  // Shoulder → elbow: aim only, length is always exactly L1.
  let elbowDir = v3add(v3scale(dirToWrist, Math.cos(angleAtShoulder)), v3scale(bendDir, Math.sin(angleAtShoulder)));
  elbowDir = v3norm(elbowDir);
  const shoulderEuler = eulerXYZFromAimAndHinge(elbowDir, defaultAimHint3D(side));
  shoulderGrp.rotation.x = shoulderEuler.flexRad;
  shoulderGrp.rotation.y = shoulderEuler.rollRad;
  shoulderGrp.rotation.z = shoulderEuler.zRad;
  const elbowActualPos = v3add(shoulderPos, v3scale(elbowDir, L1));

  // Elbow → wrist: aimed at the same (possibly clamped) target point along
  // dirToWrist — by construction of the law-of-cosines triangle above, this
  // point sits EXACTLY L2 from elbowActualPos, so the segment lands dead on
  // it (equal to wristAbsPos itself whenever the target was in reach).
  const wristTargetForAim = v3add(shoulderPos, v3scale(dirToWrist, dClamped));
  let wristDirWorld = v3sub(wristTargetForAim, elbowActualPos);
  if (v3len(wristDirWorld) < 1e-6) wristDirWorld = elbowDir; // degenerate — keep going straight, never breaks
  wristDirWorld = v3norm(wristDirWorld);
  const invShoulderQuat = shoulderGrp.quaternion.clone().invert();
  const wristDirLocalV = new THREE.Vector3(wristDirWorld.x, wristDirWorld.y, wristDirWorld.z).applyQuaternion(invShoulderQuat);
  const hintLocalV = new THREE.Vector3(defaultAimHint3D(side).x, defaultAimHint3D(side).y, defaultAimHint3D(side).z).applyQuaternion(invShoulderQuat);
  const elbowEuler = eulerXYZFromAimAndHinge(v3(wristDirLocalV.x, wristDirLocalV.y, wristDirLocalV.z), v3(hintLocalV.x, hintLocalV.y, hintLocalV.z));
  elbowGrp.rotation.x = elbowEuler.flexRad;
  elbowGrp.rotation.y = elbowEuler.rollRad;
  elbowGrp.rotation.z = elbowEuler.zRad;
  return true;
}

// (Re)builds every box mesh from the current 2D layout. Called automatically
// every time "Generate" runs, and whenever a depth or waistline slider changes.
function buildBody3D() {
  if (!sceneInited3D) initScene3D();
  // The old rig3D groups (and the joint meshes the editor highlights/attaches
  // its gizmo to) are about to be disposed below — drop the selection and
  // any manual joint edits made against them first, or the gizmo/quaternion
  // math below would be operating on stale, disposed objects.
  if (jointEditorInited3D) deselectJoint3D();
  manualJointEdits3D = {};
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
  ikContext3D = { headBox, neckBox, torsoBox, waistBox, legBoxes, footBoxes, waistTopY, shoulders: {}, armLens: {}, handDepths: {}, spineDeg: ikContext3D.spineDeg || { bend: 0, twist: 0, side: 0 } };

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
  // Female: the waistline sits where the torso meets the hip box. The pinch
  // shrinks the BOTTOM of the torso box and the TOP of the waist/hip box to
  // the same seam width (waistlinePct of the hip box's width), so the two
  // boxes together read as an hourglass. 100% = plain boxes, no pinch.
  function addTaperedBox(box, topWidthCm, bottomWidthCm, targetGroup, yOffset) {
    if (!box) return;
    const { depthCm, zOffset } = computeBodyDepth3D(box);
    const color = groupColor3D[box.group] || 0xaaaaaa;
    const mesh = makeTrapezoidMesh(topWidthCm, bottomWidthCm, box.hCm, depthCm, color);
    mesh.position.set(box.xCm, box.bottomCm + box.hCm / 2 - yOffset, zOffset);
    targetGroup.add(mesh);
    meshRecords3D.push({ mesh, group: box.group, wCm: box.wCm, hCm: box.hCm });
    noteY(box);
  }
  if (gender === 'female' && torsoBox && waistBox && waistlinePct < 100) {
    const seamCm = (waistlinePct / 100) * waistBox.wCm;
    addTaperedBox(torsoBox, torsoBox.wCm, Math.min(seamCm, torsoBox.wCm), spineGroup, waistTopY);
    addTaperedBox(waistBox, Math.min(seamCm, waistBox.wCm), waistBox.wCm, bodyGroup3D, 0);
  } else {
    addTorsoOrWaistBox(torsoBox, gender === 'male', spineGroup, waistTopY);
    addTorsoOrWaistBox(waistBox, false, bodyGroup3D, 0);
  }

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
    // the same frame the Default Setter's captured positions and any hand
    // pin's face point are given in — see resolveHandAbsolutePos3D /
    // captureDefaultSetter3D) and segment lengths, so the position-based arm
    // system can aim using this build's actual proportions.
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
    rig3D[side + 'ElbowJointMesh'] = elbowJoint; // used by the Joint Editor to highlight the selected joint

    // Wrist pivot: the hand hangs from here, in its own local frame (y=0 at
    // the wrist), nested inside the elbow group so a pose can bend/turn the
    // hand independently of whatever the shoulder and elbow are doing. This
    // is the joint that actually lets a hand lie flat against a hip, tuck
    // under an opposite forearm, or curl to support a chin — without it the
    // hand can only ever trail along as a rigid extension of the forearm.
    const wristGroup = new THREE.Group();
    // Turn first (about the forearm's long axis), THEN Bend in the hand's own
    // frame — so Bend is always finger-flexion toward/away from the palm, no
    // matter how far the hand is turned (order 'YXZ' = Ry(turn)·Rx(bend)).
    wristGroup.rotation.order = 'YXZ';
    wristGroup.position.set(0, -lowerH, 0);
    elbowGroup.add(wristGroup);
    rig3D[side + 'Wrist'] = wristGroup;

    if (handBox) {
      const handDepthCm = computeBodyDepth3D(handBox).depthCm;
      ikContext3D.handDepths[side] = handDepthCm;
      const wristJointCm = handBox.wCm * 0.6;
      const wristJoint = makeJointSphere(wristJointCm);
      wristJoint.position.set(0, 0, 0);
      wristGroup.add(wristJoint);
      meshRecords3D.push({ mesh: wristJoint, group: 'joint', wCm: wristJointCm, hCm: wristJointCm });
      rig3D[side + 'WristJointMesh'] = wristJoint; // used by the Joint Editor to highlight the selected joint

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
  // A rebuild wipes manual joint edits (above) — put the saved ones back.
  applySavedJointEdits3D();
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
  keptWristQuat3D = { left: null, right: null };

  // Hand/Wrist Facing panel overrides win over whatever the named pose set,
  // on whichever side(s) have an override active.
  let turnFreeL = false, turnFreeR = false; // edited turns may use the full -180..180 (mirror needs this)
  if (p.wristTurnEditL !== undefined) { p.wristTurnL = p.wristTurnEditL; turnFreeL = true; }
  if (p.wristTurnEditR !== undefined) { p.wristTurnR = p.wristTurnEditR; turnFreeR = true; }
  if (ovSet(handRotationOverride.left)) turnFreeL = handRotationOverride.left !== 'default';
  if (ovSet(handRotationOverride.right)) turnFreeR = handRotationOverride.right !== 'default';
  if (ovSet(handRotationOverride.left)) p.wristTurnL = handRotationOverride.left === 'default' ? literalFacing3D(currentPose3D, 'left').turn : handOvDeg('left', handRotationOverride.left);
  if (ovSet(handRotationOverride.right)) p.wristTurnR = handRotationOverride.right === 'default' ? literalFacing3D(currentPose3D, 'right').turn : handOvDeg('right', handRotationOverride.right);
  if (ovSet(wristRotationOverride.left)) p.wristL = wristRotationOverride.left === 'default' ? literalFacing3D(currentPose3D, 'left').wrist : wristOvDeg(wristRotationOverride.left);
  if (ovSet(wristRotationOverride.right)) p.wristR = wristRotationOverride.right === 'default' ? literalFacing3D(currentPose3D, 'right').wrist : wristOvDeg(wristRotationOverride.right);
  p.wristL = clampWristBend(p.wristL); p.wristR = clampWristBend(p.wristR);
  if (ovSet(wristSwingOverride.left))  p.wristSwingL = wristSwingOverride.left;
  if (ovSet(wristSwingOverride.right)) p.wristSwingR = wristSwingOverride.right;
  p.wristSwingL = clampWristSwing(p.wristSwingL); p.wristSwingR = clampWristSwing(p.wristSwingR);

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
  // Position-driven arms (a Default Setter has been captured for that side,
  // see captureDefaultSetter3D/applyArmPosition3D) fully determine their own
  // shoulder+elbow every render and skip the fixed-angle path entirely —
  // but never touch wristTurn/wrist/wristSwing, which always come from the
  // pose's own authored numbers either way (hand FACING is independent of
  // hand POSITION in this system). Everything else still uses the authored
  // flex/abd/roll/elbow numbers exactly as before. Pelvis-anchored pin faces
  // (waist, legs, feet) need to know how much the spine is currently
  // bent/twisted/leaned to stay correctly locked — see
  // pelvisPointToSpineLocal3D — so stamp that onto ikContext3D right before
  // resolving, using this pose's own spine numbers.
  ikContext3D.spineDeg = { bend: p.spineBend || 0, twist: p.spineTwist || 0, side: p.spineSide || 0 };
  const leftPositioned = applyArmPosition3D('left', rig3D.leftShoulder, rig3D.leftElbow, p);
  // Actually-applied elbow bend/lift for this render — meaningless for a
  // position-driven side (the aim solve fully owns shoulder/elbow rotation
  // there), kept only so the Save button below has a real number to skip
  // instead of undefined. Declared out here (rather than as consts inside
  // the branch) so the Save button below can read back exactly what was
  // rendered, regardless of which path ran.
  let leftElbowBend = p.elbowL, leftElbowLift = 0;
  if (!leftPositioned) {
    // Clamp wristTurn to its physical range BEFORE positioning the shoulder,
    // so any overshoot can be folded into this same shoulder call as extra
    // abduction (elbow lift) rather than silently vanishing. The Hand/Wrist
    // Facing panel's elbow inputs stack on top of/replace these the same
    // way its hand/wrist word presets already override p.wristTurnL/p.wristL
    // above: elbowLiftOverride ADDS to the auto lift (manual lift on top of
    // whatever the wristTurn clamp already contributed), while
    // elbowBendOverride REPLACES the pose's own elbow angle outright.
    const leftWrist = turnFreeL ? { clamped: clampTurnFree(p.wristTurnL), elbowLift: 0 } : clampWristTurn('left', p.wristTurnL);
    p.wristTurnL = leftWrist.clamped;
    leftElbowLift = leftWrist.elbowLift + (elbowLiftOverride.left || 0);
    leftElbowBend = elbowBendOverride.left != null ? elbowBendOverride.left : p.elbowL;
    setBallJoint(rig3D.leftShoulder, p.shoulderL, (p.shoulderAbdL || 0) + leftElbowLift, -1);
    if (rig3D.leftShoulder) rig3D.leftShoulder.rotation.y = deg2rad((p.shoulderRollL || 0) * -1);
    setHinge(rig3D.leftElbow, leftElbowBend);
  }
  const rightPositioned = applyArmPosition3D('right', rig3D.rightShoulder, rig3D.rightElbow, p);
  let rightElbowBend = p.elbowR, rightElbowLift = 0;
  if (!rightPositioned) {
    const rightWrist = turnFreeR ? { clamped: clampTurnFree(p.wristTurnR), elbowLift: 0 } : clampWristTurn('right', p.wristTurnR);
    p.wristTurnR = rightWrist.clamped;
    rightElbowLift = rightWrist.elbowLift + (elbowLiftOverride.right || 0);
    rightElbowBend = elbowBendOverride.right != null ? elbowBendOverride.right : p.elbowR;
    setBallJoint(rig3D.rightShoulder, p.shoulderR, (p.shoulderAbdR || 0) + rightElbowLift, 1);
    // shoulderRoll: same mirroring convention as hipTurn — applied AFTER the
    // ball joint's flex/abd, on the same shoulder group, so it re-aims the
    // elbow's hinge axis without disturbing flex/abd.
    if (rig3D.rightShoulder) rig3D.rightShoulder.rotation.y = deg2rad((p.shoulderRollR || 0) * 1);
    setHinge(rig3D.rightElbow, rightElbowBend);
  }
  // wrist: bend is a hinge exactly like the elbow (same fixed sign
  // convention — see the pose-authoring notes above); wristTurn re-aims
  // which way the hand block faces by rotating it about the forearm's own
  // long axis, applied AFTER the bend, the same way shoulderRoll is applied
  // after the shoulder's own flex/abd. Mirrored the same way as
  // shoulderRoll/hipTurn: a shared value turns the hands to face each other
  // (useful for clasped hands), not the same way. Unaffected by whether the
  // arm is position-driven or fixed-angle — hand facing is always these
  // plain pose numbers.
  setHinge(rig3D.leftWrist, p.wristL); setHinge(rig3D.rightWrist, p.wristR);
  if (rig3D.leftWrist)  rig3D.leftWrist.rotation.y  = deg2rad((p.wristTurnL || 0) * -1);
  if (rig3D.rightWrist) rig3D.rightWrist.rotation.y = deg2rad((p.wristTurnR || 0) *  1);
  // Swing: side-to-side about the hand's own front-back axis (applied last in
  // the 'YXZ' order, so it follows Turn and Bend). Left is sign-flipped like
  // Turn, so the same number on both hands is a mirrored pair.
  if (rig3D.leftWrist)  rig3D.leftWrist.rotation.z  = deg2rad((p.wristSwingL || 0) * -1);
  if (rig3D.rightWrist) rig3D.rightWrist.rotation.z = deg2rad((p.wristSwingR || 0) *  1);

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
  // gets written to POSES3D is guaranteed to match what's on screen.
  // isPositioned sides are flagged so Save knows to leave their elbow/
  // shoulderAbd alone (pure by-products of the 3D aim solve every render)
  // instead of writing dead angle numbers that path ignores.
  lastPoseResolved3D = {
    left:  { wristTurn: p.wristTurnL, wrist: p.wristL, swing: p.wristSwingL, elbow: leftElbowBend,  shoulderAbd: (p.shoulderAbdL || 0) + leftElbowLift,  isPositioned: !!leftPositioned },
    right: { wristTurn: p.wristTurnR, wrist: p.wristR, swing: p.wristSwingR, elbow: rightElbowBend, shoulderAbd: (p.shoulderAbdR || 0) + rightElbowLift, isPositioned: !!rightPositioned },
  };
  // Re-stamp any manual Joint Editor drags on top of what the pose/IK just
  // computed above, so a hand-dragged elbow/wrist survives pose switches,
  // slider tweaks, and hand/wrist-facing overrides until explicitly reset —
  // see reapplyManualJointEdits3D.
  ['left', 'right'].forEach(sd => {
    const kq = keptWristQuat3D[sd];
    if (kq && rig3D[sd + 'Wrist']) rig3D[sd + 'Wrist'].quaternion.copy(kq); // kept-position pin: exact hand rotation
  });
  if (jointEditorInited3D) reapplyManualJointEdits3D();
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
  // Facing overrides belong to one pose — unsaved ones don't carry to the next.
  handRotationOverride = { left: null, right: null };
  wristRotationOverride = { left: null, right: null };
  wristSwingOverride = { left: null, right: null };
  // Also clear elbow bend/lift overrides — transient preview nudges that
  // were never meant to persist onto a different pose. Manual joint-editor
  // drags (shoulder/elbow/wrist) don't need clearing any more: they're keyed
  // by pose (see manualJointEdits3D/jointEditsForPose3D above), so the new
  // pose automatically gets its own bucket instead of inheriting this one's.
  elbowBendOverride = { left: null, right: null };
  elbowLiftOverride = { left: null, right: null };
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
    autoLoadJointsFromGitHub3D();
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
  if (tab === 'hand') refreshHandWristButtons();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePoseModal();
});

// ============================================================================
// ---- Interactive Joint Editor: wrist & elbow -------------------------------
// Tap the wrist or elbow directly in the 3D view to select it; a Move/Rotate
// arrow gizmo (THREE.TransformControls) appears on it, and a side panel shows
// exact position (cm, relative to the pelvis) and rotation (degrees), for
// when the joint itself is hard to grab (e.g. a wrist tucked into the torso).
//
// Rig recap (see buildArmSide): shoulderGroup -> elbowGroup -> wristGroup,
// each a child of the last, at a FIXED local offset ("bone length") that
// buildArmSide sets once and this editor never changes — only rotations are
// ever touched, which is what keeps every drag anatomically valid:
//   - Dragging the ELBOW's position re-aims the SHOULDER so the elbow lands
//     at the requested spot on the sphere its fixed upper-arm length allows
//     (forearm + wrist + hand ride along rigidly, keeping their own bend).
//   - Dragging the WRIST's position re-aims the ELBOW the same way (hand
//     rides along, keeping its own facing) — you can't move a wrist without
//     either bending the elbow or swinging the whole arm, same as a real one.
//   - Rotating the ELBOW bends/twists the forearm, carrying the wrist+hand.
//   - Rotating the WRIST only re-aims the hand.
// A pure rotation can't stretch a bone, so every one of the above "conforms
// to the limitation" (fixed bone length) automatically — see
// aimBoneToWorldPoint3D.
// ============================================================================
let jointEditorInited3D = false;
let selectedJoint3D = null;            // { side:'left'|'right', jointType:'elbow'|'wrist' } | null
let gizmoMode3D = 'translate';         // 'translate' | 'rotate'
let transformControls3D = null;
let gizmoProxy3D = null;               // world-space stand-in TransformControls actually drags in translate mode
// Fullscreen "3D Editor" mode: the model floods the screen with the joint
// toggle buttons + a small settings button, and everything else (pose
// panel, hand/wrist panel, other page chrome) is hidden until Apply/Cancel.
let jointEditorModeActive3D = false;
let jointEditorFacingSnapshot3D = null; // hand/wrist facing overrides when the editor opened, restored on Cancel
let jointEditorModeSnapshot3D = null;  // deep clone of manualJointEdits3D taken on open, restored on Cancel
let jointEditorPinDirty3D = { left: false, right: false }; // sides whose pin was changed by "copy pins" and not yet saved (saved on Apply / ⬆ Save)
let jointEditorPinCopySnapshot3D = null; // pre-copy handTargets of the current pose, taken lazily by "copy pins" so Cancel can restore them
let jointSettingsPopupOpen3D = false;  // whether the ⚙ settings popup is currently shown
let jointEditorCopyLog3D = [];         // what "Copy poses" has pulled onto the current pose this editor session (drives the status chip)
let jointEditorCameraView3D = 'free';  // 'front' | 'back' | 'side-left' | 'side-right' | 'free'
// Per-side manual overrides, KEYED BY POSE NAME:
// manualJointEdits3D[poseName] = { left: {...}, right: {...} }. null = "use
// whatever the pose/IK just computed"; otherwise a THREE.Quaternion snapshot
// of that group's LOCAL rotation, re-stamped after every applyPose3D() call
// (see the hook at its end) so a drag survives sliders and Generate until
// Reset is tapped. Keying by pose is what stops an edit made (and saved) on
// ONE pose — e.g. a mirrored wrist — from silently getting stamped onto
// EVERY other pose too: reapplyManualJointEdits3D() below only ever reads
// the bucket for whichever pose is currently active, never any other pose's.
let manualJointEdits3D = {};
const BLANK_JOINT_EDITS_3D = Object.freeze({ shoulderQuat: null, elbowQuat: null, wristQuat: null });
// Looks up the edit bucket for one pose. create=true (the default) lazily
// makes one if it doesn't exist yet — use for anything that's about to WRITE
// into it. Pass create=false for read-only lookups (e.g. reapply) so merely
// looking at a pose doesn't leave a permanent blank entry behind for it.
function jointEditsForPose3D(poseName, create = true) {
  if (!manualJointEdits3D[poseName]) {
    if (!create) return { left: BLANK_JOINT_EDITS_3D, right: BLANK_JOINT_EDITS_3D };
    manualJointEdits3D[poseName] = {
      left:  { shoulderQuat: null, elbowQuat: null, wristQuat: null },
      right: { shoulderQuat: null, elbowQuat: null, wristQuat: null },
    };
  }
  return manualJointEdits3D[poseName];
}

function isTouchLikely3D() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

function initJointEditor3D() {
  if (jointEditorInited3D || !renderer3D || !camera3D || !scene3D) return;
  if (typeof THREE.TransformControls !== 'function') return; // script not loaded — editor quietly unavailable
  jointEditorInited3D = true;

  transformControls3D = new THREE.TransformControls(camera3D, renderer3D.domElement);
  transformControls3D.setSize(isTouchLikely3D() ? 0.9 : 0.55);
  transformControls3D.enabled = false;
  transformControls3D.visible = false;
  scene3D.add(transformControls3D);

  gizmoProxy3D = new THREE.Object3D();
  scene3D.add(gizmoProxy3D);

  // Dragging a gizmo handle must suspend orbit/pan (they'd otherwise fight
  // over the same pointer), and a completed drag re-grounds + re-frames the
  // model (a moved elbow/wrist can shift the silhouette's lowest point).
  transformControls3D.addEventListener('dragging-changed', (e) => {
    if (controls3D) controls3D.enabled = !e.value;
    // Only re-ground (translate the model back to the floor) on release —
    // NEVER reframe/reposition the camera here. Reframing used to run on
    // every release and always snapped the camera back to a fixed front-on
    // position, undoing any orbiting the person had just done. The camera
    // now only moves when a Front/Back/Side/Free view button is explicitly
    // pressed (see setJointEditorCameraView3D).
    if (!e.value && selectedJoint3D) {
      groundBody3D(false);
      // Wrist rotate mode drags a proxy snapshotted to the elbow's
      // orientation at attach time (see attachGizmoToSelection3D); once a
      // drag has moved it away from that baseline, re-attach to reset the
      // proxy back to a fresh elbow-aligned snapshot (same resulting
      // Bend/Turn, just re-zeroed axes) so the NEXT drag's rings start
      // clean instead of inheriting wherever the last drag left them.
      if (gizmoMode3D === 'rotate' && selectedJoint3D.jointType === 'wrist') attachGizmoToSelection3D();
      updateJointPanelValues3D();
    }
  });
  transformControls3D.addEventListener('change', () => {
    if (selectedJoint3D && transformControls3D.dragging) onJointGizmoChange3D();
  });

  // Selection happens via the joint toggle buttons inside the fullscreen 3D
  // Editor (#jointToggleBar) instead of tapping the model — a tap on the
  // canvas can't be reliably told apart from the start of an orbit/pan
  // gesture on a touchscreen, which is exactly the ambiguity the crosshair
  // mesh-pin above already works around a different way (aim-then-confirm).
  // The gizmo itself still lives on the canvas and drags normally; only
  // picking WHICH joint moved off the canvas.
}

// The rotation that maps a bone's fixed REST local vector (its child
// group's .position — set once in buildArmSide and never itself changed) onto
// the direction toward a desired WORLD point. A pure rotation can't change a
// vector's length, so this automatically preserves the bone's exact length —
// the "restriction" a dragged elbow/wrist has to conform to — with no
// separate clamping step needed.
function aimBoneToWorldPoint3D(boneGroup, restLocalVec, targetWorldPos) {
  const parent = boneGroup.parent;
  parent.updateMatrixWorld(true);
  const targetLocal = parent.worldToLocal(targetWorldPos.clone());
  const dir = targetLocal.clone().sub(boneGroup.position);
  const rest = restLocalVec.clone();
  if (dir.lengthSq() < 1e-8 || rest.lengthSq() < 1e-8) return boneGroup.quaternion.clone();
  return new THREE.Quaternion().setFromUnitVectors(rest.normalize(), dir.normalize());
}

function selectJoint3D(side, jointType) {
  selectedJoint3D = { side, jointType };
  transformControls3D.enabled = true;
  transformControls3D.visible = true;
  attachGizmoToSelection3D();
  highlightSelectedJoint3D();
  refreshJointPickerButtons3D();
  // Selecting a joint no longer force-opens the settings popup — the ⚙
  // button does that. If the popup is already open, keep it in sync with
  // whichever joint is now selected instead of leaving it stale.
  if (jointSettingsPopupOpen3D) openJointPanel3D();
}
function deselectJoint3D() {
  if (!jointEditorInited3D) { selectedJoint3D = null; return; }
  selectedJoint3D = null;
  transformControls3D.detach();
  transformControls3D.enabled = false;
  transformControls3D.visible = false;
  highlightSelectedJoint3D();
  refreshJointPickerButtons3D();
  jointSettingsPopupOpen3D = false;
  closeJointPanel3D();
}
// The L/R Elbow/Wrist buttons are toggles, not one-shot pickers: tapping the
// already-selected joint's button deselects it; tapping a different one
// switches straight to it. Nothing about the picker itself ever disappears
// while in the 3D Editor — only the settings popup opens/closes separately.
function toggleJoint3D(side, jointType) {
  if (selectedJoint3D && selectedJoint3D.side === side && selectedJoint3D.jointType === jointType) {
    deselectJoint3D();
  } else {
    selectJoint3D(side, jointType);
  }
}
function refreshJointPickerButtons3D() {
  document.querySelectorAll('#jointToggleBar .jt-btn[data-joint]').forEach(b => {
    b.classList.toggle('active', !!selectedJoint3D && b.dataset.side === selectedJoint3D.side && b.dataset.joint === selectedJoint3D.jointType);
  });
}
// ---- ⚙ Settings popup: shows/edits the CURRENTLY selected joint, opened
// and closed explicitly rather than tied to selection itself. ----
function toggleJointSettingsPopup3D() {
  if (!selectedJoint3D) return; // nothing to show yet — pick a joint first
  jointSettingsPopupOpen3D = !jointSettingsPopupOpen3D;
  if (jointSettingsPopupOpen3D) openJointPanel3D(); else closeJointPanel3D();
}
function closeJointSettingsPopup3D() {
  jointSettingsPopupOpen3D = false;
  closeJointPanel3D();
}

// ---- Fullscreen 3D Editor mode ----
// Deep-clones the manual joint override quaternions so Cancel can restore
// them exactly, without the clones being live references that Apply-in-place
// edits would otherwise mutate.
function cloneManualJointEdits3D(src) {
  const c = (q) => q ? q.clone() : null;
  const out = {};
  Object.keys(src || {}).forEach(poseName => {
    const s = src[poseName];
    out[poseName] = {
      left:  { shoulderQuat: c(s.left.shoulderQuat),  elbowQuat: c(s.left.elbowQuat),  wristQuat: c(s.left.wristQuat) },
      right: { shoulderQuat: c(s.right.shoulderQuat), elbowQuat: c(s.right.elbowQuat), wristQuat: c(s.right.wristQuat) },
    };
  });
  return out;
}
function openJointEditorMode3D() {
  if (!sceneInited3D) return;
  if (!jointEditorInited3D) initJointEditor3D();
  jointEditorModeSnapshot3D = cloneManualJointEdits3D(manualJointEdits3D);
  jointEditorFacingSnapshot3D = { hand: Object.assign({}, handRotationOverride), wrist: Object.assign({}, wristRotationOverride), swing: Object.assign({}, wristSwingOverride) };
  jointEditorModeActive3D = true;
  const preview = document.getElementById('preview3D');
  if (preview) preview.classList.add('je-fullscreen');
  document.body.classList.add('je-fullscreen-active');
  const entry = document.getElementById('jointEditorEntryBar'); if (entry) entry.style.display = 'none';
  const topBar = document.getElementById('jointEditorTopBar'); if (topBar) topBar.style.display = '';
  const toggleBar = document.getElementById('jointToggleBar'); if (toggleBar) toggleBar.style.display = '';
  const bottomBar = document.getElementById('jointEditorBottomBar'); if (bottomBar) bottomBar.style.display = '';
  populateCopyPoseSelect3D();
  jointEditorCopyLog3D = [];
  updateCopyBadge3D();
  const copyBar = document.getElementById('jeCopyBar'); if (copyBar) copyBar.style.display = '';
  setJointEditorCameraView3D('free');
  // Let the layout/CSS settle into fullscreen before telling three.js the
  // canvas has a new size, or it measures the old (small) box.
  setTimeout(resizeBody3D, 0);
}
function closeJointEditorModeUI3D() {
  jointEditorModeActive3D = false;
  jointEditorModeSnapshot3D = null;
  jointEditorPinCopySnapshot3D = null;
  jointSettingsPopupOpen3D = false;
  const preview = document.getElementById('preview3D');
  if (preview) preview.classList.remove('je-fullscreen');
  document.body.classList.remove('je-fullscreen-active');
  const entry = document.getElementById('jointEditorEntryBar'); if (entry) entry.style.display = '';
  const topBar = document.getElementById('jointEditorTopBar'); if (topBar) topBar.style.display = 'none';
  const toggleBar = document.getElementById('jointToggleBar'); if (toggleBar) toggleBar.style.display = 'none';
  const bottomBar = document.getElementById('jointEditorBottomBar'); if (bottomBar) bottomBar.style.display = 'none';
  const copyBar = document.getElementById('jeCopyBar'); if (copyBar) copyBar.style.display = 'none';
  exitEditorPinMode3D(false);
  closeCopyPopup3D();
  jointEditorCopyLog3D = [];
  updateCopyBadge3D();
  deselectJoint3D();
  setTimeout(resizeBody3D, 0);
}
// "Close" — just leaves the fullscreen editor UI and goes back to the main
// page. Purely visual: it doesn't apply, save, or undo anything. Whatever's
// currently in manualJointEdits3D (edited-but-unsaved or already-saved,
// doesn't matter) stays exactly as it is. Pins changed by Copy/Pin Mode stay
// flagged (jointEditorPinDirty3D) until ⬆ Save actually pushes them to GitHub
// — closing the editor doesn't save them and doesn't discard them either.
function closeJointEditorMode3D() {
  closeJointEditorModeUI3D();
}
// Reverts every joint back to the snapshot taken when the editor opened,
// discarding anything changed (or mirrored) since — then closes the UI.
function cancelJointEditorMode3D() {
  jointEditorPinDirty3D = { left: false, right: false }; // cancelled copies are never saved
  if (jointEditorPinCopySnapshot3D) {
    const snap = jointEditorPinCopySnapshot3D, pose = POSES3D[snap.key];
    if (pose) ['left', 'right'].forEach(side => {
      if (snap[side] === undefined) { if (pose[side]) delete pose[side].handTarget; }
      else { pose[side] = pose[side] || {}; pose[side].handTarget = JSON.parse(JSON.stringify(snap[side])); }
    });
    applyPose3D(snap.key, { reframe: false });
    refreshHandWristButtons();
  }
  if (jointEditorFacingSnapshot3D) {
    handRotationOverride = jointEditorFacingSnapshot3D.hand;
    wristRotationOverride = jointEditorFacingSnapshot3D.wrist;
    wristSwingOverride = jointEditorFacingSnapshot3D.swing || { left: null, right: null };
    refreshHandWristButtons();
    applyPose3D(currentPose3D, { reframe: false });
  }
  if (jointEditorModeSnapshot3D) {
    manualJointEdits3D = jointEditorModeSnapshot3D;
    reapplyManualJointEdits3D();
    groundBody3D(false);
  }
  closeJointEditorModeUI3D();
}
// ---- Copy elbow + wrist from another pose ----
// Lets you pick any other pose from a dropdown and pull ONLY its elbow and
// wrist joints (bend/twist and wrist hinge/turn) onto the current pose —
// legs, spine and shoulders are never touched. It works by briefly rendering
// the source pose with no manual edits/overrides, reading the elbow and wrist
// groups' resulting local rotations (so IK-driven poses copy correctly too),
// then restoring the current pose and stamping those rotations in as manual
// joint edits. Hand pins are only copied if "Copy hand pins" is ticked. Shoulders are only copied if "Match elbow position" is ticked. That makes it behave like any other editor drag: Cancel
// reverts it, Apply keeps it, and ⬆ Save persists it.
function populateCopyPoseSelect3D() {
  const sel = document.getElementById('jeCopyPoseSelect');
  if (!sel || typeof POSES3D === 'undefined') return;
  const prev = sel.value;
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = 'Choose a pose…';
  sel.appendChild(ph);
  const groups = {};
  Object.keys(POSES3D).forEach(key => {
    if (key === currentPose3D) return; // copying a pose onto itself is a no-op
    const pose = POSES3D[key];
    const sec = pose.section || 'Other';
    if (!groups[sec]) {
      groups[sec] = document.createElement('optgroup');
      groups[sec].label = sec;
      sel.appendChild(groups[sec]);
    }
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = pose.label || key;
    groups[sec].appendChild(opt);
  });
  if (prev && POSES3D[prev] && prev !== currentPose3D) sel.value = prev;
  else sel.value = '';
}
function readPoseElbowWristQuats3D(poseKey) {
  // Render the source pose "clean" — no manual edits, no hand/wrist-facing or
  // elbow overrides — read the joint rotations, then put everything back.
  const savedPose = currentPose3D;
  const savedManual = cloneManualJointEdits3D(manualJointEdits3D);
  const savedOv = [handRotationOverride, wristRotationOverride, elbowBendOverride, elbowLiftOverride, wristSwingOverride];
  const out = { left: {}, right: {} };
  try {
    manualJointEdits3D = {};
    handRotationOverride = { left: null, right: null };
    wristRotationOverride = { left: null, right: null };
    wristSwingOverride = { left: null, right: null };
    elbowBendOverride = { left: null, right: null };
    elbowLiftOverride = { left: null, right: null };
    wristSwingOverride = { left: null, right: null };
    applyPose3D(poseKey, { reframe: false });
    ['left', 'right'].forEach(side => {
      const sh = rig3D[side + 'Shoulder'], e = rig3D[side + 'Elbow'], w = rig3D[side + 'Wrist'];
      out[side].shoulderQuat = sh ? sh.quaternion.clone() : null;
      out[side].elbowQuat = e ? e.quaternion.clone() : null;
      out[side].wristQuat = w ? w.quaternion.clone() : null;
    });
  } finally {
    manualJointEdits3D = savedManual;
    [handRotationOverride, wristRotationOverride, elbowBendOverride, elbowLiftOverride, wristSwingOverride] = savedOv;
    applyPose3D(savedPose, { reframe: false });
  }
  return out;
}
function copyElbowWristFromPose3D() {
  const sel = document.getElementById('jeCopyPoseSelect');
  const sideSel = document.getElementById('jeCopySideSelect');
  const msg = document.getElementById('jeCopyMsg');
  if (!sel) return;
  if (!sel.value || !POSES3D[sel.value]) { if (msg) msg.textContent = 'Choose a pose to copy from first.'; return; }
  if (msg) msg.textContent = '';
  const sides = (sideSel && sideSel.value === 'left') ? ['left']
              : (sideSel && sideSel.value === 'right') ? ['right'] : ['left', 'right'];
  const src = readPoseElbowWristQuats3D(sel.value);
  const matchElbowPos = !!(document.getElementById('jeCopyShoulderChk') || {}).checked;
  const copyPins = !!(document.getElementById('jeCopyPinsChk') || {}).checked;
  // Pins: copy the source pose's hand target (mesh+face pin) for each chosen
  // side. A pin is stored as mesh/face names + an offset (not world
  // coordinates), so it re-resolves against THIS pose's own mesh positions —
  // the hand lands on the same spot of the body, at wherever that spot
  // currently is. A pinned arm's shoulder/elbow are position-driven (see
  // applyArmPosition3D), so any manual shoulder/elbow rotation on that side
  // is cleared and not copied (it would just be overwritten every render).
  const pinned = { left: false, right: false };
  if (copyPins) {
    const cur = POSES3D[currentPose3D];
    const ex = expandPose3D(POSES3D[sel.value]);
    sides.forEach(side => {
      const ht = side === 'left' ? ex.handTargetL : ex.handTargetR;
      if (!ht) return; // source arm isn't pinned — leave this side's pin as is
      if (!jointEditorPinCopySnapshot3D) {
        const snap = { key: currentPose3D };
        ['left', 'right'].forEach(sd => {
          const t = cur[sd] && cur[sd].handTarget;
          snap[sd] = t === undefined ? undefined : JSON.parse(JSON.stringify(t));
        });
        jointEditorPinCopySnapshot3D = snap;
      }
      cur[side] = cur[side] || {};
      cur[side].handTarget = (typeof ht === 'string') ? ht : Object.assign({}, ht);
      handRotationOverride[side] = null; wristRotationOverride[side] = null; wristSwingOverride[side] = null;
      elbowBendOverride[side] = null; elbowLiftOverride[side] = null;
      const je = jointEditsForPose3D(currentPose3D);
      je[side].shoulderQuat = null;
      je[side].elbowQuat = null;
      je[side].wristQuat = null;
      pinned[side] = true;
      jointEditorPinDirty3D[side] = true;
    });
  }
  sides.forEach(side => {
    if (pinned[side]) return;
    // Optional: also copy the shoulder's aim so the elbow lands in the same
    // place as in the source pose (elbow position comes from the shoulder).
    const je = jointEditsForPose3D(currentPose3D);
    if (matchElbowPos && src[side].shoulderQuat) je[side].shoulderQuat = src[side].shoulderQuat;
    if (src[side].elbowQuat) je[side].elbowQuat = src[side].elbowQuat;
    if (src[side].wristQuat) je[side].wristQuat = src[side].wristQuat;
  });
  if (pinned.left || pinned.right) { refreshHandWristButtons(); applyPose3D(currentPose3D, { reframe: false }); }
  reapplyManualJointEdits3D();
  groundBody3D(false);
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  // Feedback: log it (drives the chip under the top bars), close the pop-up
  // so the result is visible, and flash a short confirmation.
  const srcLabel = POSES3D[sel.value].label || sel.value;
  const sideWord = sides.length === 2 ? 'both arms' : (sides[0] === 'left' ? 'left arm' : 'right arm');
  const parts = ['elbow', 'wrist'];
  if (matchElbowPos) parts.push('shoulder');
  if (pinned.left || pinned.right) parts.push('hand pins');
  jointEditorCopyLog3D.push({ label: srcLabel, side: sideWord, parts: parts.join(', ') });
  updateCopyBadge3D();
  closeCopyPopup3D();
  const status = document.getElementById('jeMirrorStatus');
  if (status) {
    status.textContent = `Copied ${parts.join(' + ')} from "${srcLabel}" (${sideWord})`;
    status.style.opacity = '1';
    clearTimeout(mirrorSelectedJoint3D._t);
    clearTimeout(copyElbowWristFromPose3D._t);
    copyElbowWristFromPose3D._t = setTimeout(() => { status.style.opacity = '0'; }, 2400);
  }
}

// ---- Reset: back to your last SAVED file ----
// Re-reads presets/pose-overrides.json (falling back to the copy loaded when
// the page opened if GitHub can't be reached), puts every hand pin back to
// what's saved there (or the built-in one if none is saved), and restores the
// saved joint edits — dropping everything unsaved: drags, typed values,
// mirrors, copies and pins. Cancel/Apply still work afterwards.
async function resetAllJointEdits3D() {
  if (!confirm('Reset to your last saved file? Unsaved joint edits and pins will be lost.')) return;
  let all = null, source = 'saved file';
  try {
    const s = (typeof ghGetSettings === 'function') ? ghGetSettings() : null;
    if (s && s.owner && s.repo) {
      all = (await fetchPoseOverridesFile(s)).all;
      poseOverridesCache3D = all;
    }
  } catch (e) { console.warn('Reset: could not reach GitHub, using the copy loaded at start-up.', e); }
  if (!all && poseOverridesCache3D) { all = poseOverridesCache3D; source = 'copy loaded at start-up'; }
  if (!all) { all = {}; source = 'built-in defaults (no saved file found)'; }

  // Pins: built-in first, then whatever the saved file says.
  capturePoseLiteralPins3D();
  Object.keys(POSES3D).forEach(k => {
    ['left', 'right'].forEach(side => {
      const lit = poseLiteralPins3D && poseLiteralPins3D[k] && poseLiteralPins3D[k][side];
      if (lit !== undefined) { POSES3D[k][side] = POSES3D[k][side] || {}; POSES3D[k][side].handTarget = JSON.parse(JSON.stringify(lit)); }
      else if (POSES3D[k][side]) delete POSES3D[k][side].handTarget;
    });
  });
  applyPoseOverridesData3D(all);

  // Joint edits.
  jointEditorPinCopySnapshot3D = null;
  jointEditorPinDirty3D = { left: false, right: false };
  handRotationOverride = { left: null, right: null };
  wristRotationOverride = { left: null, right: null };
  wristSwingOverride = { left: null, right: null };
  elbowBendOverride = { left: null, right: null };
  elbowLiftOverride = { left: null, right: null };
  manualJointEdits3D = {};
  jointEditsSaved3D = all._jointEdits || null;
  jointEditsInitialApplied3D = true;
  if (jointEditsSaved3D) applyJointEditsState3D(jointEditsSaved3D, { keepPose: true });
  else applyPose3D(currentPose3D, { reframe: false });
  reapplyManualJointEdits3D();
  groundBody3D(false);
  refreshHandWristButtons();
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  jointEditorCopyLog3D = [];
  updateCopyBadge3D();
  const status = document.getElementById('jeMirrorStatus');
  if (status) {
    status.textContent = `Reset to ${source}`;
    status.style.opacity = '1';
    clearTimeout(copyElbowWristFromPose3D._t);
    copyElbowWristFromPose3D._t = setTimeout(() => { status.style.opacity = '0'; }, 2600);
  }
}

// Undo button for manual arm/wrist overrides: clears both sides' shoulder/
// elbow/wrist quaternions for the CURRENT pose only and re-saves that
// cleared state. manualJointEdits3D is keyed by pose (see
// jointEditsForPose3D above), so this can no longer affect any other pose —
// it used to have to be a global "clear everything" hammer back when a bad
// override could bleed onto every pose at once; that bleed is fixed now, so
// this is just a normal per-pose undo. It does not touch your pins.
async function clearAllManualJointOverridesAndSave3D() {
  if (!confirm('Clear manual arm/wrist overrides (shoulder, elbow, wrist) on both sides for the CURRENT pose and save that cleared state? This does not touch your pins or other poses.')) return;
  manualJointEdits3D[currentPose3D] = {
    left:  { shoulderQuat: null, elbowQuat: null, wristQuat: null },
    right: { shoulderQuat: null, elbowQuat: null, wristQuat: null },
  };
  applyPose3D(currentPose3D, { reframe: false });
  reapplyManualJointEdits3D();
  groundBody3D(false);
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  await quickSaveJointsToGitHub3D();
}

// ---- Copy Poses pop-up + "copied from" chip ----
function openCopyPopup3D() {
  const popup = document.getElementById('jeCopyPopup');
  if (!popup) return;
  populateCopyPoseSelect3D();
  const msg = document.getElementById('jeCopyMsg'); if (msg) msg.textContent = '';
  const target = document.getElementById('jeCopyTarget');
  if (target && typeof POSES3D !== 'undefined' && POSES3D[currentPose3D]) {
    target.textContent = `Copying onto: ${POSES3D[currentPose3D].label || currentPose3D}`;
  }
  popup.classList.add('open');
}
function closeCopyPopup3D() {
  const popup = document.getElementById('jeCopyPopup');
  if (popup) popup.classList.remove('open');
}
// Shows what's been copied onto the current pose (persists until Apply/Cancel,
// unlike the brief toast), and marks the Copy poses button as "used".
function updateCopyBadge3D() {
  const badge = document.getElementById('jeCopyBadge');
  const btn = document.getElementById('jeCopyOpenBtn');
  const log = jointEditorCopyLog3D;
  if (btn) btn.classList.toggle('has-copy', log.length > 0);
  if (!badge) return;
  if (!log.length) { badge.style.display = 'none'; badge.textContent = ''; badge.title = ''; return; }
  const last = log[log.length - 1];
  badge.textContent = `✓ Copied from ${last.label}` + (log.length > 1 ? ` (+${log.length - 1} more)` : '');
  badge.title = log.map(e => `${e.label} — ${e.side}: ${e.parts}`).join('\n');
  badge.style.display = 'block';
}

// Front/Back/Left-side/Right-side snap the camera to a clean view of the
// current silhouette; Free leaves the camera exactly where the person left
// it (no repositioning at all) so orbiting freely is always available too.
function setJointEditorCameraView3D(view) {
  jointEditorCameraView3D = view;
  if (view !== 'free' && bodyGroup3D && camera3D && controls3D) {
    const box = new THREE.Box3().setFromObject(bodyGroup3D);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.y, size.z) * 1.6 + 60;
    controls3D.target.copy(center);
    if (view === 'front')          camera3D.position.set(center.x, center.y, center.z + dist);
    else if (view === 'back')      camera3D.position.set(center.x, center.y, center.z - dist);
    else if (view === 'side-left') camera3D.position.set(center.x - dist, center.y, center.z);
    else if (view === 'side-right')camera3D.position.set(center.x + dist, center.y, center.z);
    controls3D.update();
  }
  document.querySelectorAll('#jointEditorTopBar .je-cam-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

// ---- Mirror: copies the selected joint's current position+rotation state
// onto the opposite side, reflected across the body's own centerline. ----
// Left/right arm groups are built as plain translated copies of each other
// (see buildArmSide) with NO extra baseline rotation flipping their local
// axes — the only per-side asymmetry is the small mirrored "Rotate Arms Out
// 15°" base offset and sign conventions used elsewhere (sideSign, wristTurn
// range) for AUTHORED pose angles. Because both sides share the same local
// axis directions, a joint's raw local quaternion can be reflected with the
// standard "mirror across the X axis" quaternion formula — negate the y and
// z components, keep x and w — and it lands correctly on the other side,
// including reproducing that mirrored 15° base offset automatically.
function mirrorQuat3D(q) {
  return new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
}
// Reflects a hand pin across the body's midline: mesh swaps to its opposite
// (legs/feet), face swaps left/right (front/back/top/bottom stay put), and
// the stored offset's x flips — the new {mesh,face,offset} shape has no
// per-pose facing/joint baggage left to carry over (see the block comment
// above resolveHandAbsolutePos3D — hand facing is fully decoupled from
// position now), so this is now just a straight geometric mirror.
function mirrorPinSpec3D(ht) {
  if (!ht || !ht.mesh) return ht;
  const c = JSON.parse(JSON.stringify(ht));
  const swapMesh = { leftLeg: 'rightLeg', rightLeg: 'leftLeg', leftFoot: 'rightFoot', rightFoot: 'leftFoot' };
  const swapFace = { left: 'right', right: 'left' };
  if (swapMesh[c.mesh]) c.mesh = swapMesh[c.mesh];
  if (swapFace[c.face]) c.face = swapFace[c.face];
  if (c.offset && typeof c.offset.x === 'number') c.offset.x = round2(-c.offset.x);
  return c;
}
// Mobile-friendly debug readout (no devtools needed): shows the raw stored
// handTarget for both wrists plus what it currently RESOLVES to (the actual
// spine-local point the new position system will use, given the CURRENT
// body geometry) — via resolveHandAbsolutePos3D, the same function
// applyArmPosition3D itself calls. If the two `resolved` points aren't an
// exact mirror (same y/z, opposite x) at the current geometry, the bug is in
// the resolve/geometry path; if they ARE a mirror but the rendered hands
// still look wrong, the bug is downstream in the aim solve itself.
function debugShowPins3D() {
  const pose = POSES3D[currentPose3D];
  const lines = [];
  ['left', 'right'].forEach(side => {
    const raw = pose && pose[side] && pose[side].handTarget;
    lines.push(`${side.toUpperCase()} raw: ${raw ? JSON.stringify(raw) : '(none)'}`);
    const resolved = resolveHandAbsolutePos3D(side, pose);
    lines.push(`${side.toUpperCase()} resolved wrist target: ${resolved ? JSON.stringify(resolved) : '(no Default Setter captured, and not pinned — legacy fixed-angle path)'}`);
    const def = pinDefaults3D[side];
    lines.push(`${side.toUpperCase()} defaults: ${def ? JSON.stringify(def) : '(not captured — see Default Setter)'}`);
    const shoulder = ikContext3D.shoulders && ikContext3D.shoulders[side];
    const lens = ikContext3D.armLens && ikContext3D.armLens[side];
    lines.push(`${side.toUpperCase()} shoulder/lens: ${JSON.stringify({ shoulder, lens })}`);
  });
  alert(lines.join('\n\n'));
}
function mirrorSelectedJoint3D() {
  if (!selectedJoint3D) return;
  const { side, jointType } = selectedJoint3D;
  const other = side === 'left' ? 'right' : 'left';
  const pose = POSES3D[currentPose3D];
  const srcPin = pose && pose[side] && pose[side].handTarget;
  const shoulderGrp = rig3D[side + 'Shoulder'];
  const elbowGrp = rig3D[side + 'Elbow'];
  const wr = lastPoseResolved3D && lastPoseResolved3D[side];
  if (srcPin) {
    // Pinned source: mirror the PIN itself — the opposite hand then tracks
    // its own mirrored face independently (see resolveHandAbsolutePos3D),
    // same as any other pin.
    snapshotPinsForCancel3D();
    pose[other] = pose[other] || {};
    pose[other].handTarget = mirrorPinSpec3D(srcPin);
    jointEditorPinDirty3D[other] = true;
    // A pin's whole point is that it re-resolves fresh off the CURRENT body
    // geometry every render (see resolveHandAbsolutePos3D) so it keeps
    // tracking its face through any later resize. A frozen quaternion
    // snapshot does the opposite — clear any earlier manual joint edit on
    // the mirrored side so it goes back to a live, tracking pin.
    const jePinned = jointEditsForPose3D(currentPose3D);
    jePinned[other].shoulderQuat = null;
    jePinned[other].elbowQuat    = null;
    jePinned[other].wristQuat    = null;
  } else {
    // Unpinned source: mirror the whole arm (shoulder + elbow aim, so the hand
    // lands in the reflected spot) and the hand: wrist Bend and Turn are
    // copied unchanged (the two hands turn in opposite directions for the same
    // number, so an equal Turn is a mirrored pair), as the dropdowns' own numbers.
    // A pinned opposite hand would ignore all of that, so free it first (saved
    // with ⬆ Save, undone by Cancel).
    if (pose && pose[other] && pose[other].handTarget !== undefined) {
      snapshotPinsForCancel3D();
      delete pose[other].handTarget;
      jointEditorPinDirty3D[other] = true;
    }
    const jeUnpinned = jointEditsForPose3D(currentPose3D);
    if (shoulderGrp) jeUnpinned[other].shoulderQuat = mirrorQuat3D(shoulderGrp.quaternion);
    if (elbowGrp)    jeUnpinned[other].elbowQuat    = mirrorQuat3D(elbowGrp.quaternion);
    if (wr) {
      wristRotationOverride[other] = clampWristBend(wr.wrist);
      wristSwingOverride[other] = clampWristSwing(wr.swing || 0); // same number = mirrored hand
      handRotationOverride[other] = clampTurnFree(wr.wristTurn); // same number = mirrored hand
      // Exact reflection of the source hand's actual rotation (not just its
      // Bend/Turn numbers), so anything beyond those two numbers mirrors too.
      const wristGrpSrc = rig3D[side + 'Wrist'];
      jeUnpinned[other].wristQuat = wristGrpSrc ? mirrorQuat3D(wristGrpSrc.quaternion) : null;
    }
  }
  applyPose3D(currentPose3D, { reframe: false });
  reapplyManualJointEdits3D();
  groundBody3D(false);
  if (selectedJoint3D && (selectedJoint3D.side === other)) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  const status = document.getElementById('jeMirrorStatus');
  if (status) {
    status.textContent = `Mirrored ${srcPin ? 'pin' : 'arm + hand'} to ${other === 'left' ? 'Left' : 'Right'} (exact copy, build 3)`;
    status.style.opacity = '1';
    clearTimeout(mirrorSelectedJoint3D._t);
    mirrorSelectedJoint3D._t = setTimeout(() => { status.style.opacity = '0'; }, 1600);
  }
}
// ---- Wrist Bend / Turn sliders (replace the rotate rings for wrists) ------
// A small floating card that follows the selected wrist on screen while
// Rotate is on. Limits: Bend -80..80, Turn -180..180, Swing -40..20.
// They write the same per-side overrides the number fields use, so Save,
// Mirror and the dropdowns all stay in sync.
let wristSliderEl3D = null;
let wristSliderDragging3D = false;
function ensureWristSliders3D() {
  if (wristSliderEl3D) return wristSliderEl3D;
  const host = document.getElementById('preview3D');
  if (!host) return null;
  if (!document.getElementById('wristSliderCss3D')) {
    const st = document.createElement('style');
    st.id = 'wristSliderCss3D';
    st.textContent = `
      #wristSliders3D { position:absolute; z-index:30; width:168px; padding:8px 10px 6px;
        background:rgba(20,20,24,0.88); border:1px solid #f0c040; border-radius:10px;
        font-family:'Space Mono',monospace; font-size:10px; color:#eee; display:none;
        touch-action:none; user-select:none; -webkit-user-select:none; }
      #wristSliders3D .ws-row { display:flex; align-items:center; gap:6px; margin:4px 0; }
      #wristSliders3D .ws-lab { width:20px; color:#f0c040; font-weight:700; }
      #wristSliders3D .ws-val { width:34px; text-align:right; }
      #wristSliders3D input[type=range] { flex:1; min-width:0; height:28px; margin:0; accent-color:#f0c040; touch-action:none; }
      #wristSliders3D .ws-note { color:#aaa; font-size:9px; margin-top:2px; display:none; }
    `;
    document.head.appendChild(st);
  }
  const el = document.createElement('div');
  el.id = 'wristSliders3D';
  el.innerHTML = `
    <div class="ws-row"><span class="ws-lab">Be</span><input type="range" id="wsBend3D" min="${WRIST_BEND_RANGE[0]}" max="${WRIST_BEND_RANGE[1]}" step="1" value="0"><span class="ws-val" id="wsBendVal3D">0</span></div>
    <div class="ws-row"><span class="ws-lab">Tu</span><input type="range" id="wsTurn3D" min="-180" max="180" step="1" value="0"><span class="ws-val" id="wsTurnVal3D">0</span></div>
    <div class="ws-row"><span class="ws-lab">Sw</span><input type="range" id="wsSwing3D" min="${WRIST_SWING_RANGE[0]}" max="${WRIST_SWING_RANGE[1]}" step="1" value="0"><span class="ws-val" id="wsSwingVal3D">0</span></div>
    <div class="ws-note" id="wsNote3D">Hand is pinned — unpin to use sliders.</div>`;
  // Keep touches/clicks on the card away from orbit/pan on the canvas.
  ['pointerdown','pointermove','pointerup','touchstart','touchmove','mousedown','wheel'].forEach(ev =>
    el.addEventListener(ev, e => e.stopPropagation(), { passive: true }));
  host.appendChild(el);
  const bind = (id, axis) => {
    const inp = el.querySelector('#' + id);
    inp.addEventListener('input', () => onWristSlider3D(axis, parseFloat(inp.value)));
    inp.addEventListener('pointerdown', () => { wristSliderDragging3D = true; });
    const end = () => { wristSliderDragging3D = false; syncWristSliders3D(); };
    inp.addEventListener('pointerup', end); inp.addEventListener('pointercancel', end); inp.addEventListener('change', end);
  };
  bind('wsBend3D', 'x'); bind('wsTurn3D', 'y'); bind('wsSwing3D', 'z');
  wristSliderEl3D = el;
  return el;
}
function syncWristSliders3D() {
  if (!selectedJoint3D || selectedJoint3D.jointType !== 'wrist') return;
  const el = ensureWristSliders3D(); if (!el) return;
  const res = lastPoseResolved3D && lastPoseResolved3D[selectedJoint3D.side];
  if (!res) return;
  const bend = el.querySelector('#wsBend3D'), turn = el.querySelector('#wsTurn3D'), swing = el.querySelector('#wsSwing3D');
  if (!wristSliderDragging3D) {
    bend.value = clampWristBend(res.wrist);
    turn.value = clampTurnFree(res.wristTurn);
    swing.value = clampWristSwing(res.swing || 0);
  }
  el.querySelector('#wsSwingVal3D').textContent = Math.round(parseFloat(swing.value));
  el.querySelector('#wsBendVal3D').textContent = Math.round(parseFloat(bend.value));
  el.querySelector('#wsTurnVal3D').textContent = Math.round(parseFloat(turn.value));
  // Bend/Turn/Swing are always the pose's own authored hand-facing numbers,
  // pinned or not — a hand pin (or the Default Setter) only ever drives the
  // shoulder/elbow's POSITION (see applyArmPosition3D), never the hand's own
  // facing, so there's nothing pin-specific left to explain here.
  bend.disabled = false; turn.disabled = false; swing.disabled = false;
  el.querySelector('#wsNote3D').style.display = 'none';
}
function onWristSlider3D(axis, n) {
  if (!selectedJoint3D || selectedJoint3D.jointType !== 'wrist' || isNaN(n)) return;
  const { side } = selectedJoint3D;
  if (axis === 'x') wristRotationOverride[side] = clampWristBend(n);
  else if (axis === 'z') wristSwingOverride[side] = clampWristSwing(n);
  else handRotationOverride[side] = clampTurnFree(n);
  jointEditsForPose3D(currentPose3D)[side].wristQuat = null;
  applyPose3D(currentPose3D, { reframe: false });
  updateJointPanelValues3D();
  syncWristSliders3D();
}
// Runs every frame: shows the card only for a selected wrist in Rotate mode
// inside the editor, and pins it beside the wrist's on-screen position.
function updateWristSliderOverlay3D() {
  const el = wristSliderEl3D;
  const show = !!(selectedJoint3D && selectedJoint3D.jointType === 'wrist' && gizmoMode3D === 'rotate' && jointEditorModeActive3D);
  if (!show) { if (el && el.style.display !== 'none') el.style.display = 'none'; return; }
  const card = ensureWristSliders3D(); if (!card) return;
  const grp = rig3D[selectedJoint3D.side + 'Wrist']; if (!grp) return;
  const host = document.getElementById('preview3D');
  const W = host.clientWidth, H = host.clientHeight;
  const v = new THREE.Vector3(); grp.getWorldPosition(v); v.project(camera3D);
  const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
  if (card.style.display !== 'block') { card.style.display = 'block'; syncWristSliders3D(); }
  const cw = card.offsetWidth || 168, ch = card.offsetHeight || 80;
  // Sit on the outer side of the wrist (away from screen centre) so the card
  // doesn't cover the body; then clamp inside the viewport.
  let x = sx < W / 2 ? sx - cw - 24 : sx + 24;
  if (x < 4 || x + cw > W - 4) x = sx < W / 2 ? sx + 24 : sx - cw - 24;
  x = Math.max(4, Math.min(W - cw - 4, x));
  // Stay below the editor's top button rows.
  let minY = 4; const hostTop = host.getBoundingClientRect().top;
  ['jointEditorTopBar', 'jointToggleBar', 'jeCopyBar'].forEach(id => {
    const b = document.getElementById(id);
    if (b && b.offsetParent !== null) minY = Math.max(minY, b.getBoundingClientRect().bottom - hostTop + 6);
  });
  const y = Math.max(minY, Math.min(H - ch - 4, sy - ch / 2));
  card.style.left = Math.round(x) + 'px';
  card.style.top = Math.round(y) + 'px';
}
function setGizmoMode3D(mode) {
  gizmoMode3D = mode;
  if (selectedJoint3D) attachGizmoToSelection3D();
  const panel = document.getElementById('jointEditorPanel');
  if (panel) panel.querySelectorAll('.je-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const note = document.getElementById('jeNote');
  if (note) note.textContent = mode === 'rotate'
    ? (selectedJoint3D && selectedJoint3D.jointType === 'wrist'
        ? 'Use the Bend / Turn sliders next to the wrist on the model, or type exact numbers below.'
        : 'Drag the rotate rings on the model above, or type exact numbers below — dragging a handle automatically pauses orbit/zoom until you release it.')
    : 'Drag the move handles on the model above, or type exact numbers below — dragging a handle automatically pauses orbit/zoom until you release it.';
}
function attachGizmoToSelection3D() {
  if (!selectedJoint3D) return;
  const { side, jointType } = selectedJoint3D;
  const grp = rig3D[side + (jointType === 'elbow' ? 'Elbow' : 'Wrist')];
  if (!grp) return;
  // Wrist + Rotate: no ring gizmo at all — two Bend/Turn sliders float next
  // to the joint instead (see updateWristSliderOverlay3D). Elbow keeps rings.
  if (gizmoMode3D === 'rotate' && jointType === 'wrist') {
    transformControls3D.detach();
    transformControls3D.enabled = false;
    transformControls3D.visible = false;
    syncWristSliders3D();
    return;
  }
  transformControls3D.enabled = true;
  transformControls3D.visible = true;
  if (gizmoMode3D === 'rotate') {
    transformControls3D.setMode('rotate');
    // Rotate rings read much bigger than the translate arrows at the same
    // size value, so shrink them a bit further.
    transformControls3D.setSize(isTouchLikely3D() ? 0.6 : 0.35);
    transformControls3D.setSpace('local');
    if (jointType === 'wrist') {
      // Wrist Bend/Turn share one Euler (x=Bend, y=Turn), so attaching
      // straight to the wrist group would show its rings in the group's OWN
      // current local axes — once Turn swings past ~90° those axes have
      // rotated along with it, so the ring that used to bend the hand
      // up/down now visibly slides toward doing a side-to-side motion
      // instead (and vice versa). Attach to a proxy oriented to the
      // ELBOW's world rotation instead (Turn's own contribution left out),
      // so the ring that bends the hand stays the same ring no matter what
      // Turn is currently set to — see onJointGizmoChange3D for how the
      // proxy's drag gets converted back into Bend/Turn on the real wrist.
      const elbowGrp = rig3D[side + 'Elbow'];
      const world = new THREE.Vector3(); grp.getWorldPosition(world);
      gizmoProxy3D.position.copy(world);
      if (elbowGrp) elbowGrp.getWorldQuaternion(gizmoProxy3D.quaternion); else gizmoProxy3D.quaternion.identity();
      transformControls3D.attach(gizmoProxy3D);
    } else {
      // Elbow has no such issue (its own bend is the only rotation on the
      // group, nothing to twist the ring around) — TransformControls can
      // just control it directly, exactly matching what applyPose3D does
      // with this same rotation.
      transformControls3D.attach(grp);
    }
  } else {
    // Translate mode drags a free-floating proxy in world space; its motion
    // gets converted into a bone-length-preserving rotation on the PARENT
    // joint in onJointGizmoChange3D (see aimBoneToWorldPoint3D) rather than
    // moving the joint's own position directly, which would visibly detach
    // it from the fixed-length arm mesh above it.
    transformControls3D.setMode('translate');
    transformControls3D.setSize(isTouchLikely3D() ? 0.9 : 0.55);
    transformControls3D.setSpace('world');
    const world = new THREE.Vector3();
    grp.getWorldPosition(world);
    gizmoProxy3D.position.copy(world);
    gizmoProxy3D.quaternion.identity();
    transformControls3D.attach(gizmoProxy3D);
  }
}
function highlightSelectedJoint3D() {
  ['left', 'right'].forEach(side => {
    ['Elbow', 'Wrist'].forEach(j => {
      const mesh = rig3D[side + j + 'JointMesh'];
      if (!mesh || !mesh.material) return;
      const isSel = !!selectedJoint3D && selectedJoint3D.side === side && selectedJoint3D.jointType === j.toLowerCase();
      if (mesh.material.emissive) mesh.material.emissive.setHex(isSel ? 0xf0c040 : 0x000000);
      mesh.material.color.setHex(isSel ? 0xf0c040 : 0xf2f2f2);
    });
  });
  updatePinGlow3D();
}
// ---- Glow the body part a selected wrist is pinned to --------------------
// Makes "what is this hand actually pinned to?" visible at a glance: select
// a wrist, and if it has a Pinned Mesh, that mesh glows green until you
// select something else or clear the pin. Purely visual — doesn't touch the
// pin data itself.
const PIN_GLOW_COLOR_3D = 0x50dc78;
let pinGlowMeshes3D = [];
function clearPinGlow3D() {
  pinGlowMeshes3D.forEach(m => { if (m && m.material && m.material.emissive) m.material.emissive.setHex(0x000000); });
  pinGlowMeshes3D = [];
}
// Matches a meshRecords3D entry (see buildBody3D) against a Pinned Mesh key.
// leftLeg/rightLeg/leftFoot/rightFoot are split by x sign the same way the
// original box data was (negative x = left) — see the note above legBoxes.
function meshRecordMatchesPinKey3D(rec, meshKey) {
  switch (meshKey) {
    case 'head':      return rec.group === 'head';
    case 'neck':       return rec.group === 'neck';
    case 'torso':      return rec.group === 'torso';
    case 'waist':      return rec.group === 'waistbox';
    case 'leftLeg':    return rec.group === 'legs'  && rec.mesh.position.x < 0;
    case 'rightLeg':   return rec.group === 'legs'  && rec.mesh.position.x >= 0;
    case 'leftFoot':   return rec.group === 'feet'  && rec.mesh.position.x < 0;
    case 'rightFoot':  return rec.group === 'feet'  && rec.mesh.position.x >= 0;
    default: return false;
  }
}
function updatePinGlow3D() {
  clearPinGlow3D();
  if (!selectedJoint3D || selectedJoint3D.jointType !== 'wrist') return;
  const pose = POSES3D[currentPose3D];
  const ht = pose && pose[selectedJoint3D.side] && pose[selectedJoint3D.side].handTarget;
  if (!ht || !ht.mesh) return;
  meshRecords3D.forEach(rec => {
    if (rec.mesh && rec.mesh.material && rec.mesh.material.emissive && meshRecordMatchesPinKey3D(rec, ht.mesh)) {
      rec.mesh.material.emissive.setHex(PIN_GLOW_COLOR_3D);
      pinGlowMeshes3D.push(rec.mesh);
    }
  });
}

// Fires continuously while a gizmo handle is being dragged.
function onJointGizmoChange3D() {
  if (!selectedJoint3D) return;
  const { side, jointType } = selectedJoint3D;
  if (gizmoMode3D === 'rotate') {
    const grp = rig3D[side + (jointType === 'elbow' ? 'Elbow' : 'Wrist')];
    if (!grp) return;
    if (jointType === 'wrist') {
      // The gizmo is dragging gizmoProxy3D (a world-space stand-in oriented
      // to the ELBOW, not the wrist — see attachGizmoToSelection3D), so
      // first convert its world orientation back into the wrist's own
      // LOCAL rotation (relative to the elbow) before it can be read as
      // Bend/Turn: local = elbowWorldQuat⁻¹ × proxyWorldQuat.
      const elbowGrp = rig3D[side + 'Elbow'];
      if (!elbowGrp) return;
      const elbowWorldQuat = new THREE.Quaternion();
      elbowGrp.getWorldQuaternion(elbowWorldQuat);
      const localQuat = elbowWorldQuat.invert().multiply(gizmoProxy3D.quaternion);
      // Drag -> Bend/Turn only (clamped). XYZ Euler has two equivalent
      // solutions; take the one closest to the current values.
      const e = new THREE.Euler().setFromQuaternion(localQuat, 'XYZ');
      const norm = d => { d = ((d + 180) % 360 + 360) % 360 - 180; return d; };
      const sgn = side === 'left' ? -1 : 1; // rotation.y = turn * sgn
      const r = lastPoseResolved3D && lastPoseResolved3D[side];
      const curX = r ? r.wrist : 0, curY = r ? r.wristTurn * sgn : 0;
      const a = [rad2deg(e.x), rad2deg(e.y)];
      const b = [norm(rad2deg(e.x) + 180), norm(180 - rad2deg(e.y))];
      const dist = c => Math.abs(norm(c[0] - curX)) + Math.abs(norm(c[1] - curY));
      const pick = dist(a) <= dist(b) ? a : b;
      wristRotationOverride[side] = clampWristBend(pick[0]);
      handRotationOverride[side] = clampTurnFree(pick[1] * sgn);
      jointEditsForPose3D(currentPose3D)[side].wristQuat = null;
      const turn = handRotationOverride[side];
      grp.rotation.set(deg2rad(wristRotationOverride[side]), deg2rad(turn * sgn), 0);
      if (r) { r.wrist = wristRotationOverride[side]; r.wristTurn = turn; }
      applyHandFlipVisuals3D(side, turn);
      groundBody3D(false);
      updateJointPanelValues3D();
      return;
    }
    jointEditsForPose3D(currentPose3D)[side][jointType === 'elbow' ? 'elbowQuat' : 'wristQuat'] = grp.quaternion.clone();
  } else {
    const boneGroup  = jointType === 'elbow' ? rig3D[side + 'Shoulder'] : rig3D[side + 'Elbow'];
    const childGroup = jointType === 'elbow' ? rig3D[side + 'Elbow']    : rig3D[side + 'Wrist'];
    if (!boneGroup || !childGroup) return;
    const q = aimBoneToWorldPoint3D(boneGroup, childGroup.position, gizmoProxy3D.position);
    jointEditsForPose3D(currentPose3D)[side][jointType === 'elbow' ? 'shoulderQuat' : 'elbowQuat'] = q;
  }
  reapplyManualJointEdits3D();
  groundBody3D(false); // cheap re-ground during the drag; full reframe happens on release
  updateJointPanelValues3D();
}

// Re-stamps every active manual override — called at the end of every
// applyPose3D() (see the hook there) so a drag isn't silently undone the
// next time a pose/slider/hand-facing change runs applyPose3D again.
function reapplyManualJointEdits3D() {
  const je = jointEditsForPose3D(currentPose3D, false);
  ['left', 'right'].forEach(side => {
    const m = je[side];
    if (m.shoulderQuat && rig3D[side + 'Shoulder']) rig3D[side + 'Shoulder'].quaternion.copy(m.shoulderQuat);
    if (m.elbowQuat && rig3D[side + 'Elbow'])       rig3D[side + 'Elbow'].quaternion.copy(m.elbowQuat);
    if (m.wristQuat && rig3D[side + 'Wrist'])       rig3D[side + 'Wrist'].quaternion.copy(m.wristQuat);
  });
}

function resetSelectedJoint3D() {
  if (!selectedJoint3D) return;
  const { side, jointType } = selectedJoint3D;
  const je = jointEditsForPose3D(currentPose3D);
  if (jointType === 'elbow') { je[side].shoulderQuat = null; je[side].elbowQuat = null; }
  else { je[side].wristQuat = null; }
  applyPose3D(currentPose3D, { reframe: false });
  attachGizmoToSelection3D();
  updateJointPanelValues3D();
}

// ---- Numeric panel: position (pelvis-relative cm) + rotation (degrees) ----
function onJointPosInput(axis, rawVal) {
  if (!selectedJoint3D) return;
  const n = parseFloat(rawVal);
  if (isNaN(n)) return;
  const { side, jointType } = selectedJoint3D;
  const grp = rig3D[side + (jointType === 'elbow' ? 'Elbow' : 'Wrist')];
  if (!grp || !bodyGroup3D) return;
  const world = new THREE.Vector3(); grp.getWorldPosition(world);
  const local = bodyGroup3D.worldToLocal(world.clone());
  local[axis] = n;
  const targetWorld = bodyGroup3D.localToWorld(local.clone());
  const boneGroup  = jointType === 'elbow' ? rig3D[side + 'Shoulder'] : rig3D[side + 'Elbow'];
  const childGroup = jointType === 'elbow' ? rig3D[side + 'Elbow']    : rig3D[side + 'Wrist'];
  if (!boneGroup || !childGroup) return;
  const q = aimBoneToWorldPoint3D(boneGroup, childGroup.position, targetWorld);
  jointEditsForPose3D(currentPose3D)[side][jointType === 'elbow' ? 'shoulderQuat' : 'elbowQuat'] = q;
  reapplyManualJointEdits3D();
  groundBody3D(false);
  attachGizmoToSelection3D();
  updateJointPanelValues3D();
}
// Wrist Bend/Turn fields and gizmo drags all land here so limits always apply:
// they set the same per-side overrides the dropdowns use (clamped), which ⬆ Save
// then bakes into the pose. Any old free-form wrist rotation is dropped.
function setWristNumbers3D(side, axis, n) {
  if (axis === 'x') wristRotationOverride[side] = clampWristBend(n);
  else if (axis === 'z') wristSwingOverride[side] = clampWristSwing(n);
  else handRotationOverride[side] = clampTurnFree(n);
  jointEditsForPose3D(currentPose3D)[side].wristQuat = null;
  applyPose3D(currentPose3D, { reframe: false });
  // Always re-attach (even in rotate mode): the rotate gizmo sits on a
  // proxy snapshotted to the elbow's orientation (see
  // attachGizmoToSelection3D), which only re-syncs to the new Turn/Bend on
  // reattach — unlike the old direct-attach approach, it won't just track
  // a typed change on its own.
  attachGizmoToSelection3D();
  updateJointPanelValues3D();
}
// The number inputs above (Position/Rotation X/Y/Z, including the wrist's
// Bend/Turn/Swing) are all `type=number`, whose mobile numeric keypad often
// has no minus-sign key — there'd be no way to type a negative value at
// all on a touchscreen otherwise. This flips the field's current sign and
// fires a real 'input' event so it goes through the exact same handler
// (onJointPosInput/onJointRotInput) a keyboard edit would.
function flipJointNumSign3D(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = round1(-(parseFloat(el.value) || 0));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function onJointRotInput(axis, rawVal) {
  if (!selectedJoint3D) return;
  const n = parseFloat(rawVal);
  if (isNaN(n)) return;
  const { side, jointType } = selectedJoint3D;
  if (jointType === 'wrist') { setWristNumbers3D(side, axis, n); return; }
  const grp = rig3D[side + (jointType === 'elbow' ? 'Elbow' : 'Wrist')];
  if (!grp) return;
  const euler = new THREE.Euler().setFromQuaternion(grp.quaternion, 'XYZ');
  euler[axis] = deg2rad(n);
  jointEditsForPose3D(currentPose3D)[side][jointType === 'elbow' ? 'elbowQuat' : 'wristQuat'] = new THREE.Quaternion().setFromEuler(euler);
  reapplyManualJointEdits3D();
  groundBody3D(false);
  attachGizmoToSelection3D();
  updateJointPanelValues3D();
}
// Hand-facing dropdowns in the wrist panel — thin wrapper around the
// existing Hand/Wrist Facing panel logic (HAND_ROTATION_DEG/WRIST_ROTATION_DEG),
// scoped to just the selected side instead of whatever the Hand/Wrist panel's
// own side selector currently points at.
function setJointHandFacing3D(kind, value) {
  if (!selectedJoint3D) return;
  const prevSide = handWristTargetSide;
  handWristTargetSide = selectedJoint3D.side;
  const v = value === '' ? 'default' : value; // "Pose default" = drop any saved facing back to the pose's built-in
  if (kind === 'hand') setHandRotationInput(v); else setWristRotationInput(v);
  handWristTargetSide = prevSide;
  refreshHandWristButtons();
  // Same reason as setWristNumbers3D: this can change Turn/Bend while the
  // rotate gizmo's proxy is still sitting at its old elbow-aligned snapshot.
  attachGizmoToSelection3D();
  updateJointPanelValues3D();
}
// ✕ Unpin in the wrist settings: frees the selected hand from its pin (back
// to the Default Setter position, or the legacy fixed-angle path if no
// default has been captured). Session only until ⬆ Save (Cancel undoes it).
function jointPanelUnpin3D() {
  if (!selectedJoint3D || selectedJoint3D.jointType !== 'wrist') return;
  snapshotPinsForCancel3D();
  unpinHandWrist3D(selectedJoint3D.side);
  attachGizmoToSelection3D();
  updateJointPanelValues3D();
}

function openJointPanel3D() {
  const panel = document.getElementById('jointEditorPanel');
  if (!panel || !selectedJoint3D) return;
  panel.style.display = '';
  const wristOnlyRow = document.getElementById('jeWristOnlyRow');
  if (wristOnlyRow) wristOnlyRow.style.display = selectedJoint3D.jointType === 'wrist' ? '' : 'none';
  updateJointPanelValues3D();
}
function closeJointPanel3D() {
  const panel = document.getElementById('jointEditorPanel');
  if (panel) panel.style.display = 'none';
}
function updateJointPanelValues3D() {
  if (!selectedJoint3D) return;
  syncWristSliders3D();
  const { side, jointType } = selectedJoint3D;
  const grp = rig3D[side + (jointType === 'elbow' ? 'Elbow' : 'Wrist')];
  if (!grp || !bodyGroup3D) return;
  const world = new THREE.Vector3(); grp.getWorldPosition(world);
  const local = bodyGroup3D.worldToLocal(world.clone());
  const euler = new THREE.Euler().setFromQuaternion(grp.quaternion, 'XYZ');
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = round1(v);
  };
  setVal('jePosX', local.x); setVal('jePosY', local.y); setVal('jePosZ', local.z);
  setVal('jeRotX', euler.x * 180 / Math.PI);
  setVal('jeRotY', euler.y * 180 / Math.PI);
  setVal('jeRotZ', euler.z * 180 / Math.PI);
  const title = document.getElementById('jeTitle');
  if (title) title.textContent = `${side === 'left' ? 'Left' : 'Right'} ${jointType === 'elbow' ? 'Elbow' : 'Wrist'}`;
  updateJePinStatus3D();
  // Keep the Hand Facing / Wrist dropdowns showing what's actually active.
  const hSel = document.getElementById('jeHandFacingSel'), wSel = document.getElementById('jeWristFacingSel');
  // Show the ACTUAL resolved degrees as a word (0° -> Front etc.), so the
  // dropdowns stay in sync with the numbers whether they came from an
  // override, the pose, or a saved edit. Off-preset values show "Custom (n°)".
  const res = lastPoseResolved3D && lastPoseResolved3D[side];
  const syncSel = (sel, deg, table) => {
    if (!sel) return;
    const old = sel.querySelector('option[data-custom]'); if (old) old.remove();
    // Used to always blank out here for a pinned hand, since the surface
    // pin fully overwrote the angle anyway (no preset could ever match).
    // Now that a manual override can win over the pin (see applyPose3D),
    // `deg` is the actual resolved angle either way — so just match it
    // against the preset table like the unpinned case, pinned or not.
    if (deg === undefined || deg === null) { sel.value = ''; return; }
    const hit = Object.keys(table).find(k => Math.abs(table[k] - deg) < 0.5);
    if (hit) { sel.value = hit; return; }
    const o = document.createElement('option');
    o.value = '__custom'; o.disabled = true; o.setAttribute('data-custom', '1');
    o.textContent = `Custom (${round1(deg)}°)`;
    sel.appendChild(o); sel.value = '__custom';
  };
  syncSel(hSel, res && res.wristTurn, HAND_ROTATION_DEG[side]);
  syncSel(wSel, res && res.wrist, WRIST_ROTATION_DEG);
  // Wrist rotation fields are the wrist's own numbers, not raw Euler angles:
  // X = Bend (-80..80), Y = Turn (-180..180), Z unused. The same Turn number on
  // both hands is a mirrored pair.
  const rotLabels = ['X', 'Y', 'Z'];
  ['jeRotX', 'jeRotY', 'jeRotZ'].forEach((id, i) => {
    const el = document.getElementById(id), sp = el && el.parentElement && el.parentElement.querySelector('span');
    if (!el || !sp) return;
    if (jointType === 'wrist') {
      sp.textContent = ['Bend', 'Turn', 'Swing'][i]; el.disabled = false;
      if (res && document.activeElement !== el) el.value = i === 0 ? round1(res.wrist) : i === 1 ? round1(res.wristTurn) : round1(res.swing || 0);
      el.min = i === 0 ? WRIST_BEND_RANGE[0] : i === 1 ? -180 : WRIST_SWING_RANGE[0];
      el.max = i === 0 ? WRIST_BEND_RANGE[1] : i === 1 ? 180 : WRIST_SWING_RANGE[1];
    } else { sp.textContent = rotLabels[i]; el.disabled = false; el.removeAttribute('min'); el.removeAttribute('max'); }
  });
}

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
    });
    pinPushChain3D = pinPushChain3D.then(run, run);
    await pinPushChain3D;
    for (const sd of ['left', 'right']) jointEditorPinDirty3D[sd] = false;
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
