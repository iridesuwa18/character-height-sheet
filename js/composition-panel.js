// ─────────────────────────────────────────────────────────────────────────────
// Composition maker (3D Editor → icon button under Faces).
//
// Frames the posed 3D model inside a fixed-aspect "canvas" (default A4) using
// a set of options: canvas size, 2D canvas rotation, fit-to-canvas, body-part
// aim (1–2 parts), zoom, pan and model rotation. Generate applies the draft
// settings; Randomise rolls every UNLOCKED option and then generates.
//
// How it works (nothing in the body/pose code is touched):
//  • The scene is rendered only inside a letterboxed frame (scissor + viewport)
//    with camera.aspect = canvas breadth / canvas height. hook: compositionRender3D()
//    is called from animate3D() in body-scene.js, which also skips
//    controls3D.update() while composition is open (OrbitControls would undo roll).
//  • "Model rotation" X/Y/Z is done as the equivalent camera orbit around the
//    framed area (Euler order YXZ: Y = turn, X = tilt, Z = lean). The model
//    never moves, so grounding, pins and joint edits are untouched.
//  • "Canvas rotation" is a roll of the camera about its view axis, i.e. the
//    model rotates in 2D inside the canvas (positive = clockwise).
//  • Framing is solved from the REAL posed geometry every time (after the pose
//    is applied, rotation is applied, roll is applied): the points of the
//    chosen body parts (or the whole body) are projected and the camera
//    distance + shift are solved so they fill the canvas with a small margin.
//    That is why it keeps working for any pose (standing, squatting, lying…).
//  • Zoom: 0% = the fitted framing; +N% dollies the camera closer (÷ 1+N/100).
//  • Pan: moves the view across the framed area (aim region, or the full body
//    if no aim). Travel grows with zoom: none at 0%, the whole region by ~100%.
//  • Presets: Save/Load a named .json (all options + locks) in presets/composition on GitHub, like Height/Faces.
//  • Closing keeps whatever pose Randomise Pose picked (it is a real pose
//    change, not just a preview). The editor camera is restored if the pose
//    did not change, otherwise re-framed to the new pose like a normal pose pick.
// ─────────────────────────────────────────────────────────────────────────────

const COMP_MARGIN_3D = 0.06; // empty border kept around the framed area (fraction of the canvas)
const COMP_EULER_ORDER_3D = 'YXZ'; // model rotation order: Y turn, then X tilt, then Z lean

const COMP_SIZE_PRESETS_3D = [
  { id: 'a4p',  label: 'A4 portrait',  h: 3508, b: 2480 },
  { id: 'a4l',  label: 'A4 landscape', h: 2480, b: 3508 },
  { id: 'sq',   label: 'Square 1:1',   h: 2048, b: 2048 },
  { id: 'p45',  label: 'Portrait 4:5', h: 2560, b: 2048 },
  { id: 'wide', label: 'Wide 16:9',    h: 1080, b: 1920 },
  { id: 'tall', label: 'Tall 9:16',    h: 1920, b: 1080 },
];

// Body-part aim options. Order is head → toe.
const COMP_AIM_PARTS_3D = [
  { id: 'head',      label: 'Head' },
  { id: 'neck',      label: 'Neck' },
  { id: 'shoulder',  label: 'Shoulder' },
  { id: 'upperarm',  label: 'Upperarm' },
  { id: 'lowerarm',  label: 'Lowerarm' },
  { id: 'wrist',     label: 'Wrist' },
  { id: 'handbot',   label: 'Bottom Face of Hand' },
  { id: 'waistline', label: 'Waistline' },
  { id: 'hip',       label: 'Hip' },
  { id: 'butt',      label: 'Butt' },
  { id: 'knee',      label: 'Knee' },
  { id: 'footbot',   label: 'Bottom of Foot' },
  { id: 'footfront', label: 'Front of Foot' },
];

let compActive3D = false;
let compUIBuilt3D = false;
let compCollapsed3D = false;
let compPoseChanged3D = false;
let compSaved3D = null;      // editor camera saved while composition is open
let compApplied3D = null;    // settings snapshot the camera is currently framed with
const compExport3D = { fmt: 'png', transparent: true }; // image export options (png | jpg; transparent applies to png only)

// Draft settings (what the panel shows). Only Generate/Randomise apply them.
const compState3D = {
  h: 3508, b: 2480,          // canvas height × breadth, px (default A4 @300dpi)
  rot: 0,                    // canvas rotation 0..360 (2D, clockwise)
  fits: true,                // model fits to canvas
  aim: ['', ''],             // up to two body-part ids (only when fits = false)
  zoom: 0,                   // % closer than the fitted framing
  panX: 0, panY: 0,          // -100..100 across the available travel
  mrx: 0, mry: 0, mrz: 0,    // model rotation X/Y/Z, degrees
  randPose: false,           // Randomise Pose on Generate/Randomise
};
// Locks stop Randomise from changing an option. Canvas size starts locked so
// the A4 default isn't thrown away on the first Randomise — unlock it to
// randomise between the size presets.
const compLocks3D = { size: true, rot: false, fits: false, aim: false, zoom: false, pan: false, mrot: false };

// ── Geometry helpers ────────────────────────────────────────────────────────

// World-space corner points of (part of) a box-ish mesh, from its geometry
// bounds + current world matrix. face: all | top | bottom | front | back | backLow
function compMeshPts3D(mesh, face) {
  if (!mesh || !mesh.geometry) return [];
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  let xs = [bb.min.x, bb.max.x], ys = [bb.min.y, bb.max.y], zs = [bb.min.z, bb.max.z];
  if (face === 'bottom') ys = [bb.min.y];
  else if (face === 'top') ys = [bb.max.y];
  else if (face === 'front') zs = [bb.max.z];
  else if (face === 'back') zs = [bb.min.z];
  else if (face === 'backLow') { zs = [bb.min.z]; ys = [bb.min.y, (bb.min.y + bb.max.y) / 2]; }
  mesh.updateWorldMatrix(true, false);
  const out = [];
  xs.forEach(x => ys.forEach(y => zs.forEach(z => out.push(new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld)))));
  return out;
}

