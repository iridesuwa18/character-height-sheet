// ── joint-panel-sliders.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Wrist Bend/Turn/Swing slider overlay, TransformControls gizmo attach/drag handling, and the Joint Editor's numeric position/rotation panel.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

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
    <div class="ws-note" id="wsNote3D"></div>`;
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
  // Bend/Turn/Swing are always the pose's own authored hand-facing numbers —
  // nothing pin-specific left to explain here.
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
  jointEditsForPose3D(currentPose3D)[side].handTurnQuat = null;
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
      jointEditsForPose3D(currentPose3D)[side].handTurnQuat = null;
      const turn = handRotationOverride[side];
      grp.rotation.set(deg2rad(wristRotationOverride[side]), 0, 0);
      if (rig3D[side + 'HandTurn']) rig3D[side + 'HandTurn'].rotation.y = deg2rad(turn * sgn);
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
// next time a pose/slider/hand-facing change runs applyPose3D again. Also
// called directly by the drag/typed-input handlers themselves for
// immediate visual feedback while editing.
function reapplyManualJointEdits3D() {
  const je = jointEditsForPose3D(currentPose3D, false);
  ['left', 'right'].forEach(side => {
    const m = je[side];
    if (m.shoulderQuat && rig3D[side + 'Shoulder']) rig3D[side + 'Shoulder'].quaternion.copy(m.shoulderQuat);
    if (m.elbowQuat && rig3D[side + 'Elbow'])       rig3D[side + 'Elbow'].quaternion.copy(m.elbowQuat);
    if (m.wristQuat && rig3D[side + 'Wrist'])       rig3D[side + 'Wrist'].quaternion.copy(m.wristQuat);
    if (m.handTurnQuat && rig3D[side + 'HandTurn']) rig3D[side + 'HandTurn'].quaternion.copy(m.handTurnQuat);
  });
}

function resetSelectedJoint3D() {
  if (!selectedJoint3D) return;
  const { side, jointType } = selectedJoint3D;
  const je = jointEditsForPose3D(currentPose3D);
  if (jointType === 'elbow') { je[side].shoulderQuat = null; je[side].elbowQuat = null; }
  else { je[side].wristQuat = null; je[side].handTurnQuat = null; }
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
  // Spine-local (NOT bodyGroup3D/pelvis) — the two frames only coincide when
  // the spine has zero bend/twist/lean; any spine rotation rotates+offsets
  // one relative to the other. See updateJointPanelValues3D for the matching
  // read side of this.
  if (!grp || !rig3D.spine) return;
  rig3D.spine.updateMatrixWorld(true);
  const world = new THREE.Vector3(); grp.getWorldPosition(world);
  const local = rig3D.spine.worldToLocal(world.clone());
  local[axis] = n;
  const targetWorld = rig3D.spine.localToWorld(local.clone());
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
// they set the same per-side overrides the dropdowns use (clamped). Any old
// free-form wrist rotation is dropped.
function setWristNumbers3D(side, axis, n) {
  if (axis === 'x') wristRotationOverride[side] = clampWristBend(n);
  else if (axis === 'z') wristSwingOverride[side] = clampWristSwing(n);
  else handRotationOverride[side] = clampTurnFree(n);
  jointEditsForPose3D(currentPose3D)[side].wristQuat = null;
  jointEditsForPose3D(currentPose3D)[side].handTurnQuat = null;
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
  // Spine-local, matching onJointPosInput's own frame (see the comment
  // there) — the panel's numbers always agree with whatever's on screen,
  // whatever the spine is doing.
  if (!grp || !rig3D.spine) return;
  rig3D.spine.updateMatrixWorld(true);
  const world = new THREE.Vector3(); grp.getWorldPosition(world);
  const local = rig3D.spine.worldToLocal(world.clone());
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
  // Keep the Hand Facing / Wrist dropdowns showing what's actually active.
  const hSel = document.getElementById('jeHandFacingSel'), wSel = document.getElementById('jeWristFacingSel');
  // Show the ACTUAL resolved degrees as a word (0° -> Front etc.), so the
  // dropdowns stay in sync with the numbers whether they came from an
  // override, the pose, or a saved edit. Off-preset values show "Custom (n°)".
  const res = lastPoseResolved3D && lastPoseResolved3D[side];
  const syncSel = (sel, deg, table) => {
    if (!sel) return;
    const old = sel.querySelector('option[data-custom]'); if (old) old.remove();
    // The actual resolved angle either way (override, pose, or saved edit) —
    // match it against the preset table.
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

