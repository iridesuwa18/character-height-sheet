// ═══════════════════════════════════════════════════════════════
// 3d_character.js
// Extrudes the 2D body-proportion boxes (Character Height Sheet, Body tab)
// into a real, orbit-able 3D model using Three.js.
//
// Depends on globals defined in index.html's inline script, which must load
// BEFORE this file: PX_PER_CM, SCALE_FACTOR, preview (the #preview element),
// leftArmWrap, rightArmWrap.
// Also depends on THREE and THREE.OrbitControls being loaded first.
//
// Called from index.html:
//   - generateHeight() calls buildBody3D() at the end of every Generate
//   - switchBodyView('3d'|'2d') toggles the #preview / #preview3D containers
//   - depth sliders call updateHeadDepth(value) / updateBodyDepth(value)
//   - the Recenter button calls recenterBody3D()
// ═══════════════════════════════════════════════════════════════
const CM_PER_PX_3D = 1 / (PX_PER_CM * SCALE_FACTOR);
// Depth is anchored to the head's own width, not each part's own width — so a
// wider torso/shoulder setting doesn't balloon the torso's front-to-back depth.
// Head depth = headDepthMult × head's own width. Every other part's depth =
// (bodyDepthMult × head's width) + 0.25 × that part's own width, so wider
// boxes get proportionally more depth. Feet are a special case: real feet are
// much longer (front-to-back) than they are wide, so foot depth is boosted to
// ~2.5× the foot's own width, and — since a foot's heel/ankle sits at the
// back, not the center — only the *extra* depth beyond the normal formula is
// added forward, keeping the heel aligned with the leg above it.
let headDepthMult = 1.1, bodyDepthMult = 1.2;
let headWidthCm3D = 0;
const groupColor3D = {
  head:0xf0c040, neck:0xf0c040, torso:0xffff99, waistbox:0xff9db9,
  arms:0x9fc4ff, hands:0x9fc4ff, legs:0xc9c9d4, feet:0xc9c9d4
};
let scene3D=null, camera3D=null, renderer3D=null, controls3D=null, bodyGroup3D=null;
let sceneInited3D=false, animating3D=false;
let meshRecords3D=[]; // {mesh, group, wCm, hCm}

const deg2rad = d => d * Math.PI / 180;

// Force the depth sliders back to their real defaults on every load — some
// browsers restore stale <input type=range> values from a previous session,
// which otherwise makes it look like the "default" depth silently drifted.
function resetDepthSlidersToDefault() {
  headDepthMult = 1.1; bodyDepthMult = 1.2;
  const headSlider = document.getElementById('depth-head'), headVal = document.getElementById('depth-head-val');
  const bodySlider = document.getElementById('depth-body'), bodyVal = document.getElementById('depth-body-val');
  if (headSlider) headSlider.value = '1.1';
  if (headVal) headVal.textContent = '1.1×';
  if (bodySlider) bodySlider.value = '1.2';
  if (bodyVal) bodyVal.textContent = '1.2×';
}
resetDepthSlidersToDefault();

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
  scene3D.add(bodyGroup3D);

  window.addEventListener('resize', resizeBody3D);
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

// Feet get boosted to ~this multiple of their own width for front-to-back depth.
const FOOT_DEPTH_WIDTH_MULT = 2.5;

// Depth (and, for feet, the forward z-shift needed to keep the heel aligned
// with the leg above it) for any non-head box, given the current sliders.
function computeBodyDepth3D(b) {
  const normalDepthCm = bodyDepthMult * headWidthCm3D + 0.25 * b.wCm;
  if (b.group !== 'feet') return { depthCm: normalDepthCm, zOffset: 0 };
  const footDepthCm = FOOT_DEPTH_WIDTH_MULT * b.wCm;
  const depthCm = Math.max(normalDepthCm, footDepthCm);
  return { depthCm, zOffset: (depthCm - normalDepthCm) / 2 };
}