const COMP_SPHERE_DIRS_3D = (() => {
  const d = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (x || y || z) d.push(new THREE.Vector3(x, y, z).normalize());
  }
  return d; // 26 directions: rotation-agnostic enough for a ball
})();
function compSpherePts3D(center, r) {
  return COMP_SPHERE_DIRS_3D.map(dir => center.clone().addScaledVector(dir, r));
}
// A joint ball mesh (hip/knee/wrist…) → points around it.
function compJointPts3D(mesh, fallbackGroup, fallbackR) {
  if (mesh) {
    mesh.updateWorldMatrix(true, false);
    const c = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const sc = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
    const gr = mesh.geometry && mesh.geometry.parameters && mesh.geometry.parameters.radius;
    return compSpherePts3D(c, (gr || fallbackR) * Math.max(sc.x, sc.y, sc.z));
  }
  if (fallbackGroup) {
    fallbackGroup.updateWorldMatrix(true, false);
    return compSpherePts3D(new THREE.Vector3().setFromMatrixPosition(fallbackGroup.matrixWorld), fallbackR);
  }
  return [];
}
const compRecs3D = (group) => (meshRecords3D || []).filter(r => r.group === group);

function compFullPoints3D() {
  const pts = [];
  (meshRecords3D || []).forEach(r => compMeshPts3D(r.mesh, 'all').forEach(p => pts.push(p)));
  return pts;
}

// World points for one aim option (both sides where it is a pair).
function compAimPoints3D(id) {
  const out = [];
  const add = (a) => a.forEach(p => out.push(p));
  const sides = ['left', 'right'];
  switch (id) {
    case 'head': compRecs3D('head').forEach(r => add(compMeshPts3D(r.mesh, 'all'))); break;
    case 'neck': compRecs3D('neck').forEach(r => add(compMeshPts3D(r.mesh, 'all'))); break;
    case 'shoulder':
      sides.forEach(s => {
        const g = rig3D[s + 'Shoulder']; if (!g) return;
        let ball = null;
        g.children.forEach(ch => { if (!ball && ch.geometry && ch.geometry.type === 'SphereGeometry') ball = ch; });
        const armRec = compRecs3D(s + 'Arm')[0];
        add(compJointPts3D(ball, g, armRec ? armRec.wCm * 0.75 : 4));
      });
      break;
    case 'upperarm':
      sides.forEach(s => {
        const fore = rig3D[s + 'ForearmMesh'];
        const rec = compRecs3D(s + 'Arm').find(r => r.mesh !== fore);
        if (rec) add(compMeshPts3D(rec.mesh, 'all'));
      });
      break;
    case 'lowerarm':
      sides.forEach(s => {
        const fore = rig3D[s + 'ForearmMesh'];
        if (fore) add(compMeshPts3D(fore, 'all'));
      });
      break;
    case 'wrist':
      sides.forEach(s => add(compJointPts3D(rig3D[s + 'WristJointMesh'], rig3D[s + 'Wrist'], 2)));
      break;
    case 'handbot':
      sides.forEach(s => { const r = compRecs3D(s + 'Hand')[0]; if (r) add(compMeshPts3D(r.mesh, 'bottom')); });
      break;
    case 'waistline': {
      // The spine pivot is the waistline; give it a little band so it isn't a zero-height line.
      const g = rig3D.spine; if (!g) break;
      g.updateWorldMatrix(true, false);
      const hw = Math.max(torsoHalfWidthCm3D || 10, 5), band = hw * 0.3, dp = hw * 0.5;
      [-1, 1].forEach(sx => [-1, 1].forEach(sy => [-1, 1].forEach(sz => {
        out.push(new THREE.Vector3(sx * hw, sy * band, sz * dp).applyMatrix4(g.matrixWorld));
      })));
      break;
    }
    case 'hip':
      sides.forEach(s => add(compJointPts3D(rig3D[s + 'HipJointMesh'], rig3D[s + 'Hip'], 4)));
      break;
    case 'butt': {
      // Back face of the waist/hip box (lower half). Hourglass build = two meshes: the first is the lower one.
      const recs = compRecs3D('waistbox');
      if (recs.length > 1) add(compMeshPts3D(recs[0].mesh, 'back'));
      else if (recs.length) add(compMeshPts3D(recs[0].mesh, 'backLow'));
      break;
    }
    case 'knee':
      sides.forEach(s => add(compJointPts3D(rig3D[s + 'KneeJointMesh'], rig3D[s + 'Knee'], 3)));
      break;
    case 'footbot':
      sides.forEach(s => { const r = compRecs3D(s + 'Foot')[0]; if (r) add(compMeshPts3D(r.mesh, 'bottom')); });
      break;
    case 'footfront':
      sides.forEach(s => { const r = compRecs3D(s + 'Foot')[0]; if (r) add(compMeshPts3D(r.mesh, 'front')); });
      break;
  }
  return out;
}

// Solve camera distance + in-plane shift so `points` fill the canvas (aspect = b/h) for a camera of
// orientation `q`. Returns the fitted view axis point A, distance d, and the region's half extents.
function compFit3D(points, q, aspect, margin) {
  const V = THREE.Vector3;
  const r = new V(1, 0, 0).applyQuaternion(q);
  const u = new V(0, 1, 0).applyQuaternion(q);
  const f = new V(0, 0, -1).applyQuaternion(q);
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera3D.fov / 2));
  const kx = tanH * aspect * (1 - margin), ky = tanH * (1 - margin);
  const T = new THREE.Box3().setFromPoints(points).getCenter(new V());
  const rel = new V();
  let px = 0, py = 0;
  const pass = () => {
    const A = T.clone().addScaledVector(r, px).addScaledVector(u, py);
    const c = points.map(P => { rel.subVectors(P, A); return [rel.dot(r), rel.dot(u), rel.dot(f)]; });
    let need = 0, minF = Infinity;
    c.forEach(([x, y, z]) => { need = Math.max(need, Math.abs(x) / kx - z, Math.abs(y) / ky - z); minF = Math.min(minF, z); });
    const d = Math.max(need, -minF + 1, 1);
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    c.forEach(([x, y, z]) => {
      const zz = z + d, nx = x / (zz * tanH * aspect), ny = y / (zz * tanH);
      if (nx < mnx) mnx = nx; if (nx > mxx) mxx = nx; if (ny < mny) mny = ny; if (ny > mxy) mxy = ny;
    });
    return { A, d, cx: (mnx + mxx) / 2, cy: (mny + mxy) / 2, hx: (mxx - mnx) / 2, hy: (mxy - mny) / 2 };
  };
  let res = pass();
  for (let i = 0; i < 40 && (Math.abs(res.cx) > 1e-5 || Math.abs(res.cy) > 1e-5); i++) {
    px += res.cx * res.d * tanH * aspect;
    py += res.cy * res.d * tanH;
    res = pass();
  }
  return { A: res.A, d: res.d, r, u, f, tanH, aspect,
           Hx: res.hx * res.d * tanH * aspect, Hy: res.hy * res.d * tanH };
}

