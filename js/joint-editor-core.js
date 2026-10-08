// ── joint-editor-core.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Interactive Joint Editor: selection state, gizmo mode, opening/closing/cancelling the fullscreen editor, the settings popup, "copy elbow+wrist from another pose", and the Copy Poses popup.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

// ============================================================================
// ---- Interactive Joint Editor: wrist & elbow -------------------------------
// Tap the wrist or elbow directly in the 3D view to select it; a Move/Rotate
// arrow gizmo (THREE.TransformControls) appears on it, and a side panel shows
// exact position (cm, relative to the pelvis) and rotation (degrees), for
// when the joint itself is hard to grab (e.g. a wrist tucked into the torso).
//
// Rig recap (see buildArmSide): shoulderGroup -> elbowGroup -> wristGroup
// -> handTurnGroup, each a child of the last, at a FIXED local offset ("bone
// length") that buildArmSide sets once and this editor never changes — only
// rotations are ever touched, which is what keeps every drag anatomically
// valid:
//   - Dragging the ELBOW's position re-aims the SHOULDER so the elbow lands
//     at the requested spot on the sphere its fixed upper-arm length allows
//     (forearm + wrist + hand ride along rigidly, keeping their own bend).
//   - Dragging the WRIST's position re-aims the ELBOW the same way (hand
//     rides along, keeping its own facing) — you can't move a wrist without
//     either bending the elbow or swinging the whole arm, same as a real one.
//   - Rotating the ELBOW bends/twists the forearm, carrying the wrist+hand.
//   - Rotating the WRIST bends/swings the hand at the wrist joint; Turn
//     (rotating the hand about the forearm's own long axis) instead pivots
//     at handTurnGroup, anchored at the hand's own center — see
//     buildArmSide.
// A pure rotation can't stretch a bone, so every one of the above "conforms
// to the limitation" (fixed bone length) automatically — see
// aimBoneToWorldPoint3D.
// ============================================================================
let jointEditorInited3D = false;
let selectedJoint3D = null;            // { side:'left'|'right', jointType:'elbow'|'wrist'|'knee'|'ankle' } | null
let gizmoMode3D = 'translate';         // 'translate' | 'rotate' | 'off' (Quick Options toggles; 'off' = no gizmo)
let transformControls3D = null;
let gizmoProxy3D = null;               // world-space stand-in TransformControls actually drags in translate mode
// Fullscreen "3D Editor" mode: the model floods the screen with the joint
// toggle buttons + a small settings button, and everything else (pose
// panel, hand/wrist panel, other page chrome) is hidden until Apply/Cancel.
let jointEditorModeActive3D = false;
let jointEditorFacingSnapshot3D = null; // hand/wrist facing overrides when the editor opened, restored on Cancel
let jointEditorModeSnapshot3D = null;  // deep clone of manualJointEdits3D taken on open, restored on Cancel
let jointEditorPinsSnapshot3D = null;  // wrist pins (all poses) when the editor opened, restored on Cancel
let jointEditorAttachSnapshot3D = null; // Attached Wrists dots (all poses) when the editor opened, restored on Cancel
let pendingPoseSwitch3D = null;        // pose the person was heading to when the "save first?" prompt popped up
let jointSettingsPopupOpen3D = false;  // whether the ⚙ settings popup is currently shown
let jointEditorCopyLog3D = [];         // what "Copy poses" has pulled onto the current pose this editor session (drives the status chip)
let snapRotations3D = false;          // Quick Options → Snap rotations: gizmo rotates in 15° steps
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
// hipQuat / kneeQuat / ankleQuat: the leg side of the editor, same chain as the
// arm. Dragging a KNEE's position re-aims the hip pivot (hipQuat) exactly like
// dragging an elbow re-aims the shoulder; rotating the knee writes kneeQuat.
// Dragging an ANKLE's position re-aims the knee pivot (kneeQuat) like a wrist
// re-aims the elbow; rotating the ankle writes ankleQuat.
const JOINT_EDIT_KEYS_3D = ['shoulderQuat', 'elbowQuat', 'wristQuat', 'handTurnQuat', 'hipQuat', 'kneeQuat', 'ankleQuat'];
function blankJointEditsSide3D() { const o = {}; JOINT_EDIT_KEYS_3D.forEach(k => { o[k] = null; }); return o; }
const BLANK_JOINT_EDITS_3D = Object.freeze(blankJointEditsSide3D());
// Looks up the edit bucket for one pose. create=true (the default) lazily
// makes one if it doesn't exist yet — use for anything that's about to WRITE
// into it. Pass create=false for read-only lookups (e.g. reapply) so merely
// looking at a pose doesn't leave a permanent blank entry behind for it.
function jointEditsForPose3D(poseName, create = true) {
  if (!manualJointEdits3D[poseName]) {
    if (!create) return { left: BLANK_JOINT_EDITS_3D, right: BLANK_JOINT_EDITS_3D };
    manualJointEdits3D[poseName] = { left: blankJointEditsSide3D(), right: blankJointEditsSide3D() };
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
  applySnapRotations3D();

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
      groundBodyForArmEdit3D();
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
  // gesture on a touchscreen. The gizmo itself still lives on the canvas and
  // drags normally; only picking WHICH joint moved off the canvas.
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

// Same job as aimBoneToWorldPoint3D, but swings the bone from where it
// ALREADY points instead of rebuilding its rotation from scratch. The
// from-scratch version can only recover the bone's direction, so any twist
// the person had put on it (e.g. a rotated elbow) was thrown away whenever
// the joint below it was moved. This keeps that twist and only applies the
// smallest extra swing needed to reach the target.
function aimBoneKeepTwist3D(boneGroup, childGroup, targetWorldPos) {
  if (typeof nudgeBoneQuatToward3D === 'function') {
    return nudgeBoneQuatToward3D(boneGroup, childGroup.position, boneGroup.quaternion.clone(), targetWorldPos);
  }
  return aimBoneToWorldPoint3D(boneGroup, childGroup.position, targetWorldPos);
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
  if (typeof refreshQuickOptions3D === 'function') refreshQuickOptions3D();
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
    const cs = (side) => { const o = {}; JOINT_EDIT_KEYS_3D.forEach(k => { o[k] = c(side[k]); }); return o; };
    out[poseName] = { left: cs(s.left), right: cs(s.right) };
  });
  return out;
}
function openJointEditorMode3D() {
  if (!sceneInited3D) return;
  if (!jointEditorInited3D) initJointEditor3D();
  jointEditorModeSnapshot3D = cloneManualJointEdits3D(manualJointEdits3D);
  jointEditorFacingSnapshot3D = snapshotHandWristAll3D();
  jointEditorPinsSnapshot3D = collectWristPinsState3D();
  jointEditorAttachSnapshot3D = collectWristAttachmentsState3D();
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
  const poseBar = document.getElementById('jePoseBar'); if (poseBar) poseBar.style.display = 'flex';
  updatePoseNameLabel3D();
  setJointEditorCameraView3D('free');
  // Let the layout/CSS settle into fullscreen before telling three.js the
  // canvas has a new size, or it measures the old (small) box.
  setTimeout(resizeBody3D, 0);
}
function closeJointEditorModeUI3D() {
  if (typeof closeCompositionPanel3D === 'function') closeCompositionPanel3D(); // leaving the editor also leaves Composition
  jointEditorModeActive3D = false;
  jointEditorModeSnapshot3D = null;
  jointEditorFacingSnapshot3D = null;
  jointEditorPinsSnapshot3D = null;
  jointEditorAttachSnapshot3D = null;
  pendingPoseSwitch3D = null;
  closeUnsavedPoseConfirm3D();
  jointSettingsPopupOpen3D = false;
  const preview = document.getElementById('preview3D');
  if (preview) preview.classList.remove('je-fullscreen');
  document.body.classList.remove('je-fullscreen-active');
  const entry = document.getElementById('jointEditorEntryBar'); if (entry) entry.style.display = '';
  const topBar = document.getElementById('jointEditorTopBar'); if (topBar) topBar.style.display = 'none';
  const toggleBar = document.getElementById('jointToggleBar'); if (toggleBar) toggleBar.style.display = 'none';
  const bottomBar = document.getElementById('jointEditorBottomBar'); if (bottomBar) bottomBar.style.display = 'none';
  const copyBar = document.getElementById('jeCopyBar'); if (copyBar) copyBar.style.display = 'none';
  const poseBar = document.getElementById('jePoseBar'); if (poseBar) poseBar.style.display = 'none';
  closePosePopup3D();
  closeLevelPopup3D();
  closeCopyPopup3D();
  if (typeof closeFacesPopup3D === 'function') closeFacesPopup3D();
  if (typeof resetFacesSelection3D === 'function') resetFacesSelection3D();
  jointEditorCopyLog3D = [];
  updateCopyBadge3D();
  deselectJoint3D();
  setTimeout(resizeBody3D, 0);
}
// "Close" — just leaves the fullscreen editor UI and goes back to the main
// page. Purely visual: it doesn't apply, save, or undo anything. Whatever's
// currently in manualJointEdits3D (edited-but-unsaved or already-saved,
// doesn't matter) stays exactly as it is until ⬆ Save actually pushes it.
function closeJointEditorMode3D() {
  closeJointEditorModeUI3D();
}
// Called right after a ⬆ Save succeeds. Cancel rolls back to "the state when the
// editor opened", so without this a pose you saved mid-session would be rolled
// back too. `cap` is what was captured at the moment Save was pressed.
function commitPoseToEditorSnapshot3D(poseKey, cap) {
  if (!jointEditorModeActive3D || !cap) return;
  const put = (obj, val) => { if (!obj) return; if (val) obj[poseKey] = val; else delete obj[poseKey]; };
  put(jointEditorModeSnapshot3D, cap.joints);
  put(jointEditorFacingSnapshot3D && jointEditorFacingSnapshot3D.map, cap.facing);
  put(jointEditorPinsSnapshot3D, cap.pins);
  put(jointEditorAttachSnapshot3D, cap.attach);
}
// Reverts every joint back to the snapshot taken when the editor opened,
// discarding anything changed (or mirrored) since — then closes the UI.
function cancelJointEditorMode3D() {
  // Pins and Attached-Wrist dots are part of an arm's pose too. They used to be
  // left as-is while the joint rotations were rolled back, so the two got out of
  // step and the arms came back twisted — put them back first, together.
  if (jointEditorPinsSnapshot3D) {
    wristPinLocked3D = {};
    applyWristPinsState3D(jointEditorPinsSnapshot3D);
  }
  if (jointEditorAttachSnapshot3D) applyWristAttachmentsState3D(jointEditorAttachSnapshot3D);
  if (jointEditorFacingSnapshot3D) {
    restoreHandWristAll3D(jointEditorFacingSnapshot3D);
    refreshHandWristButtons();
    applyPose3D(currentPose3D, { reframe: false });
  }
  if (jointEditorModeSnapshot3D) {
    manualJointEdits3D = jointEditorModeSnapshot3D;
    reapplyManualJointEdits3D();
    // Same reasoning as applySavedJointEdits3D in joint-github-sync.js:
    // restoring a snapshot can re-stamp a stale shoulderQuat/elbowQuat on
    // top of a leashed wrist's live reach-clamp — re-enforce it right after.
    if (typeof enforceWristPinConstraints3D === 'function') {
      enforceWristPinConstraints3D('left');
      enforceWristPinConstraints3D('right');
    }
    groundBody3D(false);
  }
  closeJointEditorModeUI3D();
}
// ---- Copy wrists (shoulder+elbow+wrist+hand-turn, and any wrist pin) from
// another pose ----
// Lets you pick any other pose from a dropdown and clone one or both arms
// from it onto the current pose — legs and spine are never touched. It
// works by briefly rendering the source pose with no manual edits/overrides,
// reading the shoulder/elbow/wrist/hand-turn groups' resulting local
// rotations (so IK-driven poses copy correctly too), then restoring the
// current pose and stamping those rotations in as manual joint edits.
// Shoulder is always included now — no "match elbow position" toggle — since
// a pinned side's shoulder/elbow position comes right back for free the
// moment its wrist pin (see below) is cloned too, and an unpinned side just
// needs the shoulder quat to actually land in the source's arm position.
// The source pose's wrist-pin state (pinned+leashed, pinned+no-leash, or
// unpinned) is cloned right alongside the quats, so a pinned arm actually
// reproduces on-screen instead of getting immediately overridden by
// whatever pin the CURRENT pose happened to have on that side. That makes
// it behave like any other editor drag: Cancel reverts it, Apply keeps it,
// and ⬆ Save persists it — it never saves anything by itself.
function populateCopyPoseSelect3D() {
  const sel = document.getElementById('jeCopyPoseSelect');
  if (!sel || typeof POSES3D === 'undefined') return;
  const prev = sel.value;
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = 'Choose a pose…';
  sel.appendChild(ph);
  const groups = {};
  const copyKeys = (typeof filteredPoseKeys3D === 'function') ? filteredPoseKeys3D('copy') : Object.keys(POSES3D);
  let copyShown = 0;
  copyKeys.forEach(key => {
    if (key === currentPose3D) return; // copying a pose onto itself is a no-op
    copyShown++;
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
  if (typeof updatePoseSearchCount3D === 'function') updatePoseSearchCount3D('copy', copyShown);
  if (copyShown === 0 && ph) ph.textContent = 'No poses match…';
}
function readPoseElbowWristQuats3D(poseKey) {
  // Render the source pose exactly the way it looks when you click it — its
  // own saved/dragged joint edits AND the Hand/Wrist Facing overrides
  // (Bend/Turn/Swing, elbow) that are showing — read the joint rotations,
  // then put everything back. The overrides used to be wiped for this read,
  // which is why a wrist whose rotation came from the Hand/Wrist panel (or
  // from a Mirror, which writes those same overrides) copied over as the
  // pose's plain un-rotated preset wrist.
  const savedPose = currentPose3D;
  const savedManual = cloneManualJointEdits3D(manualJointEdits3D);
  const out = { left: {}, right: {} };
  try {
    // Only the SOURCE pose's own joint edits should apply to this read.
    manualJointEdits3D = savedManual[poseKey] ? { [poseKey]: cloneManualJointEdits3D({ [poseKey]: savedManual[poseKey] })[poseKey] } : {};
    applyPose3D(poseKey, { reframe: false });
    // Fully settle any leash-pinned wrist on the source (its hand-aim is a
    // capped step per pass) so we copy where it really ends up.
    if (typeof enforceWristPinConstraintsConverge3D === 'function') enforceWristPinConstraintsConverge3D();
    ['left', 'right'].forEach(side => {
      const sh = rig3D[side + 'Shoulder'], e = rig3D[side + 'Elbow'], w = rig3D[side + 'Wrist'], t = rig3D[side + 'HandTurn'];
      out[side].shoulderQuat = sh ? sh.quaternion.clone() : null;
      out[side].elbowQuat = e ? e.quaternion.clone() : null;
      out[side].wristQuat = w ? w.quaternion.clone() : null;
      out[side].handTurnQuat = t ? t.quaternion.clone() : null;
      const hp = rig3D[side + 'Hip'], kn = rig3D[side + 'Knee'], an = rig3D[side + 'Ankle'];
      out[side].hipQuat = hp ? hp.quaternion.clone() : null;
      out[side].kneeQuat = kn ? kn.quaternion.clone() : null;
      out[side].ankleQuat = an ? an.quaternion.clone() : null;
    });
  } finally {
    manualJointEdits3D = savedManual;
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
  const armsEl = document.getElementById('jeCopyArms');
  const doArms = armsEl ? armsEl.checked : true;
  const doLegs = !!(document.getElementById('jeCopyLegs') || {}).checked;
  if (!doArms && !doLegs) { if (msg) msg.textContent = 'Tick Arms and/or Legs to copy.'; return; }
  if (msg) msg.textContent = '';
  const sides = (sideSel && sideSel.value === 'left') ? ['left']
              : (sideSel && sideSel.value === 'right') ? ['right'] : ['left', 'right'];
  const src = readPoseElbowWristQuats3D(sel.value);
  // Read-only peek at the source pose's wrist pins (create=false — a pose
  // that's never had a pin touched shouldn't get a spurious empty entry
  // created in wristPinLocked3D just from being browsed in this dropdown).
  const srcPins = (typeof wristPinsForPose3D === 'function') ? wristPinsForPose3D(sel.value, false) : { left: null, right: null };
  const srcAtts = (typeof wristAttachmentsForPose3D === 'function') ? wristAttachmentsForPose3D(sel.value, false) : { left: null, right: null };
  let anyPinned = false;
  // Source pose's Hand/Wrist Facing overrides (hand turn, wrist bend, swing,
  // elbow bend/lift). The forearm's red/blue colour and the thumb's edge are
  // derived from the hand-turn VALUE (see applyHandFlipVisuals3D), not from
  // the copied hand-turn quaternion — so without cloning these, a copied arm
  // keeps the target pose's own colour/thumb side (e.g. Feet Apart stayed red
  // while Arms Crossed, at 93°/98°, is blue). readPoseElbowWristQuats3D has
  // just visited the source pose, so handWristByPose3D[source] is up to date.
  const srcHW = handWristByPose3D[sel.value] || {};
  const hwField = (name, side) => (srcHW[name] && srcHW[name][side] !== undefined ? srcHW[name][side] : null);
  sides.forEach(side => {
    const je = jointEditsForPose3D(currentPose3D);
    if (doLegs) {
      // Legs: clone the source's hip/knee/ankle exactly as they look on that
      // pose (its own manual edits already included).
      ['hipQuat', 'kneeQuat', 'ankleQuat'].forEach(k => { if (src[side][k]) je[side][k] = src[side][k].clone(); });
    }
    if (!doArms) return; // legs-only copy: leave this side's arm, hand and pins untouched
    handRotationOverride[side] = hwField('hand', side);
    wristRotationOverride[side] = hwField('wrist', side);
    wristSwingOverride[side] = hwField('swing', side);
    elbowBendOverride[side] = hwField('elbowBend', side);
    elbowLiftOverride[side] = hwField('elbowLift', side);
    // Exact clone of that side's whole "wrist" — shoulder/elbow/wrist/
    // hand-turn rotation AND whatever wrist-pin state the source pose has
    // (leashed, plain position+rotation, or unpinned), always together. No
    // separate "match elbow position" step needed anymore: a pinned side's
    // on-screen shoulder/elbow is really driven by the pin's own frozen
    // sx/sy/sz/ex/ey/ez (see enforceWristPinConstraints3D), which rides
    // along for free the moment the pin itself is cloned below; for an
    // unpinned side the copied shoulderQuat/elbowQuat here is what actually
    // reproduces the source's arm position.
    if (src[side].shoulderQuat) je[side].shoulderQuat = src[side].shoulderQuat;
    if (src[side].elbowQuat) je[side].elbowQuat = src[side].elbowQuat;
    if (src[side].wristQuat) je[side].wristQuat = src[side].wristQuat;
    if (src[side].handTurnQuat) je[side].handTurnQuat = src[side].handTurnQuat;

    // Clone (not alias) the pin itself onto the current pose — including
    // clearing it to null when the source side has no pin, so "Copy"
    // always leaves this side in exactly the pinned/unpinned state the
    // source pose was in, rather than only ever adding a pin and never
    // removing one.
    // Attached wrist dot is per-pose too — clone the source's (or clear).
    const srcAtt = srcAtts[side];
    wristAttachmentsForPose3D(currentPose3D)[side] = srcAtt ? { ...srcAtt } : null;
    if (typeof wristPinsForPose3D === 'function') {
      const srcPin = srcPins[side];
      wristPinsForPose3D(currentPose3D)[side] = srcPin ? { ...srcPin } : null;
      if (srcPin && srcPin.r != null) anyPinned = true;
    }
  });
  // Re-render so the cloned hand/wrist overrides take effect (recomputes the
  // forearm colour + thumb edge and the wristTurn clamp/elbow lift); applyPose3D
  // re-stamps the manual joint edits on top, so the copied quats still win.
  applyPose3D(currentPose3D, { reframe: false });
  reapplyManualJointEdits3D();
  if (typeof refreshHandWristButtons === 'function') refreshHandWristButtons();
  // A freshly-copied leash needs its shoulder/elbow/wrist re-derived from
  // its own frozen numbers right away — same reasoning as a reload or a
  // mirror (see enforceWristPinConstraintsConverge3D in
  // joint-faces-panel.js) — rather than waiting for some unrelated event.
  if (anyPinned && typeof enforceWristPinConstraintsConverge3D === 'function') {
    enforceWristPinConstraintsConverge3D();
  }
  groundBody3D(false);
  if (typeof refreshWristAttachmentsForPoseChange3D === 'function') refreshWristAttachmentsForPoseChange3D();
  if (typeof syncWristPinReadout3D === 'function') syncWristPinReadout3D();
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  // Feedback: log it (drives the chip under the top bars), close the pop-up
  // so the result is visible, and flash a short confirmation. This never
  // saves anything on its own — same as before, it just stamps the copy in
  // as manual edits (+ pin state) that Cancel reverts and ⬆ Save persists.
  const srcLabel = POSES3D[sel.value].label || sel.value;
  const partNoun = doArms && doLegs ? 'arm + leg' : doArms ? 'arm' : 'leg';
  const sideWord = sides.length === 2 ? `both ${partNoun}s` : `${sides[0]} ${partNoun}`;
  const partsLabel = [doArms ? 'shoulder, elbow, wrist' + (anyPinned ? ' + pin' : '') : '', doLegs ? 'hip, knee, ankle' : ''].filter(Boolean).join(' + ');
  jointEditorCopyLog3D.push({ label: srcLabel, side: sideWord, parts: partsLabel });
  updateCopyBadge3D();
  closeCopyPopup3D();
  const status = document.getElementById('jeMirrorStatus');
  if (status) {
    status.textContent = `Copied ${sideWord} from "${srcLabel}"` + (anyPinned ? ' (incl. wrist pin)' : '');
    status.style.opacity = '1';
    clearTimeout(mirrorSelectedJoint3D._t);
    clearTimeout(copyElbowWristFromPose3D._t);
    copyElbowWristFromPose3D._t = setTimeout(() => { status.style.opacity = '0'; }, 2400);
  }
}

// ---- Reset: back to your last SAVED file ----
// Re-reads presets/pose-overrides.json (falling back to the copy loaded when
// the page opened if GitHub can't be reached) and restores the saved joint
// edits — dropping everything unsaved: drags, typed values and mirrors.
// Cancel/Apply still work afterwards.
async function resetAllJointEdits3D() {
  if (!confirm('Reset to your last saved file? Unsaved joint edits will be lost.')) return;
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

  applyPoseOverridesData3D(all);

  // Joint edits.
  clearAllHandWristPoses3D();
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
// elbow/wrist/hand-turn quaternions for the CURRENT pose only and re-saves
// that cleared state. manualJointEdits3D is keyed by pose (see
// jointEditsForPose3D above), so this can no longer affect any other pose —
// it used to have to be a global "clear everything" hammer back when a bad
// override could bleed onto every pose at once; that bleed is fixed now, so
// this is just a normal per-pose undo.
async function clearAllManualJointOverridesAndSave3D() {
  if (!confirm('Clear manual arm/wrist overrides (shoulder, elbow, wrist, hand turn) on both sides for the CURRENT pose and save that cleared state? This does not touch other poses.')) return;
  manualJointEdits3D[currentPose3D] = { left: blankJointEditsSide3D(), right: blankJointEditsSide3D() };
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
  if (typeof clearPoseSearch3D === 'function') clearPoseSearch3D('copy');
  if (typeof refreshPoseSetSelects3D === 'function') refreshPoseSetSelects3D();
  populateCopyPoseSelect3D();
  const msg = document.getElementById('jeCopyMsg'); if (msg) msg.textContent = '';
  // Always open with the same defaults (Arms ticked, Legs not) so a tap never flips a stale state.
  const cbA = document.getElementById('jeCopyArms'), cbL = document.getElementById('jeCopyLegs');
  if (cbA) cbA.checked = true;
  if (cbL) cbL.checked = false;
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
  if (!log.length) { clearTimeout(updateCopyBadge3D._t); badge.style.display = 'none'; badge.textContent = ''; badge.title = ''; return; }
  const last = log[log.length - 1];
  badge.textContent = `✓ Copied from ${last.label}` + (log.length > 1 ? ` (+${log.length - 1} more)` : '');
  badge.title = log.map(e => `${e.label} — ${e.side}: ${e.parts}`).join('\n');
  badge.style.display = 'block';
  // The chip is only a confirmation — hide it after a few seconds (the Copy
  // poses button stays marked as used, and the log is kept for its tooltip),
  // or immediately when tapped.
  badge.onclick = () => { badge.style.display = 'none'; };
  clearTimeout(updateCopyBadge3D._t);
  updateCopyBadge3D._t = setTimeout(() => { badge.style.display = 'none'; }, 3500);
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



// ---- Current-pose label + Switch Pose pop-up ----
function updatePoseNameLabel3D() {
  const el = document.getElementById('jePoseName');
  if (!el || typeof POSES3D === 'undefined') return;
  const pose = POSES3D[currentPose3D];
  el.textContent = pose ? (pose.label || currentPose3D) : currentPose3D;
}
// Rebuilds the Switch Pose list, honouring the search box + set filter.
function renderPosePopupList3D() {
  const list = document.getElementById('jePoseList');
  if (!list || typeof POSES3D === 'undefined') return;
  list.innerHTML = '';
  let lastSec = null;
  const keys = (typeof filteredPoseKeys3D === 'function') ? filteredPoseKeys3D('popup') : Object.keys(POSES3D);
  keys.forEach(key => {
    const pose = POSES3D[key];
    const sec = pose.section || 'Other';
    if (sec !== lastSec) {
      const h = document.createElement('div');
      h.className = 'jep-section'; h.textContent = sec;
      list.appendChild(h);
      lastSec = sec;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jep-item' + (key === currentPose3D ? ' active' : '');
    b.textContent = pose.label || key;
    b.onclick = () => switchEditorPose3D(key);
    list.appendChild(b);
  });
  if (!keys.length) {
    const h = document.createElement('div');
    h.className = 'jep-section'; h.textContent = 'No poses match.';
    list.appendChild(h);
  }
  if (typeof updatePoseSearchCount3D === 'function') updatePoseSearchCount3D('popup', keys.length);
}
function openPosePopup3D() {
  const popup = document.getElementById('jePosePopup');
  const list = document.getElementById('jePoseList');
  if (!popup || !list || typeof POSES3D === 'undefined') return;
  if (typeof clearPoseSearch3D === 'function') clearPoseSearch3D('popup'); // fresh search each time (the set filter is remembered)
  if (typeof refreshPoseSetSelects3D === 'function') refreshPoseSetSelects3D();
  renderPosePopupList3D();
  popup.classList.add('open');
  const active = list.querySelector('.jep-item.active');
  if (active) active.scrollIntoView({ block: 'center' });
}
function closePosePopup3D() {
  const popup = document.getElementById('jePosePopup');
  if (popup) popup.classList.remove('open');
}
// Switches the pose being edited without leaving the 3D editor. Goes through
// the exact same setPose3D() the Poses panel buttons use (so per-pose joint
// edits, hand/wrist overrides, pins and attachments all swap in), then
// refreshes the editor's own pose-dependent UI.
// True when the pose on screen has edits that aren't in the last save.
function isPoseUnsaved3D(poseKey) {
  try {
    const st = poseSaveStatus3D(poseKey);
    if (st === 'dirty') return true;
    if (st === 'nosave') return poseLiveSaveState3D(poseKey) !== undefined; // never saved, but has edits
  } catch (e) {}
  return false; // 'latest', or save status unknown (e.g. GitHub unreachable)
}
function openUnsavedPoseConfirm3D(targetKey) {
  pendingPoseSwitch3D = targetKey;
  const pose = POSES3D[currentPose3D];
  const nameEl = document.getElementById('jeUnsavedPoseName');
  if (nameEl) nameEl.textContent = pose ? (pose.label || currentPose3D) : currentPose3D;
  const pop = document.getElementById('jeUnsavedPoseConfirm');
  if (pop) pop.classList.add('open');
}
function closeUnsavedPoseConfirm3D() {
  const pop = document.getElementById('jeUnsavedPoseConfirm');
  if (pop) pop.classList.remove('open');
}
// YES: stay on this pose so it can be saved.
function unsavedPoseConfirmYes3D() {
  pendingPoseSwitch3D = null;
  closeUnsavedPoseConfirm3D();
}
// NO: carry on to the pose that was asked for.
function unsavedPoseConfirmNo3D() {
  const target = pendingPoseSwitch3D;
  pendingPoseSwitch3D = null;
  closeUnsavedPoseConfirm3D();
  if (target) switchEditorPose3D(target, { skipSavePrompt: true });
}
function switchEditorPose3D(poseKey, { skipSavePrompt = false } = {}) {
  closePosePopup3D();
  if (!POSES3D[poseKey] || poseKey === currentPose3D) return;
  if (!skipSavePrompt && isPoseUnsaved3D(currentPose3D)) { openUnsavedPoseConfirm3D(poseKey); return; }
  setPose3D(poseKey);
  if (typeof refreshHandWristButtons === 'function') refreshHandWristButtons();
  jointEditorCopyLog3D = [];
  updateCopyBadge3D();
  populateCopyPoseSelect3D();
  updatePoseNameLabel3D();
  if (jointEditorCameraView3D !== 'free') setJointEditorCameraView3D(jointEditorCameraView3D);
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
}

// Previous/next pose, in the same order as the Switch pose list (wraps around).
function cycleEditorPose3D(step) {
  if (typeof POSES3D === 'undefined') return;
  const keys = Object.keys(POSES3D);
  if (!keys.length) return;
  let i = keys.indexOf(currentPose3D);
  if (i < 0) i = 0;
  const next = keys[(i + step + keys.length) % keys.length];
  switchEditorPose3D(next);
}

// ---- Snap rotations (Quick Options) ----
const SNAP_ROTATION_DEG_3D = 15;
function applySnapRotations3D() {
  if (!transformControls3D) return;
  transformControls3D.setRotationSnap(snapRotations3D ? deg2rad(SNAP_ROTATION_DEG_3D) : null);
}
function toggleSnapRotations3D() {
  snapRotations3D = !snapRotations3D;
  applySnapRotations3D();
  refreshQuickOptions3D();
  showJointEditorHint3D(snapRotations3D ? 'Snap rotations ON (' + SNAP_ROTATION_DEG_3D + '°)' : 'Snap rotations OFF');
}
function snapDeg3D(v) {
  return snapRotations3D ? Math.round(v / SNAP_ROTATION_DEG_3D) * SNAP_ROTATION_DEG_3D : v;
}

// ---- Level arm (Quick Options) ----
// Moves the chosen elbow(s)/wrist(s) so their spine-local X / Y / Z (the same
// numbers the Position fields show) match the reference joint's. Bones can't
// stretch, so each joint slides along the sphere its bone length allows
// (shoulder->elbow for an elbow, elbow->wrist for a wrist) to the point that
// has the requested coordinate(s) and is closest to where it already is.
const LEVEL_JOINTS_3D = {
  'left-elbow':  { side: 'left',  type: 'elbow', label: 'L Elbow' },
  'right-elbow': { side: 'right', type: 'elbow', label: 'R Elbow' },
  'left-wrist':  { side: 'left',  type: 'wrist', label: 'L Wrist' },
  'right-wrist': { side: 'right', type: 'wrist', label: 'R Wrist' },
};
let levelSel3D = { joints: new Set(), ref: null, axes: { x: false, y: false, z: false } };
function refreshLevelPopup3D() {
  document.querySelectorAll('#jeLevelPopup [data-lvjoint]').forEach(b => b.classList.toggle('active', levelSel3D.joints.has(b.dataset.lvjoint)));
  document.querySelectorAll('#jeLevelPopup [data-lvref]').forEach(b => b.classList.toggle('active', levelSel3D.ref === b.dataset.lvref));
  document.querySelectorAll('#jeLevelPopup [data-lvaxis]').forEach(b => b.classList.toggle('active', !!levelSel3D.axes[b.dataset.lvaxis]));
}
function openLevelPopup3D() {
  toggleQuickOptions3D(false);
  const popup = document.getElementById('jeLevelPopup'); if (!popup) return;
  const msg = document.getElementById('jeLevelMsg'); if (msg) msg.textContent = '';
  refreshLevelPopup3D();
  popup.classList.add('open');
}
function closeLevelPopup3D() {
  const popup = document.getElementById('jeLevelPopup');
  if (popup) popup.classList.remove('open');
}
function toggleLevelJoint3D(id) {
  if (levelSel3D.joints.has(id)) levelSel3D.joints.delete(id); else levelSel3D.joints.add(id);
  const msg = document.getElementById('jeLevelMsg'); if (msg) msg.textContent = '';
  refreshLevelPopup3D();
}
function setLevelRef3D(id) {
  levelSel3D.ref = (levelSel3D.ref === id) ? null : id;
  const msg = document.getElementById('jeLevelMsg'); if (msg) msg.textContent = '';
  refreshLevelPopup3D();
}
function toggleLevelAxis3D(a) {
  levelSel3D.axes[a] = !levelSel3D.axes[a];
  const msg = document.getElementById('jeLevelMsg'); if (msg) msg.textContent = '';
  refreshLevelPopup3D();
}
function levelSpineLocalPos3D(grp) {
  rig3D.spine.updateMatrixWorld(true);
  const w = new THREE.Vector3(); grp.getWorldPosition(w);
  return rig3D.spine.worldToLocal(w);
}
// Point on the sphere (centre P, radius L) that has the requested coordinates
// (axes -> values in ref) and is nearest to C. When the request can't be met
// exactly (bone too short) it just aims as close as the bone allows.
function levelTargetLocal3D(P, C, axes, ref) {
  const L = C.distanceTo(P);
  const Q = C.clone();
  axes.forEach(a => { Q[a] = ref[a]; });
  const unit = a => { const v = new THREE.Vector3(); v[a] = 1; return v; };
  if (axes.length === 1) {
    const a = axes[0];
    const d = ref[a] - P[a];
    if (Math.abs(d) >= L) return P.clone().addScaledVector(unit(a), Math.sign(d) * L);
    const v = C.clone().sub(P); v[a] = 0;
    if (v.lengthSq() < 1e-8) { const o = ['x', 'y', 'z'].find(k => k !== a); v[o] = 1; }
    return P.clone().addScaledVector(unit(a), d).addScaledVector(v.normalize(), Math.sqrt(L * L - d * d));
  }
  if (axes.length === 2) {
    const b = ['x', 'y', 'z'].find(k => !axes.includes(k));
    const d1 = ref[axes[0]] - P[axes[0]], d2 = ref[axes[1]] - P[axes[1]];
    const rem = L * L - d1 * d1 - d2 * d2;
    if (rem >= 0) {
      const s = Math.sqrt(rem);
      const sb = (Math.abs(P[b] + s - C[b]) <= Math.abs(P[b] - s - C[b])) ? s : -s;
      Q[b] = P[b] + sb;
    }
  }
  return Q; // 3 axes, or unreachable 2-axis case: aim toward this point
}
function applyLevelArm3D() {
  const msg = document.getElementById('jeLevelMsg');
  const say = t => { if (msg) msg.textContent = t; };
  const axes = ['x', 'y', 'z'].filter(a => levelSel3D.axes[a]);
  if (!levelSel3D.joints.size) return say('Choose at least one joint.');
  if (!levelSel3D.ref) return say('Choose a reference joint.');
  if (!axes.length) return say('Choose Level X, Y and/or Z.');
  if (!rig3D || !rig3D.spine) return say('Model not ready.');
  const refDef = LEVEL_JOINTS_3D[levelSel3D.ref];
  const refGrp = rig3D[refDef.side + (refDef.type === 'elbow' ? 'Elbow' : 'Wrist')];
  if (!refGrp) return say('Reference joint not found.');
  const todo = [...levelSel3D.joints].filter(id => id !== levelSel3D.ref).map(id => ({ id, ...LEVEL_JOINTS_3D[id] }));
  if (!todo.length) return say('Pick a joint other than the reference.');
  // Elbows first: moving an elbow carries its wrist along, so wrists are measured afterwards.
  todo.sort((a, b) => (a.type === 'elbow' ? 0 : 1) - (b.type === 'elbow' ? 0 : 1));
  const refPos = levelSpineLocalPos3D(refGrp); // frozen at Apply time
  let partial = 0, done = 0;
  todo.forEach(j => {
    const boneGrp  = j.type === 'elbow' ? rig3D[j.side + 'Shoulder'] : rig3D[j.side + 'Elbow'];
    const childGrp = j.type === 'elbow' ? rig3D[j.side + 'Elbow']    : rig3D[j.side + 'Wrist'];
    if (!boneGrp || !childGrp) return;
    const P = levelSpineLocalPos3D(boneGrp), C = levelSpineLocalPos3D(childGrp);
    const Q = levelTargetLocal3D(P, C, axes, refPos);
    const targetWorld = rig3D.spine.localToWorld(Q.clone());
    const q = aimBoneKeepTwist3D(boneGrp, childGrp, targetWorld);
    jointEditsForPose3D(currentPose3D)[j.side][j.type === 'elbow' ? 'shoulderQuat' : 'elbowQuat'] = q;
    reapplyManualJointEdits3D();
    if (j.type === 'elbow' && typeof refreshWristPinElbow3D === 'function') refreshWristPinElbow3D(j.side);
    const after = levelSpineLocalPos3D(childGrp);
    if (axes.some(a => Math.abs(after[a] - refPos[a]) > 0.3)) partial++;
    done++;
  });
  groundBody3D(false);
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  closeLevelPopup3D();
  showJointEditorHint3D(partial
    ? `Leveled ${done} joint(s) — ${partial} couldn't fully reach (arm length)`
    : `Leveled ${done} joint(s) to ${refDef.label} ${axes.map(a => a.toUpperCase()).join('')}`);
}
