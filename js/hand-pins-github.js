// ── hand-pins-github.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. Pinned Mesh / Pinned Face Part dropdowns, the hand-pin commit/unpin flow, the Default Setter (captureHandDefaultFromCurrent3D + pinDefaults3D — see the drift-fix comment on captureHandDefaultFromCurrent3D), and the GitHub read/write plumbing for pose-overrides.json (pulls, pushes, and the Save-panel button).
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

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
  // Stage this hand's current position+rotation as its new Default Setter
  // data for this session (see captureHandDefaultFromCurrent3D) — nothing
  // is saved to GitHub here; ⬆ Save is what confirms it.
  captureHandDefaultFromCurrent3D(side);
  setPinSaveStatus3D(`Pinned ${side} hand to ${describePin3D(pose[side].handTarget)} — click Save to confirm.`);
  updateJePinStatus3D();
  applyPose3D(currentPose3D, { reframe: false });
}
// Clears a hand's pin — it goes back to tracking the Default Setter's saved
// wrist position (or the legacy fixed-angle path if no default is captured
// yet). Renamed from the old unpinHandWrist (kept as a thin alias below for
// anything still calling the old name/signature). Session-only like the pin
// itself — click ⬆ Save to confirm the unpin.
function unpinHandWrist3D(side) {
  const pose = POSES3D[currentPose3D];
  if (!pose || !pose[side] || pose[side].handTarget === undefined) return;
  delete pose[side].handTarget;
  jointEditorPinDirty3D[side] = true;
  setPinSaveStatus3D(`Unpinned ${side} hand — click Save to confirm.`);
  updateJePinStatus3D();
  applyPose3D(currentPose3D, { reframe: false });
}