// Poses the camera for the given settings. Always works from the CURRENT pose's real geometry.
function compPositionCamera3D(s) {
  if (!camera3D || !poseRootGroup3D || !(meshRecords3D || []).length) return false;
  poseRootGroup3D.updateMatrixWorld(true);
  const aspect = Math.max(0.05, s.b / s.h);
  const rad = THREE.MathUtils.degToRad;

  let pts = [];
  if (!s.fits) s.aim.filter(Boolean).forEach(id => compAimPoints3D(id).forEach(p => pts.push(p)));
  if (!pts.length) pts = compFullPoints3D(); // fits = Yes, or no aim chosen → whole body
  if (!pts.length) return false;

  // Model rotation == camera orbit by the inverse; canvas rotation == roll about the view axis.
  const qModel = new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(s.mrx), rad(s.mry), rad(s.mrz), COMP_EULER_ORDER_3D));
  const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rad(s.rot));
  const qCam = qModel.clone().invert().multiply(qRoll);

  const fit = compFit3D(pts, qCam, aspect, COMP_MARGIN_3D);
  const zoom = s.fits ? 0 : Math.max(0, s.zoom);
  const dz = Math.max(fit.d / (1 + zoom / 100), 0.5);
  const A = fit.A.clone();
  if (!s.fits) {
    // Travel per axis = the larger of (a) how much bigger the framed region is than the zoomed view and
    // (b) a share of the region that grows with zoom. (b) keeps the slider alive on an axis where the
    // region is narrower than the view (e.g. a standing body in a wide canvas); at 0% zoom both are 0.
    const share = Math.min(1, zoom / 100);
    const slackX = Math.max(0, fit.Hx - dz * fit.tanH * aspect, fit.Hx * share);
    const slackY = Math.max(0, fit.Hy - dz * fit.tanH, fit.Hy * share);
    A.addScaledVector(fit.r, (s.panX / 100) * slackX).addScaledVector(fit.u, (s.panY / 100) * slackY);
  }
  camera3D.aspect = aspect;
  camera3D.position.copy(A).addScaledVector(fit.f, -dz);
  camera3D.quaternion.copy(qCam);
  camera3D.updateProjectionMatrix();
  camera3D.updateMatrixWorld(true);
  return true;
}

// ── Frame / render hook ─────────────────────────────────────────────────────

function compFrameRect3D() {
  const cont = document.getElementById('preview3D');
  const W = cont.clientWidth, H = cont.clientHeight;
  const cr = cont.getBoundingClientRect();
  // Bottom edge of the usable area: the real top of the settings sheet (so the canvas can never slip under it,
  // whatever its height / bottom offset), and never lower than what a mobile browser actually shows
  // (visualViewport excludes the collapsing URL bar / on-screen toolbars that 100dvh can still overlap).
  let limit = H;
  const vv = window.visualViewport;
  if (vv) limit = Math.min(limit, vv.offsetTop + vv.height - cr.top);
  const sheet = document.getElementById('jeCompSheet');
  if (sheet && sheet.offsetParent !== null) limit = Math.min(limit, sheet.getBoundingClientRect().top - cr.top);
  const pad = 12, gap = 12, topPad = 24; // topPad leaves room for the size label above the frame
  const aw = Math.max(40, W - pad * 2), ah = Math.max(40, limit - topPad - gap);
  const aspect = (compApplied3D ? compApplied3D.b / compApplied3D.h : compState3D.b / compState3D.h) || 1;
  let w = aw, h = w / aspect;
  if (h > ah) { h = ah; w = h * aspect; }
  return { W, H, x: (W - w) / 2, y: topPad + (ah - h) / 2, w, h };
}

// Called from animate3D() instead of the normal full-canvas render while composition is open.
function compositionRender3D() {
  if (!compActive3D || !compApplied3D) return false;
  const r = compFrameRect3D();
  const aspect = r.w / r.h;
  if (Math.abs(camera3D.aspect - aspect) > 1e-6) { camera3D.aspect = aspect; camera3D.updateProjectionMatrix(); }
  renderer3D.setScissorTest(false);
  renderer3D.setViewport(0, 0, r.W, r.H);
  renderer3D.setClearColor(0x08080a, 1); // outside the canvas frame (scene.background re-sets this inside it)
  renderer3D.clear();
  const glY = r.H - r.y - r.h;
  renderer3D.setViewport(r.x, glY, r.w, r.h);
  renderer3D.setScissor(r.x, glY, r.w, r.h);
  renderer3D.setScissorTest(true);
  renderer3D.render(scene3D, camera3D);
  renderer3D.setScissorTest(false);
  renderer3D.setViewport(0, 0, r.W, r.H);

  const fr = document.getElementById('jeCompFrame');
  if (fr) {
    fr.style.left = r.x + 'px'; fr.style.top = r.y + 'px'; fr.style.width = r.w + 'px'; fr.style.height = r.h + 'px';
    const lab = fr.firstElementChild;
    if (lab) lab.textContent = compApplied3D.b + ' × ' + compApplied3D.h + ' px · ' + compApplied3D.rot + '°';
  }
  return true;
}

// ── Pose randomising ────────────────────────────────────────────────────────

function compRandomPose3D() {
  if (typeof POSES3D === 'undefined') return;
  const keys = Object.keys(POSES3D).filter(k => k !== currentPose3D);
  if (!keys.length) return;
  const key = keys[Math.floor(Math.random() * keys.length)];
  // Same call the Pose panel uses, so per-pose joint edits / pins / hand overrides all swap in.
  setPose3D(key);
  compPoseChanged3D = true;
  compUpdatePoseLabel3D();
}
function compUpdatePoseLabel3D() {
  const el = document.getElementById('cpPoseName');
  if (!el || typeof POSES3D === 'undefined') return;
  const p = POSES3D[currentPose3D];
  el.textContent = 'Pose: ' + (p ? (p.label || currentPose3D) : currentPose3D);
}

