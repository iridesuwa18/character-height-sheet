// ── body-scene.js ──────────────────────────────────────────────────
// Part of the 3d_character.js split. three.js scene bootstrap and the low-level box/trapezoid/sphere mesh builders used to construct the body from 2D layout data, plus the depth-slider defaults and per-frame animate() loop.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

// Force the depth sliders back to their real defaults on every load — some
// browsers restore stale <input type=range> values from a previous session,
// which otherwise makes it look like the "default" depth silently drifted.
function resetDepthSlidersToDefault() {
  headDepthMult = 1.1; bodyDepthMult = 0.6; waistlinePct = 100;
  const headSlider = document.getElementById('depth-head'), headVal = document.getElementById('depth-head-val');
  const bodySlider = document.getElementById('depth-body'), bodyVal = document.getElementById('depth-body-val');
  const waistSlider = document.getElementById('waistline-pct'), waistVal = document.getElementById('waistline-pct-val');
  if (headSlider) headSlider.value = '1.1';
  if (headVal) headVal.textContent = '1.1×';
  if (bodySlider) bodySlider.value = '1.2';
  if (bodyVal) bodyVal.textContent = '1.2×';
  if (waistSlider) waistSlider.value = '100';
  if (waistVal) waistVal.textContent = '100%';
}

// Pull the exact rendered geometry of every generated box (in cm, centered on the
// character's vertical midline, y=0 at the ground/PADDING_PX baseline). Also
// returns the shoulder pivot points and current arm-rotation state, measured
// with the arm rotation temporarily neutralized so widths/heights are the true,
// unrotated box sizes (not the larger diagonal bounding box of a rotated div).
function collectBodyBoxData3D() {
  // #preview must actually be laid out (not display:none) for
  // getBoundingClientRect() to return real sizes — unhide it for the
  // measurement if the 3D tab is the one currently showing.
  const wasPreviewHidden = preview.style.display === 'none';
  if (wasPreviewHidden) preview.style.display = 'flex';

  const savedLeftT = leftArmWrap ? leftArmWrap.style.transform : null;
  const savedRightT = rightArmWrap ? rightArmWrap.style.transform : null;
  if (leftArmWrap) leftArmWrap.style.transform = 'rotate(0deg)';
  if (rightArmWrap) rightArmWrap.style.transform = 'rotate(0deg)';

  const previewRect = preview.getBoundingClientRect();
  const toCm = (r) => ({
    xCm: (r.left - previewRect.left + r.width/2 - previewRect.width/2) * CM_PER_PX_3D,
    bottomCm: (previewRect.bottom - r.bottom) * CM_PER_PX_3D,
    wCm: r.width * CM_PER_PX_3D,
    hCm: r.height * CM_PER_PX_3D
  });

  const boxEls = preview.querySelectorAll('.head-box, .neck-box, .torso-box, .waist-box, .leg-box');
  const boxes = [];
  boxEls.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return; // skip the zero-width divider div
    const group = el.dataset.group || 'other';
    const side = leftArmWrap && leftArmWrap.contains(el) ? 'left'
               : rightArmWrap && rightArmWrap.contains(el) ? 'right' : null;
    boxes.push({ group, side, ...toCm(r) });
  });

  // Shoulder pivot points — the wrap is a 0×0 div, so its rect is just a point.
  const leftPivot = leftArmWrap ? toCm(leftArmWrap.getBoundingClientRect()) : null;
  const rightPivot = rightArmWrap ? toCm(rightArmWrap.getBoundingClientRect()) : null;

  if (leftArmWrap) leftArmWrap.style.transform = savedLeftT;
  if (rightArmWrap) rightArmWrap.style.transform = savedRightT;
  if (wasPreviewHidden) preview.style.display = 'none';

  const armRotated = document.getElementById('opt-armrotate')?.checked || false;
  return { boxes, leftPivot, rightPivot, armRotated };
}

