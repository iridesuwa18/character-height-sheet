// ── char-constants.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Constants, scale/degree helpers, pose-literal lookup, wrist/hand rotation degree tables, clamp helpers, forearm palm/dorsum flip visuals, and expandPose3D (resolves a pose entry + overrides into final per-side numbers).
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

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