// ── Generate / Randomise ────────────────────────────────────────────────────

function compClean3D() {
  const s = compState3D;
  const num = (v, lo, hi, dflt) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; };
  s.h = Math.round(num(s.h, 64, 10000, 3508));
  s.b = Math.round(num(s.b, 64, 10000, 2480));
  s.rot = Math.round(((num(s.rot, -3600, 3600, 0) % 360) + 360) % 360);
  s.zoom = Math.round(num(s.zoom, 0, 1000, 0));
  s.panX = Math.round(num(s.panX, -100, 100, 0)); s.panY = Math.round(num(s.panY, -100, 100, 0));
  s.mrx = Math.round(num(s.mrx, -180, 180, 0)); s.mry = Math.round(num(s.mry, -180, 180, 0)); s.mrz = Math.round(num(s.mrz, -180, 180, 0));
  if (s.aim[0] && s.aim[0] === s.aim[1]) s.aim[1] = '';
}

function generateComposition3D(opts) {
  if (!compActive3D) return;
  compClean3D();
  if (compState3D.randPose && !(opts && opts.skipPose)) compRandomPose3D();
  compApplied3D = JSON.parse(JSON.stringify(compState3D));
  compSyncUI3D();
  compPositionCamera3D(compApplied3D);
  requestRender3D(6);
}

function randomiseComposition3D() {
  if (!compActive3D) return;
  const S = compState3D, L = compLocks3D;
  const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
  // Fully random: every unlocked option is rolled uniformly across its whole range (no weighting).
  if (!L.size) { const p = COMP_SIZE_PRESETS_3D[rnd(0, COMP_SIZE_PRESETS_3D.length - 1)]; S.h = p.h; S.b = p.b; }
  if (!L.rot) S.rot = rnd(0, 359);
  if (!L.fits) S.fits = rnd(0, 1) === 1;
  if (!S.fits) {
    if (!L.aim) {
      const ids = COMP_AIM_PARTS_3D.map(p => p.id);
      const a = ids[rnd(0, ids.length - 1)];
      let b = '';
      if (rnd(0, 1) === 1) { do { b = ids[rnd(0, ids.length - 1)]; } while (b === a); }
      S.aim = [a, b];
    }
    if (!L.zoom) S.zoom = rnd(0, 500);
    if (!L.pan) { S.panX = rnd(-100, 100); S.panY = rnd(-100, 100); }
  }
  if (!L.mrot) { S.mrx = rnd(-180, 180); S.mry = rnd(-180, 180); S.mrz = rnd(-180, 180); }
  generateComposition3D();
}

// ── UI ──────────────────────────────────────────────────────────────────────

function compSet3D(key, value) {
  const S = compState3D;
  if (key === 'fits') S.fits = !!value;
  else if (key === 'randPose') S.randPose = !!value;
  else if (key === 'aim0') S.aim[0] = value;
  else if (key === 'aim1') S.aim[1] = value;
  else S[key] = (value === '' ? '' : Number(value));
  compSyncUI3D(key);
}
function compSetPreset3D(id) {
  const p = COMP_SIZE_PRESETS_3D.find(x => x.id === id);
  if (p) { compState3D.h = p.h; compState3D.b = p.b; }
  compSyncUI3D();
}
function compToggleLock3D(k) { compLocks3D[k] = !compLocks3D[k]; compSyncUI3D(); }
function compToggleCollapse3D() {
  compCollapsed3D = !compCollapsed3D;
  const sh = document.getElementById('jeCompSheet');
  if (sh) sh.classList.toggle('collapsed', compCollapsed3D);
  compSyncUI3D();
  requestRender3D(6);
}

// Keeps every input in step with compState3D (skipping the one currently being typed in).
function compSyncUI3D(skipKey) {
  if (!compUIBuilt3D) return;
  const S = compState3D;
  const $ = (id) => document.getElementById(id);
  const setVal = (id, v, key) => { const el = $(id); if (el && key !== skipKey && document.activeElement !== el) el.value = v; };
  setVal('cpH', S.h, 'h'); setVal('cpB', S.b, 'b');
  const pre = COMP_SIZE_PRESETS_3D.find(p => p.h === S.h && p.b === S.b);
  if ($('cpPreset')) $('cpPreset').value = pre ? pre.id : 'custom';
  setVal('cpRot', S.rot, 'rot'); setVal('cpRotN', S.rot, 'rot');
  setVal('cpZoom', S.zoom, 'zoom'); setVal('cpZoomN', S.zoom, 'zoom');
  setVal('cpPanX', S.panX, 'panX'); setVal('cpPanXN', S.panX, 'panX');
  setVal('cpPanY', S.panY, 'panY'); setVal('cpPanYN', S.panY, 'panY');
  ['x', 'y', 'z'].forEach(a => { setVal('cpM' + a, S['mr' + a], 'mr' + a); setVal('cpM' + a + 'N', S['mr' + a], 'mr' + a); });
  $('cpFitsYes').classList.toggle('active', S.fits);
  $('cpFitsNo').classList.toggle('active', !S.fits);
  $('cpPoseYes').classList.toggle('active', S.randPose);
  $('cpPoseNo').classList.toggle('active', !S.randPose);
  $('cpAim0').value = S.aim[0]; $('cpAim1').value = S.aim[1];
  const E = compExport3D;
  $('cpFmtPng').classList.toggle('active', E.fmt === 'png'); $('cpFmtJpg').classList.toggle('active', E.fmt === 'jpg');
  $('cpTranYes').classList.toggle('active', E.transparent); $('cpTranNo').classList.toggle('active', !E.transparent);
  document.querySelectorAll('#jeCompSheet [data-dep="png"]').forEach(r => r.classList.toggle('dim', E.fmt !== 'png'));
  ['cpTranYes', 'cpTranNo'].forEach(id => { $(id).disabled = E.fmt !== 'png'; });
  // Aim / Zoom / Pan only apply when the model is NOT forced to fit the canvas.
  ['cpAim0', 'cpAim1', 'cpZoom', 'cpZoomN', 'cpPanX', 'cpPanXN', 'cpPanY', 'cpPanYN'].forEach(id => { $(id).disabled = S.fits; });
  document.querySelectorAll('#jeCompSheet .cp-row[data-dep="nofit"]').forEach(r => r.classList.toggle('dim', S.fits));
  Object.keys(compLocks3D).forEach(k => {
    const b = $('cpLock_' + k); if (!b) return;
    b.classList.toggle('on', compLocks3D[k]);
    b.setAttribute('aria-pressed', compLocks3D[k] ? 'true' : 'false');
  });
  compUpdatePoseLabel3D();
}