function initScene3D() {
  if (sceneInited3D) return;
  const canvas = document.getElementById('body3DCanvas');
  const container = document.getElementById('preview3D');
  scene3D = new THREE.Scene();
  scene3D.background = new THREE.Color(0x161618);

  camera3D = new THREE.PerspectiveCamera(45, container.clientWidth/container.clientHeight, 0.1, 5000);
  camera3D.position.set(0, 100, 350);

  renderer3D = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
  renderer3D.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer3D.setSize(container.clientWidth, container.clientHeight);

  controls3D = new THREE.OrbitControls(camera3D, renderer3D.domElement);
  controls3D.enableDamping = true;
  controls3D.dampingFactor = 0.08;
  controls3D.screenSpacePanning = true;
  controls3D.minDistance = 20;
  controls3D.maxDistance = 2000;

  scene3D.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.1));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(150, 300, 250);
  scene3D.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dirLight2.position.set(-150, 100, -200);
  scene3D.add(dirLight2);

  bodyGroup3D = new THREE.Group();
  poseRootGroup3D = new THREE.Group();
  poseRootGroup3D.add(bodyGroup3D);
  scene3D.add(poseRootGroup3D);

  window.addEventListener('resize', resizeBody3D);
  initJointEditor3D();
  sceneInited3D = true;
  animate3D();
}

function resizeBody3D() {
  if (!sceneInited3D) return;
  const container = document.getElementById('preview3D');
  if (container.style.display === 'none') return;
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  camera3D.aspect = w/h; camera3D.updateProjectionMatrix();
  renderer3D.setSize(w, h);
}

function animate3D() {
  requestAnimationFrame(animate3D);
  if (!sceneInited3D || document.getElementById('preview3D').style.display === 'none') return;
  controls3D.update();
  renderer3D.render(scene3D, camera3D);
  updateWristSliderOverlay3D();
}

// Recursively frees GPU resources for a mesh/group tree before it's discarded.
function disposeObject3D(obj) {
  obj.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material.dispose();
    }
  });
}

function makeBoxMesh(b, depthCm) {
  const geo = new THREE.BoxGeometry(b.wCm, b.hCm, depthCm);
  const mat = new THREE.MeshStandardMaterial({
    color: groupColor3D[b.group] || 0xaaaaaa, roughness: 0.6, metalness: 0.05,
    transparent: true, opacity: 0.92
  });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.35 }));
  mesh.add(edges);
  return mesh;
}

// A trapezoidal prism: width tapers linearly from bottomWidthCm (at local
// y=0) to topWidthCm (at local y=heightCm); depth (z) is constant. Centered
// on its own local origin exactly like BoxGeometry, so it drops into the
// same mesh.position.set(x,y,z) flow. Used for the hourglass waistline split.
function makeTrapezoidMesh(topWidthCm, bottomWidthCm, heightCm, depthCm, colorHex) {
  const shape = new THREE.Shape();
  shape.moveTo(-bottomWidthCm/2, 0);
  shape.lineTo(bottomWidthCm/2, 0);
  shape.lineTo(topWidthCm/2, heightCm);
  shape.lineTo(-topWidthCm/2, heightCm);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: depthCm, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, -heightCm/2, -depthCm/2);
  const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.6, metalness: 0.05, transparent: true, opacity: 0.92 });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.35 }));
  mesh.add(edges);
  return mesh;
}

// A joint sphere, diameter matched to the depth of the part(s) it connects.
function makeJointSphere(diameterCm) {
  const geo = new THREE.SphereGeometry(Math.max(diameterCm, 0.01) / 2, 16, 12);
  const mat = new THREE.MeshStandardMaterial({ color: groupColor3D.joint, roughness: 0.5, metalness: 0.05, transparent: true, opacity: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.2 }));
  mesh.add(edges);
  return mesh;
}

// Feet get boosted to ~this multiple of their own width for front-to-back depth.
const FOOT_DEPTH_WIDTH_MULT = 2;

// Depth (and, for feet, the forward z-shift needed to keep the heel aligned
// with the leg above it) for a body box, given the current sliders. Neck and
// arms are pinned to their OWN width — a thick torso/shoulder setting
// shouldn't inflate a thin neck's or arm's depth. Hands are pinned to their
// own width too, but flatter — half their width — since a hand is a flat shape.
function computeBodyDepth3D(b) {
  if (b.group === 'neck' || b.group === 'arms') return { depthCm: 1.2 * b.wCm, zOffset: 0 };
  if (b.group === 'hands') return { depthCm: 0.5 * b.wCm, zOffset: 0 };
  const normalDepthCm = bodyDepthMult * headWidthCm3D + 0.25 * b.wCm;
  if (b.group !== 'feet') return { depthCm: normalDepthCm, zOffset: 0 };
  const footDepthCm = FOOT_DEPTH_WIDTH_MULT * b.wCm;
  const depthCm = Math.max(normalDepthCm, footDepthCm);
  return { depthCm, zOffset: (depthCm - normalDepthCm) / 2 };
}
