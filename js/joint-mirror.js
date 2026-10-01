// ── joint-mirror.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Mirrors a wrist/arm's current state to
// the opposite side — mirrorArmToOtherSide3D and friends.
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
function mirrorArmToOtherSide3D(side) {
  const other = side === 'left' ? 'right' : 'left';
  const shoulderGrp = rig3D[side + 'Shoulder'];
  const elbowGrp = rig3D[side + 'Elbow'];
  const wr = lastPoseResolved3D && lastPoseResolved3D[side];
  // Mirror the whole arm (shoulder + elbow aim, so the hand lands in the
  // reflected spot) and the hand: wrist Bend and Turn are copied unchanged
  // (the two hands turn in opposite directions for the same number, so an
  // equal Turn is a mirrored pair), as the dropdowns' own numbers.
  const je = jointEditsForPose3D(currentPose3D);
  if (shoulderGrp) je[other].shoulderQuat = mirrorQuat3D(shoulderGrp.quaternion);
  if (elbowGrp)    je[other].elbowQuat    = mirrorQuat3D(elbowGrp.quaternion);
  // Bend/Turn/Swing are the wrist's whole rotation (Bend on the Wrist group,
  // Turn on the HandTurn group — see applyPose3D/buildArmSide) and copying
  // the SAME raw number to both sides already mirrors it exactly, because
  // Turn/Swing's own sign flips per side (see the *-1/*1 in applyPose3D)
  // while Bend doesn't. Clearing wristQuat/handTurnQuat here makes the
  // overrides the ONLY source of truth for a mirrored wrist's rotation.
  if (wr) {
    wristRotationOverride[other] = clampWristBend(wr.wrist);
    wristSwingOverride[other] = clampWristSwing(wr.swing || 0);
    handRotationOverride[other] = clampTurnFree(wr.wristTurn);
  }
  je[other].wristQuat = null;
  je[other].handTurnQuat = null;
  applyPose3D(currentPose3D, { reframe: false });
  reapplyManualJointEdits3D();
  groundBody3D(false);
  return { other };
}
// Quick Options → Mirror: ask first, so a stray tap can't flip an arm.
function openMirrorConfirm3D() {
  if (!selectedJoint3D) { showJointEditorHint3D('Select a joint first'); return; }
  toggleQuickOptions3D(false);
  const from = selectedJoint3D.side === 'left' ? 'Left' : 'Right';
  const to = selectedJoint3D.side === 'left' ? 'Right' : 'Left';
  const dir = document.getElementById('jeMirrorConfirmDir');
  if (dir) dir.textContent = from + ' → ' + to;
  const pop = document.getElementById('jeMirrorConfirm');
  if (pop) pop.classList.add('open');
}
function closeMirrorConfirm3D() {
  const pop = document.getElementById('jeMirrorConfirm');
  if (pop) pop.classList.remove('open');
}
function confirmMirror3D() {
  closeMirrorConfirm3D();
  mirrorSelectedJoint3D();
}
function mirrorSelectedJoint3D() {
  if (!selectedJoint3D) return;
  const { side } = selectedJoint3D;
  const { other } = mirrorArmAndAttachmentToOtherSide3D(side);
  if (selectedJoint3D && (selectedJoint3D.side === other)) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  const status = document.getElementById('jeMirrorStatus');
  if (status) {
    status.textContent = `Mirrored arm + hand to ${other === 'left' ? 'Left' : 'Right'}`;
    status.style.opacity = '1';
    clearTimeout(mirrorSelectedJoint3D._t);
    mirrorSelectedJoint3D._t = setTimeout(() => { status.style.opacity = '0'; }, 1600);
  }
}
// Mirrors BOTH an arm's live pose (mirrorArmToOtherSide3D, above) AND —
// if that side currently has one — its stored wrist face-attachment (see
// facesWristAttachment3D in joint-faces-panel.js), reflected onto the
// opposite side, in one call. This is what both the 3D editor's own ⇄
// Mirror button (mirrorSelectedJoint3D above) and the Faces popup's own
// "⇄ Mirror L→R" button (mirrorFacesWristAttachment3D) call now, so either
// one mirrors the pose AND the attachment together instead of each only
// doing its own half and leaving the other side's arm/attachment stale.
function mirrorArmAndAttachmentToOtherSide3D(side) {
  const { other } = mirrorArmToOtherSide3D(side);
  const src = facesWristAttachment3D[side];
  if (src) {
    facesWristAttachment3D[other] = mirrorWristAttachmentSpec3D(src);
    // Re-lock (or unlock) the currently-edited dot exactly like Apply/Mirror
    // already do elsewhere — true if the dot on screen right now happens to
    // be sitting at either wrist's (possibly just-changed) attachment spot.
    facesDotLocked3D = facesWristMatchesCurrentDot3D('left') || facesWristMatchesCurrentDot3D('right');
    syncFacesDotInputs3D();
    refreshFacesWristReadouts3D();
    applyFacesHighlight3D();
  }
  // Mirror the wrist PIN too (position + Turn/Bend/Swing rotation) — if
  // `side` is currently pinned, `other` becomes pinned to the reflected
  // spot/rotation as well. Only acts when the source side actually has a
  // pin, same as the attachment mirror just above: an unpinned source
  // leaves whatever the other side already had alone rather than clearing it.
  const pin = wristPinsForPose3D(currentPose3D)[side];
  if (pin) {
    wristPinsForPose3D(currentPose3D)[other] = mirrorWristPinSpec3D(pin);
    syncWristPinReadout3D();
    // Settle `other` into its new leash immediately, the same way a page
    // reload does (see applyWristPinsState3D's callers in
    // joint-github-sync.js / hand-pins-github.js, which always follow a
    // pin restore with the same converge helper). Without this, `other`'s
    // rig is still sitting wherever mirrorArmToOtherSide3D's naive Bend/
    // Turn/Swing copy left it — which, for a dot off at a leg or the far
    // side of the body, can be many tens of degrees from the real
    // reach-clamped target, and Snap Back's own capped wrist-aim slerp
    // (see enforceWristPinConstraintsConverge3D in joint-faces-panel.js)
    // can fall well short starting that far off — exactly what made a
    // freshly-mirrored wrist rotate to a wrong (e.g. inward-twisted) spot
    // the first time Snap Back was pressed.
    if (typeof enforceWristPinConstraintsConverge3D === 'function') {
      enforceWristPinConstraintsConverge3D();
      groundBody3D(false);
    }
  }
  return { other };
}
// X is the left/right axis in the spine-local frame (see buildArmSide in
// body-build-pose.js — a side's arm boxes sit at +/-xCm off the spine), so
// mirroring a pinned position across the body's centerline just negates X
// and keeps Y/Z — for the wrist spot and its shoulder/elbow anchors alike.
// Turn/Bend/Swing are copied unchanged, same reasoning as
// mirrorArmToOtherSide3D above: each axis's own sign convention already
// flips per side inside applyPose3D, so an equal number lands mirrored.
function mirrorWristPinSpec3D(pin) {
  if (!pin) return null;
  return {
    x: round2(-pin.x), y: pin.y, z: pin.z,
    turn: pin.turn, bend: pin.bend, swing: pin.swing,
    sx: pin.sx == null ? null : round2(-pin.sx), sy: pin.sy, sz: pin.sz,
    ex: pin.ex == null ? null : round2(-pin.ex), ey: pin.ey, ez: pin.ez,
    // Leash fields (see applyWristPin3D in joint-faces-panel.js): the dot
    // origin mirrors the same X-negate/Y,Z-keep rule as the position above;
    // R and the two bone lengths are plain distances, unaffected by
    // mirroring, so they copy straight across. Missing these is exactly
    // what made a mirrored pin read "no dot attached" — r stayed undefined
    // instead of carrying the source side's value.
    dox: pin.dox == null ? null : round2(-pin.dox), doy: pin.doy, doz: pin.doz,
    r: pin.r, upperLen: pin.upperLen, foreLen: pin.foreLen,
    torsoHalfWidth: pin.torsoHalfWidth,
    // Frozen shoulder/elbow rotations, mirrored the same way the joint
    // mirror reflects a quaternion (negate y,z).
    sq: (Array.isArray(pin.sq) && pin.sq.length === 4) ? [pin.sq[0], -pin.sq[1], -pin.sq[2], pin.sq[3]] : null,
    eq: (Array.isArray(pin.eq) && pin.eq.length === 4) ? [pin.eq[0], -pin.eq[1], -pin.eq[2], pin.eq[3]] : null,
  };
}