// Inline SVG icons (stroke = currentColor, so CSS colours them). Replaces the emoji/default glyphs.
const COMP_ICONS_3D = {
  locked:   '<svg class="ic-locked" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="16" r="1.3" fill="currentColor" stroke="none"/></svg>',
  unlocked: '<svg class="ic-open" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.4-2.1"/><circle cx="12" cy="16" r="1.3" fill="currentColor" stroke="none"/></svg>',
  chevron:  '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  close:    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  dice:     '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>',
  sparkle:  '<svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>',
  upload:   '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
  image:    '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 16"/></svg>',
  refresh:  '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
};

function compBuildUI3D() {
  if (compUIBuilt3D) return;
  const cont = document.getElementById('preview3D');
  if (!cont) return;
  const IC = COMP_ICONS_3D;
  // A square lock tile (own grid column, right side of its row). Both icons are in the markup; CSS shows the right one.
  const lock = (k) => `<button type="button" class="cp-lock" id="cpLock_${k}" onclick="compToggleLock3D('${k}')" aria-pressed="false" aria-label="Lock ${k}" title="Lock (stops Randomise changing this)">${IC.unlocked}${IC.locked}</button>`;
  const row = (label, lockKey, body, attrs) =>
    `<div class="cp-row${lockKey ? '' : ' cp-wide'}" ${attrs || ''}><div class="cp-body"><div class="cp-lab">${label}</div>${body}</div>${lockKey ? lock(lockKey) : ''}</div>`;
  const slider = (id, key, min, max) =>
    `<input type="range" id="${id}" min="${min}" max="${max}" step="1" oninput="compSet3D('${key}', this.value)">` +
    `<input type="number" id="${id}N" min="${min}" max="${max}" step="1" oninput="compSet3D('${key}', this.value)">`;
  const aimOpts = '<option value="">None</option>' + COMP_AIM_PARTS_3D.map(p => `<option value="${p.id}">${p.label}</option>`).join('');
  const presetOpts = COMP_SIZE_PRESETS_3D.map(p => `<option value="${p.id}">${p.label}</option>`).join('') + '<option value="custom">Custom</option>';

  const frame = document.createElement('div');
  frame.id = 'jeCompFrame'; frame.innerHTML = '<span></span>'; frame.style.display = 'none';
  const blocker = document.createElement('div');
  blocker.id = 'jeCompBlocker'; blocker.style.display = 'none';
  const sheet = document.createElement('div');
  sheet.id = 'jeCompSheet'; sheet.style.display = 'none';
  sheet.innerHTML = `
    <div class="cp-head">
      <span class="jec-title">Composition</span>
      <span class="cp-head-btns">
        <button type="button" class="cp-icon-btn" id="cpCollapse" onclick="compToggleCollapse3D()" aria-label="Show or hide settings" title="Show / hide settings">${IC.chevron}</button>
        <button type="button" class="cp-icon-btn" onclick="closeCompositionPanel3D()" aria-label="Close" title="Close">${IC.close}</button>
      </span>
    </div>
    <div class="cp-scroll">
      ${row('Canvas size (px)', 'size', `
        <div class="cp-ctl">
          <select id="cpPreset" onchange="compSetPreset3D(this.value)">${presetOpts}</select>
          <span class="cp-mini">H</span><input type="number" id="cpH" min="64" max="10000" oninput="compSet3D('h', this.value)">
          <span class="cp-mini">B</span><input type="number" id="cpB" min="64" max="10000" oninput="compSet3D('b', this.value)">
        </div>`)}
      ${row('Canvas rotation (0–360°)', 'rot', `<div class="cp-ctl">${slider('cpRot', 'rot', 0, 360)}</div>`)}
      ${row('Model fits to canvas', 'fits', `
        <div class="cp-ctl cp-seg"><button type="button" class="je-mode-btn" id="cpFitsYes" onclick="compSet3D('fits', true)">Yes</button><button type="button" class="je-mode-btn" id="cpFitsNo" onclick="compSet3D('fits', false)">No</button></div>`)}
      ${row('Body part aim (up to 2)', 'aim', `
        <div class="cp-ctl"><select id="cpAim0" onchange="compSet3D('aim0', this.value)">${aimOpts}</select><select id="cpAim1" onchange="compSet3D('aim1', this.value)">${aimOpts}</select></div>`, 'data-dep="nofit"')}
      ${row('Zoom (%)', 'zoom', `<div class="cp-ctl">${slider('cpZoom', 'zoom', 0, 500)}</div>`, 'data-dep="nofit"')}
      ${row('Pan X / Y', 'pan', `
        <div class="cp-ctl">${slider('cpPanX', 'panX', -100, 100)}</div>
        <div class="cp-ctl">${slider('cpPanY', 'panY', -100, 100)}</div>`, 'data-dep="nofit"')}
      ${row('Model rotation X / Y / Z (°)', 'mrot', `
        <div class="cp-ctl"><span class="cp-mini">X</span>${slider('cpMx', 'mrx', -180, 180)}</div>
        <div class="cp-ctl"><span class="cp-mini">Y</span>${slider('cpMy', 'mry', -180, 180)}</div>
        <div class="cp-ctl"><span class="cp-mini">Z</span>${slider('cpMz', 'mrz', -180, 180)}</div>`)}
      ${row('Randomise pose', null, `
        <div class="cp-ctl cp-seg"><button type="button" class="je-mode-btn" id="cpPoseYes" onclick="compSet3D('randPose', true)">Yes</button><button type="button" class="je-mode-btn" id="cpPoseNo" onclick="compSet3D('randPose', false)">No</button></div>
        <div class="cp-pose" id="cpPoseName"></div>`)}
      ${row('Save image', null, `
        <div class="cp-ctl cp-seg"><button type="button" class="je-mode-btn" id="cpFmtPng" onclick="compSetExport3D('fmt', 'png')">PNG</button><button type="button" class="je-mode-btn" id="cpFmtJpg" onclick="compSetExport3D('fmt', 'jpg')">JPG</button></div>
        <div class="cp-lab" data-dep="png" style="margin:6px 0 4px">Transparent background (PNG only)</div>
        <div class="cp-ctl cp-seg" data-dep="png"><button type="button" class="je-mode-btn" id="cpTranYes" onclick="compSetExport3D('transparent', true)">Yes</button><button type="button" class="je-mode-btn" id="cpTranNo" onclick="compSetExport3D('transparent', false)">No</button></div>
        <div class="cp-ctl"><button type="button" class="je-bottom-btn je-apply cp-wide-btn" onclick="exportCompositionImage3D(this)">${IC.image}<span>Save image</span></button></div>
        <div class="cp-status" id="cpExportStatus"></div>`)}
      <div class="cp-row cp-wide cp-presets"><div class="cp-body"><div class="cp-lab">Presets (GitHub · presets/composition)</div>
        <div class="cp-ctl"><input type="text" id="cpPresetName" placeholder="Preset name, e.g. hero-closeup" maxlength="80">
          <button type="button" class="je-bottom-btn je-apply cp-small" id="cpSaveBtn" onclick="saveCompositionPreset3D()" title="Save preset">${IC.upload}<span>Save</span></button></div>
        <div class="cp-ctl"><select id="cpPresetList" onfocus="refreshCompositionPresets3D()"><option value="">— Choose preset —</option></select>
          <button type="button" class="je-bottom-btn cp-small cp-sq" onclick="refreshCompositionPresets3D()" aria-label="Refresh list" title="Refresh list">${IC.refresh}</button>
          <button type="button" class="je-bottom-btn cp-small" onclick="loadCompositionPreset3D()" title="Load preset">${IC.download}<span>Load</span></button></div>
        <div class="cp-status" id="cpPresetStatus"></div></div></div>
    </div>
    <div class="cp-actions">
      <button type="button" class="je-bottom-btn je-apply" onclick="generateComposition3D()">${IC.sparkle}<span>Generate</span></button>
      <button type="button" class="je-bottom-btn" onclick="randomiseComposition3D()">${IC.dice}<span>Randomise</span></button>
      <button type="button" class="je-bottom-btn cp-act-save" onclick="exportCompositionImage3D(this)" aria-label="Save image" title="Save image (uses the format chosen in Save image)">${IC.image}<span>Save</span></button>
    </div>`;
  cont.appendChild(frame); cont.appendChild(blocker); cont.appendChild(sheet);
  // The canvas frame is laid out around the sheet's real height, so redraw whenever the sheet resizes
  // (expand / collapse, wrapped status text, rotating the phone).
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => requestRender3D(4)).observe(sheet);
  compUIBuilt3D = true;
}

