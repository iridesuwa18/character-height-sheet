// ── joint-mirror.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Mirrors a wrist/arm's current state (pinned or not) to the opposite side — mirrorArmToOtherSide3D and friends. See the pinned-mirror-fix comment inside mirrorArmToOtherSide3D.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

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
function mirrorArmToOtherSide3D(side) {
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
    // Also mirror this side's Default Setter geometry (shoulder/elbow/wrist,
    // simple x-flip — the body's boxes are symmetric about x=0) straight
    // into `other` BEFORE the applyPose3D render below. Without this, that
    // render still uses `other`'s OLD/stale defaults against the BRAND NEW
    // mirrored pin target, so the elbow briefly computes a position that
    // has nothing to do with the source side's elbow — and
    // captureHandDefaultFromCurrent3D(other), called right after this
    // function returns, then bakes that mismatched elbow in as the
    // permanent new default. This is why pinned hands didn't mirror
    // correctly even though unpinned ones (plain quaternion copy, no
    // defaults involved) always did.
    const srcDef = pinDefaults3D[side];
    if (srcDef) {
      const mirrorPt = p => p ? { x: round2(-p.x), y: p.y, z: p.z } : null;
      pinDefaults3D[other] = {
        shoulder: mirrorPt(srcDef.shoulder),
        elbow: mirrorPt(srcDef.elbow),
        wrist: mirrorPt(srcDef.wrist),
        rot: (pinDefaults3D[other] && pinDefaults3D[other].rot) || { be: 0, tu: 0, sw: 0 },
      };
      pinDefaultsDirty3D[other] = true;
    }
    // A pin's whole point is that it re-resolves fresh off the CURRENT body
    // geometry every render (see resolveHandAbsolutePos3D) so it keeps
    // tracking its face through any later resize. A frozen quaternion
    // snapshot does the opposite — clear any earlier manual joint edit on
    // the mirrored side so it goes back to a live, tracking pin.
    const jePinned = jointEditsForPose3D(currentPose3D);
    jePinned[other].shoulderQuat = null;
    jePinned[other].elbowQuat    = null;
    // Wrist rotation (hand facing) is fully independent of the position pin
    // (see the block comment above resolveHandAbsolutePos3D) — the pin only
    // ever drives the shoulder/elbow aim, never the hand's own Bend/Turn/
    // Swing. Previously this branch cleared wristQuat and stopped, so a
    // pinned hand's facing was left at whatever it was before the mirror
    // (or the pose's own default) instead of copying the source hand's
    // actual rotation. Mirror it explicitly here, the same way the unpinned
    // branch below does.
    // Bend/Turn/Swing together are the wrist's full 3-DOF rotation (its
    // Euler x/y/z, one-for-one — see applyPose3D) and copying the SAME raw
    // number to both sides already mirrors it exactly, because Turn/Swing's
    // own sign flips per side (see the *-1/*1 in applyPose3D) while Bend
    // doesn't. Also stamping a separately-computed mirrored quaternion (the
    // old wristGrpSrc.quaternion negate-y/z copy) on top made this a second,
    // redundant writer for the exact same rotation: lastPoseResolved3D
    // (what the panel/Save read) reflects the Bend/Turn/Swing numbers set
    // just above, while the quaternion — applied afterward by
    // reapplyManualJointEdits3D — is what's actually rendered. Any drift
    // between the two (float rounding, or the Euler decomposition's two
    // equivalent solutions) meant the saved numbers and the on-screen
    // rotation could disagree. Clearing wristQuat here makes the overrides
    // the ONLY source of truth for a mirrored wrist's rotation.
    if (wr) {
      wristRotationOverride[other] = clampWristBend(wr.wrist);
      wristSwingOverride[other] = clampWristSwing(wr.swing || 0);
      handRotationOverride[other] = clampTurnFree(wr.wristTurn);
    }
    jePinned[other].wristQuat = null;
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
    // Bend/Turn/Swing are the wrist's whole rotation (see the block comment
    // in the pinned branch above for why the redundant quaternion mirror is
    // gone) — same number = mirrored hand, nothing else needed.
    if (wr) {
      wristRotationOverride[other] = clampWristBend(wr.wrist);
      wristSwingOverride[other] = clampWristSwing(wr.swing || 0);
      handRotationOverride[other] = clampTurnFree(wr.wristTurn);
    }
    jeUnpinned[other].wristQuat = null;
  }
  applyPose3D(currentPose3D, { reframe: false });
  reapplyManualJointEdits3D();
  groundBody3D(false);
  return { other, srcPin: !!srcPin };
}
function mirrorSelectedJoint3D() {
  if (!selectedJoint3D) return;
  const { side } = selectedJoint3D;
  const { other, srcPin } = mirrorArmToOtherSide3D(side);
  if (selectedJoint3D && (selectedJoint3D.side === other)) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  const status = document.getElementById('jeMirrorStatus');
  if (status) {
    status.textContent = `Mirrored ${srcPin ? 'pin' : 'arm + hand'} to ${other === 'left' ? 'Left' : 'Right'} (exact copy, build 3)`;
    status.style.opacity = '1';
    clearTimeout(mirrorSelectedJoint3D._t);
    mirrorSelectedJoint3D._t = setTimeout(() => { status.style.opacity = '0'; }, 1600);
  }
}
// Manually re-syncs one wrist's Default Setter data to wherever it currently
// sits — fixes the staleness the automatic pin-time capture can't handle:
// once a pin is tracking a mesh face, later body resizes or gizmo nudges
// keep moving the LIVE wrist away from whatever was captured at pin time,
// and neither pinning again nor ⬆ Save ever re-captures it on their own.
// Also mirrors the freshly-updated arm onto the opposite side and captures
// ITS resulting position+rotation as its own new default too, so both
// sides' Default Setter data stays a matched, symmetric pair. Session-only,
// like everything else here — ⬆ Save is still what pushes it to GitHub.
function updateHandDefaultAndMirror3D(side) {
  if (side !== 'left' && side !== 'right') return;
  captureHandDefaultFromCurrent3D(side);
  const { other } = mirrorArmToOtherSide3D(side);
  captureHandDefaultFromCurrent3D(other);
  if (selectedJoint3D && (selectedJoint3D.side === side || selectedJoint3D.side === other)) {
    attachGizmoToSelection3D(); updateJointPanelValues3D();
  }
  updateJePinStatus3D();
  setPinSaveStatus3D(`Updated ${side === 'left' ? 'L' : 'R'} wrist default, mirrored to ${other === 'left' ? 'L' : 'R'} — click Save to confirm.`);
}
