// ── body-build-pose.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. buildBody3D (rebuilds the full rig from the 2D layout) and applyPose3D (applies a named pose's numbers to that rig), plus the pose panel/pose-modal UI and the depth/waistline slider handlers.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

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
  // (negative x = left), matching up which box the actual leg mesh was
  // built from.
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

    // Wrist pivot: sits AT the wrist joint and only ever carries Bend
    // (flexion, x) and Swing (radial/ulnar deviation, z) — nested inside the
    // elbow group so a pose can bend/swing the hand independently of
    // whatever the shoulder and elbow are doing. This is the joint that
    // actually lets a hand lie flat against a hip, tuck under an opposite
    // forearm, or curl to support a chin — without it the hand can only
    // ever trail along as a rigid extension of the forearm.
    const wristGroup = new THREE.Group();
    // Bend (x) applied first, then Swing (z) in the bent frame — default
    // 'XYZ' order already does this since Turn no longer lives here (y stays 0).
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
      rig3D[side + 'WristJointMesh'] = wristJoint; // used by the Joint Editor to highlight the selected joint

      // Hand-turn pivot: the hand's own center, half the hand's own height
      // below the wrist. Turn (rotation about the forearm's long axis) lives
      // HERE now instead of on wristGroup, so twisting the hand rotates it
      // in place around its own middle rather than sweeping around the
      // wrist — while Bend/Swing above stay anchored at the wrist itself.
      // Everything belonging to the hand (the hand block, the thumb) hangs
      // from this group instead of directly from wristGroup, offset back up
      // by the same amount so nothing visually shifts when Turn is 0.
      const handCenterOffsetCm = handBox.hCm / 2;
      const handTurnGroup = new THREE.Group();
      handTurnGroup.position.set(0, -handCenterOffsetCm, 0);
      wristGroup.add(handTurnGroup);
      rig3D[side + 'HandTurn'] = handTurnGroup;

      const hand = makeBoxMesh({ wCm: handBox.wCm, hCm: handBox.hCm, group: 'hands' }, handDepthCm);
      hand.position.set(0, 0, 0);
      handTurnGroup.add(hand);
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
      // rebuild the mesh. Position is relative to handTurnGroup now (offset
      // by handCenterOffsetCm from its old wristGroup-relative position).
      const thumbSign = side === 'right' ? 1 : -1;
      const thumbW = handBox.wCm * 0.32, thumbH = handBox.hCm * 0.4, thumbD = handDepthCm * 0.8;
      const thumb = makeBoxMesh({ wCm: thumbW, hCm: thumbH, group: 'hands' }, thumbD);
      const thumbPivot = new THREE.Group();
      thumbPivot.position.set(thumbSign * handBox.wCm * 0.42, handCenterOffsetCm - handBox.hCm * 0.18, 0);
      thumbPivot.rotation.z = deg2rad(thumbSign * 35);
      thumb.position.set(0, -thumbH/2, 0);
      thumbPivot.add(thumb);
      handTurnGroup.add(thumbPivot);
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
  const leftElbowLift = leftWrist.elbowLift + (elbowLiftOverride.left || 0);
  const leftElbowBend = elbowBendOverride.left != null ? elbowBendOverride.left : p.elbowL;
  setBallJoint(rig3D.leftShoulder, p.shoulderL, (p.shoulderAbdL || 0) + leftElbowLift, -1);
  if (rig3D.leftShoulder) rig3D.leftShoulder.rotation.y = deg2rad((p.shoulderRollL || 0) * -1);
  setHinge(rig3D.leftElbow, leftElbowBend);
  const rightWrist = turnFreeR ? { clamped: clampTurnFree(p.wristTurnR), elbowLift: 0 } : clampWristTurn('right', p.wristTurnR);
  p.wristTurnR = rightWrist.clamped;
  const rightElbowLift = rightWrist.elbowLift + (elbowLiftOverride.right || 0);
  const rightElbowBend = elbowBendOverride.right != null ? elbowBendOverride.right : p.elbowR;
  setBallJoint(rig3D.rightShoulder, p.shoulderR, (p.shoulderAbdR || 0) + rightElbowLift, 1);
  // shoulderRoll: same mirroring convention as hipTurn — applied AFTER the
  // ball joint's flex/abd, on the same shoulder group, so it re-aims the
  // elbow's hinge axis without disturbing flex/abd.
  if (rig3D.rightShoulder) rig3D.rightShoulder.rotation.y = deg2rad((p.shoulderRollR || 0) * 1);
  setHinge(rig3D.rightElbow, rightElbowBend);
  // wrist: bend is a hinge exactly like the elbow (same fixed sign
  // convention — see the pose-authoring notes above), anchored at the wrist
  // joint. Swing (side-to-side, also anchored at the wrist) is applied on
  // the same group, after Bend. wristTurn re-aims which way the hand block
  // faces by rotating it about the forearm's own long axis — that rotation
  // now lives on the HandTurn group (pivoting at the hand's own center, see
  // buildArmSide) rather than on the wrist group itself. Mirrored the same
  // way as shoulderRoll/hipTurn: a shared value turns the hands to face
  // each other (useful for clasped hands), not the same way.
  setHinge(rig3D.leftWrist, p.wristL); setHinge(rig3D.rightWrist, p.wristR);
  if (rig3D.leftWrist)  rig3D.leftWrist.rotation.z  = deg2rad((p.wristSwingL || 0) * -1);
  if (rig3D.rightWrist) rig3D.rightWrist.rotation.z = deg2rad((p.wristSwingR || 0) *  1);
  if (rig3D.leftHandTurn)  rig3D.leftHandTurn.rotation.y  = deg2rad((p.wristTurnL || 0) * -1);
  if (rig3D.rightHandTurn) rig3D.rightHandTurn.rotation.y = deg2rad((p.wristTurnR || 0) *  1);

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
  // Snapshot of exactly what got rendered this call — read by the wrist
  // slider overlay/panel so their numbers always match what's on screen.
  lastPoseResolved3D = {
    left:  { wristTurn: p.wristTurnL, wrist: p.wristL, swing: p.wristSwingL, elbow: leftElbowBend,  shoulderAbd: (p.shoulderAbdL || 0) + leftElbowLift },
    right: { wristTurn: p.wristTurnR, wrist: p.wristR, swing: p.wristSwingR, elbow: rightElbowBend, shoulderAbd: (p.shoulderAbdR || 0) + rightElbowLift },
  };
  // Re-stamp any manual Joint Editor drags on top of what the pose just
  // computed above, so a hand-dragged elbow/wrist survives pose switches,
  // slider tweaks, and hand/wrist-facing overrides until explicitly reset —
  // see reapplyManualJointEdits3D.
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