// ── Image export (PNG / JPG) ────────────────────────────────────────────────
// Re-renders the CURRENT framing (compApplied3D = what is on screen) off-screen at the canvas size
// (B × H px, scaled down only if the device can't allocate that big a buffer), so the file is exactly the
// framed canvas without the dark letterbox, the gold frame outline or any editor overlay.
// PNG + transparent: scene background is removed and the alpha channel is kept. JPG: the normal dark
// background (JPG has no alpha).

const COMP_EXPORT_MAX_PIXELS_3D = 16777216; // 4096²: safe on phones

function compSetExport3D(key, value) {
  if (key === 'fmt') compExport3D.fmt = value === 'jpg' ? 'jpg' : 'png';
  else if (key === 'transparent') compExport3D.transparent = !!value;
  compSyncUI3D();
}

function compExportStatus3D(msg, kind) {
  const el = document.getElementById('cpExportStatus'); if (!el) return;
  el.textContent = msg || '';
  el.style.color = kind === 'err' ? '#ff4d4d' : kind === 'ok' ? '#4cd964' : 'var(--muted)';
}

// Renders the framed composition into an RGBA ImageData (top-down). Returns {imageData, w, h, scaled}.
function compRenderToImageData3D(transparent) {
  const ap = compApplied3D;
  const maxTex = renderer3D.capabilities.maxTextureSize || 4096;
  let w = ap.b, h = ap.h, k = 1;
  k = Math.min(1, maxTex / Math.max(w, h), Math.sqrt(COMP_EXPORT_MAX_PIXELS_3D / (w * h)));
  const scaled = k < 1;
  if (scaled) { w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); }

  const useMS = renderer3D.capabilities.isWebGL2 && typeof THREE.WebGLMultisampleRenderTarget === 'function';
  const rt = useMS ? new THREE.WebGLMultisampleRenderTarget(w, h, { format: THREE.RGBAFormat }) : new THREE.WebGLRenderTarget(w, h, { format: THREE.RGBAFormat });
  const prevBg = scene3D.background, prevAspect = camera3D.aspect;
  const prevClear = new THREE.Color(); renderer3D.getClearColor(prevClear);
  const prevAlpha = renderer3D.getClearAlpha();
  // Hide everything that is not the posed body or a light (gizmo, puppet lines, markers…).
  const hidden = [];
  scene3D.children.forEach(o => {
    if (o === poseRootGroup3D || o.isLight || !o.visible) return;
    o.visible = false; hidden.push(o);
  });
  let pixels;
  try {
    camera3D.aspect = w / h; camera3D.updateProjectionMatrix();
    if (transparent) scene3D.background = null;
    renderer3D.setScissorTest(false);
    renderer3D.setRenderTarget(rt);
    renderer3D.setClearColor(0x000000, 0);
    renderer3D.clear();
    renderer3D.render(scene3D, camera3D);
    pixels = new Uint8Array(w * h * 4);
    renderer3D.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
  } finally {
    renderer3D.setRenderTarget(null);
    scene3D.background = prevBg;
    renderer3D.setClearColor(prevClear, prevAlpha);
    camera3D.aspect = prevAspect; camera3D.updateProjectionMatrix();
    hidden.forEach(o => { o.visible = true; });
    rt.dispose();
    requestRender3D(4);
  }
  // GL rows are bottom-up; flip. Colour comes out premultiplied by alpha (blending onto a transparent
  // clear), so un-premultiply for a normal straight-alpha PNG.
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    let si = (h - 1 - y) * w * 4, di = y * w * 4;
    for (let x = 0; x < w; x++, si += 4, di += 4) {
      const a = pixels[si + 3];
      if (a === 0) { out[di] = out[di + 1] = out[di + 2] = 0; out[di + 3] = 0; continue; }
      if (a === 255) { out[di] = pixels[si]; out[di + 1] = pixels[si + 1]; out[di + 2] = pixels[si + 2]; out[di + 3] = 255; continue; }
      const f = 255 / a;
      out[di] = Math.min(255, pixels[si] * f + 0.5); out[di + 1] = Math.min(255, pixels[si + 1] * f + 0.5);
      out[di + 2] = Math.min(255, pixels[si + 2] * f + 0.5); out[di + 3] = a;
    }
  }
  return { imageData: new ImageData(out, w, h), w, h, scaled };
}

