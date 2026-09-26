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
const BLANK_JOINT_EDITS_3D = Object.freeze({ shoulderQuat: null, elbowQuat: null, wristQuat: null, handTurnQuat: null });
// Looks up the edit bucket for one pose. create=true (the default) lazily
// makes one if it doesn't exist yet — use for anything that's about to WRITE
// into it. Pass create=false for read-only lookups (e.g. reapply) so merely
// looking at a pose doesn't leave a permanent blank entry behind for it.
function jointEditsForPose3D(poseName, create = true) {
  if (!manualJointEdits3D[poseName]) {
    if (!create) return { left: BLANK_JOINT_EDITS_3D, right: BLANK_JOINT_EDITS_3D };
    manualJointEdits3D[poseName] = {
      left:  { shoulderQuat: null, elbowQuat: null, wristQuat: null, handTurnQuat: null },
      right: { shoulderQuat: null, elbowQuat: null, wristQuat: null, handTurnQuat: null },
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
      left:  { shoulderQuat: c(s.left.shoulderQuat),  elbowQuat: c(s.left.elbowQuat),  wristQuat: c(s.left.wristQuat),  handTurnQuat: c(s.left.handTurnQuat) },
      right: { shoulderQuat: c(s.right.shoulderQuat), elbowQuat: c(s.right.elbowQuat), wristQuat: c(s.right.wristQuat), handTurnQuat: c(s.right.handTurnQuat) },
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
  jointSettingsPopupOpen3D = false;
  const preview = document.getElementById('preview3D');
  if (preview) preview.classList.remove('je-fullscreen');
  document.body.classList.remove('je-fullscreen-active');
  const entry = document.getElementById('jointEditorEntryBar'); if (entry) entry.style.display = '';
  const topBar = document.getElementById('jointEditorTopBar'); if (topBar) topBar.style.display = 'none';
  const toggleBar = document.getElementById('jointToggleBar'); if (toggleBar) toggleBar.style.display = 'none';
  const bottomBar = document.getElementById('jointEditorBottomBar'); if (bottomBar) bottomBar.style.display = 'none';
  const copyBar = document.getElementById('jeCopyBar'); if (copyBar) copyBar.style.display = 'none';
  closeCopyPopup3D();
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
// Reverts every joint back to the snapshot taken when the editor opened,
// discarding anything changed (or mirrored) since — then closes the UI.
function cancelJointEditorMode3D() {
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
// joint edits. Shoulders are only copied if "Match elbow position" is
// ticked. That makes it behave like any other editor drag: Cancel
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
      const sh = rig3D[side + 'Shoulder'], e = rig3D[side + 'Elbow'], w = rig3D[side + 'Wrist'], t = rig3D[side + 'HandTurn'];
      out[side].shoulderQuat = sh ? sh.quaternion.clone() : null;
      out[side].elbowQuat = e ? e.quaternion.clone() : null;
      out[side].wristQuat = w ? w.quaternion.clone() : null;
      out[side].handTurnQuat = t ? t.quaternion.clone() : null;
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
  sides.forEach(side => {
    // Optional: also copy the shoulder's aim so the elbow lands in the same
    // place as in the source pose (elbow position comes from the shoulder).
    const je = jointEditsForPose3D(currentPose3D);
    if (matchElbowPos && src[side].shoulderQuat) je[side].shoulderQuat = src[side].shoulderQuat;
    if (src[side].elbowQuat) je[side].elbowQuat = src[side].elbowQuat;
    if (src[side].wristQuat) je[side].wristQuat = src[side].wristQuat;
    if (src[side].handTurnQuat) je[side].handTurnQuat = src[side].handTurnQuat;
  });
  reapplyManualJointEdits3D();
  groundBody3D(false);
  if (selectedJoint3D) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  // Feedback: log it (drives the chip under the top bars), close the pop-up
  // so the result is visible, and flash a short confirmation.
  const srcLabel = POSES3D[sel.value].label || sel.value;
  const sideWord = sides.length === 2 ? 'both arms' : (sides[0] === 'left' ? 'left arm' : 'right arm');
  const parts = ['elbow', 'wrist'];
  if (matchElbowPos) parts.push('shoulder');
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
// elbow/wrist/hand-turn quaternions for the CURRENT pose only and re-saves
// that cleared state. manualJointEdits3D is keyed by pose (see
// jointEditsForPose3D above), so this can no longer affect any other pose —
// it used to have to be a global "clear everything" hammer back when a bad
// override could bleed onto every pose at once; that bleed is fixed now, so
// this is just a normal per-pose undo.
async function clearAllManualJointOverridesAndSave3D() {
  if (!confirm('Clear manual arm/wrist overrides (shoulder, elbow, wrist, hand turn) on both sides for the CURRENT pose and save that cleared state? This does not touch other poses.')) return;
  manualJointEdits3D[currentPose3D] = {
    left:  { shoulderQuat: null, elbowQuat: null, wristQuat: null, handTurnQuat: null },
    right: { shoulderQuat: null, elbowQuat: null, wristQuat: null, handTurnQuat: null },
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

