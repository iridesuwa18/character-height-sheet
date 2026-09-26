// ── arm-ik.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. The 2-bone arm IK solver: ikContext3D (current-build geometry), mesh-face pin target resolution, and applyArmPosition3D, which aims the shoulder/elbow so the wrist lands as close as physically possible to its resolved target.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

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
// otherwise the Default Setter's saved wrist position (captureHandDefaultFromCurrent3D),
// otherwise null (caller falls back to the legacy fixed-angle rig).
//
// resolveElbowTargetPos3D gives the elbow's absolute target position: its
// own Default Setter position, shifted by exactly however far the wrist has
// moved from ITS Default Setter position — "its own elbow location + any
// shifts in position affected by the hand it's attached to."
//
// applyArmPosition3D then aims (never re-lengths) the shoulder→elbow and
// elbow→wrist segments at those two targets in turn. Because each segment
// is aimed rather than stretched, both bones stay exactly their built
// length at all times — the only thing that can happen when a target is
// out of reach is the final segment's direction landing slightly off the
// literal target point, which is the "move the hand accordingly in any
// direction (xyz) to a minimum so the elbow is not restricted to breaking"
// behavior asked for: the smallest possible correction, never a bigger one.
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
  return def && def.wrist ? v3(def.wrist.x, def.wrist.y, def.wrist.z) : null;
}
function resolveElbowTargetPos3D(side, wristAbsPos) {
  const def = pinDefaults3D[side];
  if (!def || !def.elbow || !def.wrist) return null;
  return v3add(v3(def.elbow.x, def.elbow.y, def.elbow.z), v3sub(wristAbsPos, v3(def.wrist.x, def.wrist.y, def.wrist.z)));
}
// Aims shoulderGrp/elbowGrp so the wrist lands as close as physically
// possible (rigid segment lengths) to wristAbsPos, routing through an elbow
// that follows resolveElbowTargetPos3D's default-plus-hand-delta rule.
// Returns true if it ran (defaults are captured for this side), false if
// the caller should fall back to the legacy fixed-angle rig.
function applyArmPosition3D(side, shoulderGrp, elbowGrp, pose) {
  const def = pinDefaults3D[side];
  const shoulderPos = ikContext3D.shoulders[side];
  const lens = ikContext3D.armLens[side];
  if (!def || !def.elbow || !def.wrist || !shoulderGrp || !elbowGrp || !shoulderPos || !lens) return false;
  const wristAbsPos = resolveHandAbsolutePos3D(side, pose);
  if (!wristAbsPos) return false;
  const elbowTargetPos = resolveElbowTargetPos3D(side, wristAbsPos);
  if (!elbowTargetPos) return false;

  // Shoulder → elbow: aim only, length is always exactly lens.upper.
  let elbowDir = v3sub(elbowTargetPos, shoulderPos);
  if (v3len(elbowDir) < 1e-6) elbowDir = v3(0, -1, 0); // degenerate target — straight down, never breaks
  elbowDir = v3norm(elbowDir);
  const shoulderEuler = eulerXYZFromAimAndHinge(elbowDir, defaultAimHint3D(side));
  shoulderGrp.rotation.x = shoulderEuler.flexRad;
  shoulderGrp.rotation.y = shoulderEuler.rollRad;
  shoulderGrp.rotation.z = shoulderEuler.zRad;
  const elbowActualPos = v3add(shoulderPos, v3scale(elbowDir, lens.upper));

  // Elbow → wrist: same idea, aimed from the elbow's ACTUAL (post-aim)
  // position, in elbowGrp's own local frame (elbowGrp is a child of
  // shoulderGrp, so its local axes are shoulderGrp's local axes BEFORE
  // shoulderGrp's own rotation — undo that rotation to express the desired
  // world/spine-local direction in elbowGrp's frame).
  let wristDirWorld = v3sub(wristAbsPos, elbowActualPos);
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