function exportCompositionImage3D(btn) {
  if (!compActive3D || !compApplied3D) return;
  const label = btn && btn.querySelector('span');
  const origLabel = label ? label.textContent : '';
  const flash = (t) => { if (label) { label.textContent = t; setTimeout(() => { label.textContent = origLabel; if (btn) btn.disabled = false; }, 1600); } };
  const isPng = compExport3D.fmt === 'png';
  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Saving…';
  compExportStatus3D('Rendering…');
  // Let the "Saving…" label paint before the heavy render.
  setTimeout(() => {
    try {
      const r = compRenderToImageData3D(isPng && compExport3D.transparent);
      const cv = document.createElement('canvas'); cv.width = r.w; cv.height = r.h;
      cv.getContext('2d').putImageData(r.imageData, 0, 0);
      cv.toBlob(blob => {
        if (!blob) { compExportStatus3D('Could not create the image (too large for this device?).', 'err'); flash('Failed'); return; }
        const pose = String(typeof currentPose3D === 'string' ? currentPose3D : 'pose').replace(/[^\w\-]+/g, '_');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'composition_' + pose + '_' + r.w + 'x' + r.h + (isPng ? '.png' : '.jpg');
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        compExportStatus3D('Saved ' + r.w + ' × ' + r.h + ' px ' + (isPng ? 'PNG' + (compExport3D.transparent ? ' (transparent)' : '') : 'JPG') + (r.scaled ? ' — scaled down to fit this device' : ''), 'ok');
        flash('Saved');
      }, isPng ? 'image/png' : 'image/jpeg', 0.95);
    } catch (e) {
      console.error('Composition export failed', e);
      compExportStatus3D('Export failed: ' + (e && e.message ? e.message : e), 'err');
      flash('Failed');
    }
  }, 60);
}

// ── Presets (saved as separate .json files, like Height / Faces) ───────────
// Same GitHub settings (token / owner / repo / branch) as the Height + Faces presets; files live in
// presets/composition/<name>.json (override with localStorage 'ghCompFolder'). Saving needs a token;
// loading works without one on a public repo. A preset stores every option + its lock state, but not
// the pose itself (only the Randomise Pose yes/no).

