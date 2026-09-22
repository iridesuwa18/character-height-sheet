// ═══════════════════════════════════════════════════════════════
// 3d_character.js
// Extrudes the 2D body-proportion boxes (Character Height Sheet, Body tab)
// into a real, orbit-able 3D model using Three.js.
//
// Depends on globals defined in index.html's inline script, which must load
// BEFORE this file: PX_PER_CM, SCALE_FACTOR, preview (the #preview element).
// Also depends on THREE and THREE.OrbitControls being loaded first.
//
// Called from index.html:
//   - generateHeight() calls buildBody3D() at the end of every Generate
//   - switchBodyView('3d'|'2d') toggles the #preview / #preview3D containers
//   - depth sliders call updateGroupDepth(group, value)
//   - the Recenter button calls recenterBody3D()
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════
// BODY 3D VIEW — extrudes the 2D boxes into a real 3D model
// ═══════════════════════════════════════
const CM_PER_PX_3D = 1 / (PX_PER_CM * SCALE_FACTOR);
const groupDepthMult = { head:1.5, neck:1.5, torso:1.5, waistbox:1.5, arms:1.5, hands:1.5, legs:1.5, feet:1.5 };
const groupColor3D = {
  head:0xf0c040, neck:0xf0c040, torso:0xffff99, waistbox:0xff9db9,
  arms:0x9fc4ff, hands:0x9fc4ff, legs:0xc9c9d4, feet:0xc9c9d4
};
let scene3D=null, camera3D=null, renderer3D=null, controls3D=null, bodyGroup3D=null;
let sceneInited3D=false, animating3D=false;
let meshRecords3D=[]; // {mesh, group, wCm, hCm}

// Pull the exact rendered geometry of every generated box (in cm, centered on the
// character's vertical midline, y=0 at the ground/PADDING_PX baseline).
function collectBodyBoxData3D() {
  const previewRect = preview.getBoundingClientRect();
  const boxEls = preview.querySelectorAll('.head-box, .neck-box, .torso-box, .waist-box, .leg-box');
  const boxes = [];
  boxEls.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return; // skip the zero-width divider div
    const group = el.dataset.group || 'other';
    const xCm = (r.left - previewRect.left + r.width/2 - previewRect.width/2) * CM_PER_PX_3D;
    const bottomCm = (previewRect.bottom - r.bottom) * CM_PER_PX_3D;
    const wCm = r.width * CM_PER_PX_3D;
    const hCm = r.height * CM_PER_PX_3D;
    boxes.push({ group, xCm, bottomCm, wCm, hCm });
  });
  return boxes;
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

// (Re)builds every box mesh from the current 2D layout. Called automatically
// every time "Generate" runs, and whenever a depth slider changes group multiplier.
function buildBody3D() {
  if (!sceneInited3D) initScene3D();
  while (bodyGroup3D.children.length) {
    const m = bodyGroup3D.children.pop();
    m.geometry.dispose(); m.material.dispose();
  }
  meshRecords3D = [];
  const boxes = collectBodyBoxData3D();
  if (!boxes.length) return;

  let minY=Infinity, maxY=-Infinity;
  boxes.forEach(b => {
    const depthCm = groupDepthMult[b.group] * Math.min(b.wCm, b.hCm);
    const geo = new THREE.BoxGeometry(b.wCm, b.hCm, depthCm);
    const mat = new THREE.MeshStandardMaterial({
      color: groupColor3D[b.group] || 0xaaaaaa, roughness: 0.6, metalness: 0.05,
      transparent: true, opacity: 0.92
    });
    const mesh = new THREE.Mesh(geo, mat);
    const yCenter = b.bottomCm + b.hCm/2;
    mesh.position.set(b.xCm, yCenter, 0);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color:0x000000, transparent:true, opacity:0.35 }));
    mesh.add(edges);
    bodyGroup3D.add(mesh);
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

// Only touches the z-depth of a group's boxes — never the 2D width/height.
function updateGroupDepth(group, value) {
  const mult = parseFloat(value);
  groupDepthMult[group] = mult;
  const valEl = document.getElementById(`depth-${group}-val`);
  if (valEl) valEl.textContent = mult.toFixed(1) + '×';
  meshRecords3D.forEach(rec => {
    if (rec.group !== group) return;
    const newDepth = mult * Math.min(rec.wCm, rec.hCm);
    rec.mesh.geometry.dispose();
    rec.mesh.geometry = new THREE.BoxGeometry(rec.wCm, rec.hCm, newDepth);
    rec.mesh.children.forEach(c => { c.geometry.dispose(); c.geometry = new THREE.EdgesGeometry(rec.mesh.geometry); });
  });
}

function recenterBody3D() {
  if (!sceneInited3D || !meshRecords3D.length) return;
  buildBody3D._hasFramed = false;
  let minY=Infinity, maxY=-Infinity;
  meshRecords3D.forEach(rec => { minY = Math.min(minY, rec.mesh.position.y - rec.hCm/2); maxY = Math.max(maxY, rec.mesh.position.y + rec.hCm/2); });
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