// (Re)builds every box mesh from the current 2D layout. Called automatically
// every time "Generate" runs, and whenever a depth slider changes group multiplier.
function buildBody3D() {
  if (!sceneInited3D) initScene3D();
  while (bodyGroup3D.children.length) {
    disposeObject3D(bodyGroup3D.children.pop());
  }
  meshRecords3D = [];
  const { boxes, leftPivot, rightPivot, armRotated } = collectBodyBoxData3D();
  if (!boxes.length) return;

  // Arms/hands rotate as a rigid unit around the shoulder pivot, exactly like
  // the 2D "Rotate Arms Out 15°" option — mirrored sign because CSS rotation
  // is measured in a Y-down frame while our 3D scene is Y-up.
  const leftArmGroup = new THREE.Group();
  const rightArmGroup = new THREE.Group();
  if (leftPivot) {
    leftArmGroup.position.set(leftPivot.xCm, leftPivot.bottomCm, 0);
    leftArmGroup.rotation.z = deg2rad(armRotated ? -15 : 0);
  }
  if (rightPivot) {
    rightArmGroup.position.set(rightPivot.xCm, rightPivot.bottomCm, 0);
    rightArmGroup.rotation.z = deg2rad(armRotated ? 15 : 0);
  }
  bodyGroup3D.add(leftArmGroup, rightArmGroup);

  const headBox = boxes.find(b => b.group === 'head');
  headWidthCm3D = headBox ? headBox.wCm : (boxes[0] ? boxes[0].wCm : 1);

  let minY=Infinity, maxY=-Infinity;
  boxes.forEach(b => {
    const { depthCm, zOffset } = b.group === 'head'
      ? { depthCm: headDepthMult * b.wCm, zOffset: 0 }
      : computeBodyDepth3D(b);
    const mesh = makeBoxMesh(b, depthCm);
    const yCenter = b.bottomCm + b.hCm/2;

    if (b.side === 'left' && leftPivot) {
      mesh.position.set(b.xCm - leftPivot.xCm, yCenter - leftPivot.bottomCm, zOffset);
      leftArmGroup.add(mesh);
    } else if (b.side === 'right' && rightPivot) {
      mesh.position.set(b.xCm - rightPivot.xCm, yCenter - rightPivot.bottomCm, zOffset);
      rightArmGroup.add(mesh);
    } else {
      mesh.position.set(b.xCm, yCenter, zOffset);
      bodyGroup3D.add(mesh);
    }
    meshRecords3D.push({ mesh, group: b.group, wCm: b.wCm, hCm: b.hCm });
    minY = Math.min(minY, b.bottomCm); maxY = Math.max(maxY, b.bottomCm + b.hCm);
  });

  const centerY = (minY + maxY) / 2, totalHeight = maxY - minY;
  controls3D.target.set(0, centerY, 0);
  if (!buildBody3D._hasFramed) {
    camera3D.position.set(0, centerY, totalHeight * 1.6 + 60);
    buildBody3D._hasFramed = true;
  }
  controls3D.update();
}

function resizeMeshDepth(rec, newDepthCm, newZOffset = rec.mesh.position.z) {
  rec.mesh.geometry.dispose();
  rec.mesh.geometry = new THREE.BoxGeometry(rec.wCm, rec.hCm, newDepthCm);
  rec.mesh.children.forEach(c => {
    if (c.geometry) { c.geometry.dispose(); c.geometry = new THREE.EdgesGeometry(rec.mesh.geometry); }
  });
  rec.mesh.position.z = newZOffset;
}

// Head depth is relative to the head's own width — never the 2D width/height.
function updateHeadDepth(value) {
  headDepthMult = parseFloat(value);
  const valEl = document.getElementById('depth-head-val');
  if (valEl) valEl.textContent = headDepthMult.toFixed(1) + '×';
  meshRecords3D.forEach(rec => {
    if (rec.group !== 'head') return;
    resizeMeshDepth(rec, headDepthMult * rec.wCm);
  });
}

// Body depth base is one flat value, relative to the head's width — so
// widening the shoulders/waist never changes it — but each part then adds
// 0.25× its own width on top. Feet get boosted further (see
// computeBodyDepth3D) and shifted forward so the heel stays put.
function updateBodyDepth(value) {
  bodyDepthMult = parseFloat(value);
  const valEl = document.getElementById('depth-body-val');
  if (valEl) valEl.textContent = bodyDepthMult.toFixed(1) + '×';
  meshRecords3D.forEach(rec => {
    if (rec.group === 'head') return;
    const { depthCm, zOffset } = computeBodyDepth3D(rec);
    resizeMeshDepth(rec, depthCm, zOffset);
  });
}

function recenterBody3D() {
  if (!sceneInited3D || !meshRecords3D.length) return;
  buildBody3D._hasFramed = false;
  const worldPos = new THREE.Vector3();
  let minY=Infinity, maxY=-Infinity;
  meshRecords3D.forEach(rec => {
    rec.mesh.getWorldPosition(worldPos);
    minY = Math.min(minY, worldPos.y - rec.hCm/2);
    maxY = Math.max(maxY, worldPos.y + rec.hCm/2);
  });
  const centerY = (minY+maxY)/2, totalHeight = maxY-minY;
  camera3D.position.set(0, centerY, totalHeight * 1.6 + 60);
  controls3D.target.set(0, centerY, 0);
  controls3D.update();
}

function switchBodyView(view) {
  const el2D = document.getElementById('preview'), el3D = document.getElementById('preview3D');
  const btn2D = document.getElementById('view2DBtn'), btn3D = document.getElementById('view3DBtn');
  const depthPanel = document.getElementById('depthPanel');
  if (view === '3d') {
    el2D.style.display = 'none'; el3D.style.display = 'block'; depthPanel.style.display = 'block';
    btn2D.classList.remove('active'); btn3D.classList.add('active');
    if (!sceneInited3D) { initScene3D(); buildBody3D(); }
    requestAnimationFrame(resizeBody3D);
  } else {
    el2D.style.display = 'flex'; el3D.style.display = 'none'; depthPanel.style.display = 'none';
    btn3D.classList.remove('active'); btn2D.classList.add('active');
  }
}