function compGh3D() {
  if (typeof ghGetSettings !== 'function') return null;
  const s = ghGetSettings();
  s.folder = localStorage.getItem('ghCompFolder') || 'presets/composition';
  return s;
}
const compApiUrl3D = (s, path) =>
  `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
function compStatus3D(msg, kind) {
  const el = document.getElementById('cpPresetStatus'); if (!el) return;
  el.textContent = msg || '';
  el.style.color = kind === 'err' ? '#ff4d4d' : kind === 'ok' ? '#4cd964' : 'var(--muted)';
}
function compPresetData3D(name) {
  return {
    _type: 'composition', _name: name, version: 1,
    settings: JSON.parse(JSON.stringify(compState3D)),
    locks: JSON.parse(JSON.stringify(compLocks3D)),
  };
}

async function refreshCompositionPresets3D(selectName) {
  const sel = document.getElementById('cpPresetList'); const s = compGh3D();
  if (!sel || !s) return;
  if (!s.owner || !s.repo) { sel.innerHTML = '<option value="">(enter GitHub settings)</option>'; return; }
  const keep = selectName || sel.value;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const resp = await fetch(`${compApiUrl3D(s, s.folder)}?ref=${encodeURIComponent(s.branch)}`, { headers: ghHeaders(s.token) });
    if (resp.status === 404) { sel.innerHTML = '<option value="">(no presets yet)</option>'; return; }
    if (!resp.ok) throw new Error(resp.statusText);
    const files = (await resp.json());
    const jf = (Array.isArray(files) ? files : []).filter(f => f.type === 'file' && /\.json$/i.test(f.name));
    if (!jf.length) { sel.innerHTML = '<option value="">(no presets yet)</option>'; return; }
    sel.innerHTML = '<option value="">— Choose preset —</option>' +
      jf.map(f => `<option value="${f.path}">${f.name.replace(/\.json$/i, '')}</option>`).join('');
    if (keep) sel.value = keep;
  } catch (err) {
    sel.innerHTML = '<option value="">(error loading — check settings)</option>';
    console.error(err);
  }
}

async function saveCompositionPreset3D() {
  const s = compGh3D();
  if (!s || !s.token || !s.owner || !s.repo) { compStatus3D('Enter your GitHub token, owner and repo first (Height / Faces tab → GitHub Presets).', 'err'); return; }
  let name = (document.getElementById('cpPresetName').value || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  if (!name) { compStatus3D('Enter a preset name.', 'err'); return; }
  compClean3D();
  const path = `${s.folder}/${name}.json`;
  const btn = document.getElementById('cpSaveBtn');
  if (btn) { btn.disabled = true; const t = btn.querySelector('span'); if (t) t.textContent = 'Saving…'; }
  try {
    const url = compApiUrl3D(s, path);
    let sha;
    const g = await fetch(`${url}?ref=${encodeURIComponent(s.branch)}`, { headers: ghHeaders(s.token) });
    if (g.ok) {
      sha = (await g.json()).sha;
      if (!confirm(`A composition preset named "${name}" already exists. Overwrite it?`)) { compStatus3D('Save cancelled.'); return; }
    }
    const body = { message: `Save composition preset: ${name}`, content: ghUtf8ToB64(JSON.stringify(compPresetData3D(name), null, 2)), branch: s.branch };
    if (sha) body.sha = sha;
    const put = await fetch(url, { method: 'PUT', headers: ghHeaders(s.token), body: JSON.stringify(body) });
    if (!put.ok) { const ej = await put.json().catch(() => ({})); throw new Error(ej.message || put.statusText); }
    compStatus3D(`Saved "${name}" to ${s.folder}.`, 'ok');
    await refreshCompositionPresets3D(path);
  } catch (err) {
    compStatus3D('GitHub save failed: ' + err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; const t = btn.querySelector('span'); if (t) t.textContent = 'Save'; }
  }
}

// Copies a loaded preset into the draft settings + locks (ignoring anything unknown/invalid) and applies it.
function compApplyPreset3D(data) {
  const src = (data && data.settings) || data || {};
  const S = compState3D;
  ['h', 'b', 'rot', 'zoom', 'panX', 'panY', 'mrx', 'mry', 'mrz'].forEach(k => { if (isFinite(Number(src[k])) && src[k] !== '' && src[k] !== null) S[k] = Number(src[k]); });
  if (typeof src.fits === 'boolean') S.fits = src.fits;
  if (typeof src.randPose === 'boolean') S.randPose = src.randPose;
  if (Array.isArray(src.aim)) {
    const ok = id => COMP_AIM_PARTS_3D.some(p => p.id === id);
    S.aim = [ok(src.aim[0]) ? src.aim[0] : '', ok(src.aim[1]) ? src.aim[1] : ''];
  }
  if (data && data.locks) Object.keys(compLocks3D).forEach(k => { if (typeof data.locks[k] === 'boolean') compLocks3D[k] = data.locks[k]; });
  // Applied as-is: a preset never randomises the pose on load (Randomise Pose only acts on Generate/Randomise).
  generateComposition3D({ skipPose: true });
}

async function loadCompositionPreset3D() {
  const s = compGh3D(); const sel = document.getElementById('cpPresetList');
  const path = sel && sel.value;
  if (!path) { compStatus3D('Choose a preset to load.', 'err'); return; }
  if (!s || !s.owner || !s.repo) { compStatus3D('Enter your GitHub owner and repo first.', 'err'); return; }
  try {
    const resp = await fetch(`${compApiUrl3D(s, path)}?ref=${encodeURIComponent(s.branch)}`, { headers: ghHeaders(s.token) });
    if (!resp.ok) throw new Error(resp.statusText);
    const data = JSON.parse(ghB64ToUtf8((await resp.json()).content));
    compApplyPreset3D(data);
    const nm = (sel.options[sel.selectedIndex] || {}).text || '';
    document.getElementById('cpPresetName').value = data._name || nm;
    compStatus3D(`Loaded "${data._name || nm}".`, 'ok');
  } catch (err) {
    compStatus3D('GitHub load failed: ' + err.message, 'err');
  }
}

// ── Open / close ────────────────────────────────────────────────────────────

function openCompositionPanel3D() {
  if (compActive3D) return;
  if (!sceneInited3D || !(meshRecords3D || []).length) return;
  compBuildUI3D();
  // Nothing from the normal editor may stay selected / open while the camera is driven by the composition.
  if (typeof deselectJoint3D === 'function') deselectJoint3D();
  ['closeFacesPopup3D', 'closeJointSettingsPopup3D', 'closeLevelPopup3D', 'closeCopyPopup3D', 'closePosePopup3D'].forEach(fn => { if (typeof window[fn] === 'function') window[fn](); });
  if (typeof resetFacesSelection3D === 'function') resetFacesSelection3D();
  const qo = document.getElementById('jeQoMenu'); if (qo) qo.classList.remove('open');

  compSaved3D = { pos: camera3D.position.clone(), target: controls3D.target.clone(), enabled: controls3D.enabled };
  controls3D.enabled = false;
  compActive3D = true; compPoseChanged3D = false; compCollapsed3D = false;
  document.body.classList.add('je-comp-active');
  ['jeCompFrame', 'jeCompBlocker', 'jeCompSheet'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
  document.getElementById('jeCompSheet').classList.remove('collapsed');
  compSyncUI3D();
  compStatus3D('');
  refreshCompositionPresets3D();
  // Show the default canvas right away, framed with the current (default) settings.
  compClean3D();
  compApplied3D = JSON.parse(JSON.stringify(compState3D));
  compPositionCamera3D(compApplied3D);
  requestRender3D(8);
}

function closeCompositionPanel3D() {
  if (!compActive3D) return;
  compActive3D = false;
  document.body.classList.remove('je-comp-active');
  ['jeCompFrame', 'jeCompBlocker', 'jeCompSheet'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const cont = document.getElementById('preview3D');
  if (renderer3D) { renderer3D.setScissorTest(false); renderer3D.setViewport(0, 0, cont.clientWidth, cont.clientHeight); }

  // Normal editor camera is back in charge.
  camera3D.aspect = cont.clientWidth / Math.max(1, cont.clientHeight);
  camera3D.updateProjectionMatrix();
  controls3D.enabled = compSaved3D ? compSaved3D.enabled : true;
  if (compPoseChanged3D) {
    // The random pose stays. Refresh the editor's pose UI exactly like a normal pose switch does…
    if (typeof refreshHandWristButtons === 'function') refreshHandWristButtons();
    jointEditorCopyLog3D = [];
    updateCopyBadge3D();
    populateCopyPoseSelect3D();
    updatePoseNameLabel3D();
    // …and re-frame the camera for the new silhouette (the old camera spot may not suit it).
    groundBody3D(true);
    if (jointEditorCameraView3D !== 'free') setJointEditorCameraView3D(jointEditorCameraView3D);
  } else if (compSaved3D) {
    camera3D.position.copy(compSaved3D.pos);
    controls3D.target.copy(compSaved3D.target);
  }
  controls3D.update();
  compSaved3D = null; compApplied3D = null;
  resizeBody3D();
  requestRender3D(8);
}