// ---- Default Setter ----
// { left: {shoulder:{x,y,z}, elbow:{x,y,z}, wrist:{x,y,z}, rot:{be,tu,sw}},
//   right: {...} } — every side's pin/elbow math is relative to whatever's
// captured here (see resolveHandAbsolutePos3D/resolveElbowTargetPos3D
// below), and `rot` (the hand's own Bend/Turn/Swing) is what a "Reset L/R
// WRIST" reverts the hand's facing to.
//
// No manual capture step anymore: captureHandDefaultFromCurrent3D() runs
// automatically the instant a wrist gets pinned (see commitHandPin3D),
// staging the hand's current position+rotation as this side's new default
// for THIS SESSION ONLY (pinDefaultsDirty3D marks it unsaved). Nothing is
// pushed to GitHub until the editor's ⬆ Save is pressed
// (quickSaveJointsToGitHub3D), which is what actually confirms it as the
// default for the pose being worked on — see PIN_DEFAULTS_KEY below.
let pinDefaults3D = { left: null, right: null };
let pinDefaultsDirty3D = { left: false, right: false };
function jointWorldPosSpineLocal3D(side, jointName) {
  const grp = rig3D[side + jointName];
  if (!grp || !rig3D.spine) return null;
  rig3D.spine.updateMatrixWorld(true);
  const w = new THREE.Vector3();
  grp.getWorldPosition(w);
  const p = rig3D.spine.worldToLocal(w);
  return { x: round2(p.x), y: round2(p.y), z: round2(p.z) };
}
// Stages the CURRENT rig's wrist/elbow/shoulder positions plus the wrist's
// current Bend/Turn/Swing as one side's new Default Setter data — session
// only, not yet pushed anywhere (see the block comment above). Called from
// commitHandPin3D the moment a pin is set.
//
// IMPORTANT (fixes the "Update keeps moving the elbow/wrist" drift bug):
// when the hand is PINNED, def.wrist must be the exact LITERAL pin target
// (resolveHandAbsolutePos3D) — never the wrist joint's actual rendered
// world position. Those two numbers only match when the rigid two-bone
// chain can reach the pin exactly; whenever it can't (or floating-point/
// rounding leaves the rendered joint a hair off), resolveElbowTargetPos3D's
// `wristAbsPos - def.wrist` is nonzero even though nothing moved, which
// nudges the elbow every render. Capturing THAT nudged elbow as the new
// default (which is what clicking Update did before) bakes the nudge in
// and produces a fresh, slightly-different nudge the next time — so each
// click chases a new position instead of settling. Defining def.wrist as
// the literal target makes that delta exactly zero by construction for a
// pinned hand, so Update becomes idempotent: click it twice in a row with
// nothing else changed and you get the same numbers both times.
function captureHandDefaultFromCurrent3D(side) {
  const pose = POSES3D[currentPose3D];
  const ht = pose && pose[side] && pose[side].handTarget;
  const shoulder = jointWorldPosSpineLocal3D(side, 'Shoulder');
  const elbow = jointWorldPosSpineLocal3D(side, 'Elbow');
  let wrist;
  if (ht && ht.mesh && ht.offset) {
    const target = resolveHandAbsolutePos3D(side, pose);
    wrist = target ? { x: round2(target.x), y: round2(target.y), z: round2(target.z) } : null;
  } else {
    wrist = jointWorldPosSpineLocal3D(side, 'Wrist');
  }
  if (!shoulder || !elbow || !wrist) return;
  const res = lastPoseResolved3D && lastPoseResolved3D[side];
  const prevRot = pinDefaults3D[side] && pinDefaults3D[side].rot;
  pinDefaults3D[side] = {
    shoulder, elbow, wrist,
    rot: res ? { be: round1(res.wrist), tu: round1(res.wristTurn), sw: round1(res.swing || 0) } : (prevRot || { be: 0, tu: 0, sw: 0 }),
  };
  pinDefaultsDirty3D[side] = true;
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

  // Default Data drawer (read-only) + the single Reset L/R WRIST button.
  const def = pinDefaults3D[side];
  const setVal = (id, v) => { const e = document.getElementById(id); if (e) e.value = (v === undefined || v === null) ? '—' : v; };
  setVal('jeDefX', def && def.wrist ? def.wrist.x : null);
  setVal('jeDefY', def && def.wrist ? def.wrist.y : null);
  setVal('jeDefZ', def && def.wrist ? def.wrist.z : null);
  setVal('jeDefBe', def && def.rot ? def.rot.be : null);
  setVal('jeDefTu', def && def.rot ? def.rot.tu : null);
  setVal('jeDefSw', def && def.rot ? def.rot.sw : null);
  const resetBtn = document.getElementById('jeResetHandDefaultBtn');
  if (resetBtn) {
    resetBtn.textContent = `↺ Reset ${side === 'left' ? 'L' : 'R'} WRIST`;
    resetBtn.disabled = !(def && def.wrist);
  }
  const updateBtn = document.getElementById('jeUpdateHandDefaultBtn');
  if (updateBtn) updateBtn.textContent = `⇧ Update ${side === 'left' ? 'L' : 'R'} WRIST`;
}
// Resets one wrist to its saved Default Setter data: unpins it (position
// then tracks the default wrist position automatically, the same fallback
// resolveHandAbsolutePos3D already uses when nothing is pinned) and puts
// its Bend/Turn/Swing back to the captured default's own rot values —
// distinct from the pose's own authored rotation, which is what "Pose
// default" on the Hand Facing dropdowns above still means. Only ⬆ Save
// confirms this back to GitHub, like every other wrist change.
function resetHandToDefault3D(side) {
  if (side !== 'left' && side !== 'right') return;
  const def = pinDefaults3D[side];
  if (!def || !def.wrist) { alert('No Default Setter data saved yet for this hand — pin it and hit Save first.'); return; }
  const pose = POSES3D[currentPose3D];
  if (pose && pose[side] && pose[side].handTarget !== undefined) {
    snapshotPinsForCancel3D();
    delete pose[side].handTarget;
    jointEditorPinDirty3D[side] = true;
  }
  const je = jointEditsForPose3D(currentPose3D);
  je[side].shoulderQuat = null;
  je[side].elbowQuat = null;
  je[side].wristQuat = null;
  if (def.rot) {
    wristRotationOverride[side] = clampWristBend(def.rot.be);
    handRotationOverride[side] = clampTurnFree(def.rot.tu);
    wristSwingOverride[side] = clampWristSwing(def.rot.sw);
  } else {
    wristRotationOverride[side] = 'default';
    handRotationOverride[side] = 'default';
    wristSwingOverride[side] = 'default';
  }
  refreshHandWristButtons();
  applyPose3D(currentPose3D, { reframe: false });
  reapplyManualJointEdits3D();
  groundBody3D(false);
  if (selectedJoint3D && selectedJoint3D.side === side) { attachGizmoToSelection3D(); updateJointPanelValues3D(); }
  updateJePinStatus3D();
  setPinSaveStatus3D(`${side === 'left' ? 'L' : 'R'} wrist reset to default — click Save to confirm.`);
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

