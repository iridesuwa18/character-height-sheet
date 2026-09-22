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
//   - depth sliders call updateHeadDepth(value) / updateBodyDepth(value) /
//     updateWaistlinePct(value)
//   - the Recenter button calls recenterBody3D()
//   - the Pose panel buttons call setPose3D('pose-key') (see POSES3D below)
// ═══════════════════════════════════════════════════════════════
const CM_PER_PX_3D = 1 / (PX_PER_CM * SCALE_FACTOR);
// Depth is anchored to the head's own width for most parts, not each part's
// own width — so a wider torso/shoulder setting doesn't balloon the torso's
// front-to-back depth. Head depth = headDepthMult × head's own width. Torso,
// waist/hip box & legs = (bodyDepthMult × head's width) + 0.25 × that part's
// own width. Neck & arms are pinned to their OWN width instead (1.2×) — a
// thick torso shouldn't inflate a thin neck or arm. Hands are pinned to
// their own width too but flatter (0.5×). Feet are boosted further to ~2×
// their own width (real feet are longer than wide), with only the *extra*
// depth pushed forward so the heel stays aligned with the leg above it.
// See computeBodyDepth3D().
let headDepthMult = 1.1, bodyDepthMult = 0.6;
// % of the waist/hip box's own width used as the pinch point when the
// hourglass waistline split is drawn (100% = no pinch, a straight box).
let waistlinePct = 100;
let headWidthCm3D = 0;
const groupColor3D = {
  head:0xf0c040, neck:0xf0c040, torso:0xffff99, waistbox:0xff9db9,
  arms:0x9fc4ff, hands:0x9fc4ff, legs:0xc9c9d4, feet:0xc9c9d4, joint:0xf2f2f2
};
let scene3D=null, camera3D=null, renderer3D=null, controls3D=null, bodyGroup3D=null, poseRootGroup3D=null;
let sceneInited3D=false, animating3D=false;
let meshRecords3D=[]; // {mesh, group, wCm, hCm}
let rig3D={}; // pivot groups from the last build: leftHip/rightHip, leftKnee/rightKnee,
              // leftAnkle/rightAnkle, leftShoulder/rightShoulder, leftElbow/rightElbow

const deg2rad = d => d * Math.PI / 180;

// ---- Poses ----------------------------------------------------------------
// Every joint angle is in degrees and describes how far THAT joint bends
// relative to its own parent segment (hip relative to the fixed pelvis, knee
// relative to the thigh, ankle relative to the shin, elbow relative to the
// upper arm). NEGATIVE hip/shoulder swings the limb FORWARD (toward the
// camera, +Z); positive swings it back. Because each child pivot inherits
// its parent's rotation, a knee value that's the exact opposite of the hip
// value cancels it out and leaves the shin hanging straight down again —
// that's how "shin stays vertical, foot stays flat" seated poses are built
// from two opposite numbers (e.g. hip:-90, knee:90). currentPose3D remembers
// the active pose so slider tweaks (which rebuild the whole mesh) can
// silently re-apply it instead of snapping back to a T-pose.
let currentPose3D = 'stand-relaxed';
const POSES3D = {
  'stand-relaxed':  { section:'Standing',             label:'Relaxed',           hip:0,   knee:0,   ankle:0,  shoulder:0,   elbow:0,   root:0 },
  'stand-arms-out': { section:'Standing',             label:'Arms Raised',       hip:0,   knee:0,   ankle:0,  shoulder:-85, elbow:0,   root:0 },
  'sit-chair':      { section:'Sitting',              label:'On a Chair',        hip:-90, knee:90,  ankle:0,  shoulder:-10, elbow:-40, root:0 },
  'sit-perch':      { section:'Sitting on Something',  label:'On a Stool/Ledge', hip:-75, knee:70,  ankle:5,  shoulder:-15, elbow:-35, root:0 },
  'sit-floor':      { section:'Sitting on the Floor',  label:'Legs Out Front',   hip:-90, knee:0,   ankle:90, shoulder:-20, elbow:-30, root:0 },
  'squat':          { section:'Squatting',            label:'Squat',             hip:-70, knee:45,  ankle:25, shoulder:-70, elbow:-40, root:0 },
  'squat-low':      { section:'Squatting',            label:'Deep/Resting Squat',hip:-95, knee:60,  ankle:35, shoulder:-60, elbow:-50, root:0 },
  'lie-back':       { section:'Lying Down',           label:'On Back',           hip:0,   knee:0,   ankle:0,  shoulder:-10, elbow:0,   root:-90 },
  'lie-front':      { section:'Lying Down',           label:'On Front',          hip:0,   knee:0,   ankle:0,  shoulder:-10, elbow:0,   root:90 },
};


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
  poseRootGroup3D = new THREE.Group();
  poseRootGroup3D.add(bodyGroup3D);
  scene3D.add(poseRootGroup3D);

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

// (Re)builds every box mesh from the current 2D layout. Called automatically
// every time "Generate" runs, and whenever a depth or waistline slider changes.
function buildBody3D() {
  if (!sceneInited3D) initScene3D();
  while (bodyGroup3D.children.length) {
    disposeObject3D(bodyGroup3D.children.pop());
  }
  meshRecords3D = [];
  rig3D = {};
  const { boxes, leftPivot, rightPivot, armRotated } = collectBodyBoxData3D();
  if (!boxes.length) return;

  const gender = document.getElementById('genderSelect')?.value === 'female' ? 'female' : 'male';

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
  rig3D.leftShoulder = leftArmGroup;
  rig3D.rightShoulder = rightArmGroup;

  const headBox = boxes.find(b => b.group === 'head');
  headWidthCm3D = headBox ? headBox.wCm : (boxes[0] ? boxes[0].wCm : 1);

  const torsoBox = boxes.find(b => b.group === 'torso');
  const waistBox = boxes.find(b => b.group === 'waistbox');

  let minY=Infinity, maxY=-Infinity;
  const noteY = (b) => { minY = Math.min(minY, b.bottomCm); maxY = Math.max(maxY, b.bottomCm + b.hCm); };

  // ---- Torso & hip/waist box: a plain rectangular box, or an hourglass
  // split into two trapezoids (pinched at the box's own vertical midpoint)
  // for whichever box matches the current gender. The pinch width is a % of
  // THAT box's own width, so 100% always reproduces the box's real width
  // (no pinch) regardless of how the torso and waist box widths compare. ----
  function addTorsoOrWaistBox(box, splitIt) {
    if (!box) return;
    const { depthCm, zOffset } = computeBodyDepth3D(box);
    if (!splitIt) {
      const mesh = makeBoxMesh(box, depthCm);
      mesh.position.set(box.xCm, box.bottomCm + box.hCm/2, zOffset);
      bodyGroup3D.add(mesh);
      meshRecords3D.push({ mesh, group: box.group, wCm: box.wCm, hCm: box.hCm });
      noteY(box);
      return;
    }
    const pinchWidthCm = (waistlinePct / 100) * box.wCm;
    const halfH = box.hCm / 2;
    const color = groupColor3D[box.group] || 0xaaaaaa;
    // Lower half: full width at the box's own bottom edge, pinched at the middle.
    const lower = makeTrapezoidMesh(pinchWidthCm, box.wCm, halfH, depthCm, color);
    lower.position.set(box.xCm, box.bottomCm + halfH/2, zOffset);
    bodyGroup3D.add(lower);
    meshRecords3D.push({ mesh: lower, group: box.group, wCm: box.wCm, hCm: halfH });
    // Upper half: full width at the box's own top edge, pinched at the middle.
    const upper = makeTrapezoidMesh(box.wCm, pinchWidthCm, halfH, depthCm, color);
    upper.position.set(box.xCm, box.bottomCm + halfH + halfH/2, zOffset);
    bodyGroup3D.add(upper);
    meshRecords3D.push({ mesh: upper, group: box.group, wCm: box.wCm, hCm: halfH });
    noteY(box);
  }
  addTorsoOrWaistBox(torsoBox, gender === 'male');
  addTorsoOrWaistBox(waistBox, gender === 'female');

  // ---- Everything else — just head & neck now. Arms/hands and legs/feet
  // are handled below separately so they can carry their joints and bend. ----
  boxes.forEach(b => {
    if (b.group === 'torso' || b.group === 'waistbox' || b.group === 'arms' || b.group === 'legs'
      || b.group === 'hands' || b.group === 'feet') return;
    let depthCm, zOffset = 0;
    if (b.group === 'head') { depthCm = headDepthMult * b.wCm; }
    else { const r = computeBodyDepth3D(b); depthCm = r.depthCm; zOffset = r.zOffset; }
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
    noteY(b);
  });

  // ---- Arms: split into upper arm / forearm at the elbow. The upper arm
  // sits directly in the shoulder-pivot group; the forearm AND hand sit in
  // a nested elbow-pivot group, so the elbow can bend independently of the
  // shoulder and the hand just follows along without bending on its own. ----
  function buildArmSide(group, pivot, side) {
    if (!pivot) return;
    const armBox = boxes.find(b => b.side === side && b.group === 'arms');
    if (!armBox) return;
    const handBox = boxes.find(b => b.side === side && b.group === 'hands');
    const armDepthCm = computeBodyDepth3D(armBox).depthCm;
    const armLocalX = armBox.xCm - pivot.xCm;
    const handHcm = handBox ? handBox.hCm : 0;
    // Elbow sits at (arm + hand length − half the hand length) ÷ 2 below the shoulder.
    const elbowOffsetCm = (armBox.hCm + handHcm/2) / 2;
    const upperH = elbowOffsetCm;
    const lowerH = armBox.hCm - upperH;

    const upper = makeBoxMesh({ wCm: armBox.wCm, hCm: upperH, group: 'arms' }, armDepthCm);
    upper.position.set(armLocalX, -upperH/2, 0);
    group.add(upper);
    meshRecords3D.push({ mesh: upper, group: 'arms', wCm: armBox.wCm, hCm: upperH });

    const shoulderJoint = makeJointSphere(armDepthCm);
    shoulderJoint.position.set(armLocalX, 0, 0);
    group.add(shoulderJoint);
    meshRecords3D.push({ mesh: shoulderJoint, group: 'joint', wCm: armDepthCm, hCm: armDepthCm });

    // Elbow pivot: forearm + hand hang from here, in their own local frame
    // (y=0 at the elbow), so a pose can bend the elbow on top of whatever
    // the shoulder is doing.
    const elbowGroup = new THREE.Group();
    elbowGroup.position.set(armLocalX, -upperH, 0);
    group.add(elbowGroup);

    const lower = makeBoxMesh({ wCm: armBox.wCm, hCm: lowerH, group: 'arms' }, armDepthCm);
    lower.position.set(0, -lowerH/2, 0);
    elbowGroup.add(lower);
    meshRecords3D.push({ mesh: lower, group: 'arms', wCm: armBox.wCm, hCm: lowerH });

    const elbowJoint = makeJointSphere(armDepthCm);
    elbowJoint.position.set(0, 0, 0);
    elbowGroup.add(elbowJoint);
    meshRecords3D.push({ mesh: elbowJoint, group: 'joint', wCm: armDepthCm, hCm: armDepthCm });

    if (handBox) {
      const handDepthCm = computeBodyDepth3D(handBox).depthCm;
      const hand = makeBoxMesh({ wCm: handBox.wCm, hCm: handBox.hCm, group: 'hands' }, handDepthCm);
      hand.position.set(0, -lowerH - handBox.hCm/2, 0);
      elbowGroup.add(hand);
      meshRecords3D.push({ mesh: hand, group: 'hands', wCm: handBox.wCm, hCm: handBox.hCm });
    }

    noteY(armBox);
    rig3D[side + 'Elbow'] = elbowGroup;
  }
  buildArmSide(leftArmGroup, leftPivot, 'left');
  buildArmSide(rightArmGroup, rightPivot, 'right');

  // ---- Legs: split at the knee (the exact vertical midpoint of the leg
  // box — this already matches where the 2D "Knee line" is drawn). Thigh
  // hangs from a hip pivot; shin hangs from a knee pivot nested inside the
  // hip pivot; the foot hangs from an ankle pivot nested inside the knee
  // pivot — so each joint can bend independently for poses. ----
  function buildLeg(legBox) {
    const legDepthCm = computeBodyDepth3D(legBox).depthCm;
    // Knee & ankle joints are sized off the leg box's own WIDTH, not its
    // depth — the old depth-matched spheres were oversized.
    const legJointCm = legBox.wCm;
    // Hip joint is sized off half the DEPTH of the waist/hip box.
    const hipJointCm = 0.5 * (waistBox ? computeBodyDepth3D(waistBox).depthCm : legDepthCm);
    const halfH = legBox.hCm / 2; // thigh height == shin height
    const hipY = legBox.bottomCm + legBox.hCm;
    const side = legBox.xCm < 0 ? 'left' : 'right';

    // Hip pivot: thigh + knee + shin + ankle + foot all hang from here, at
    // the leg's own (narrower) centerline, so the whole leg swings as a unit.
    const hipGroup = new THREE.Group();
    hipGroup.position.set(legBox.xCm, hipY, 0);
    bodyGroup3D.add(hipGroup);
    rig3D[side + 'Hip'] = hipGroup;

    const thigh = makeBoxMesh({ wCm: legBox.wCm, hCm: halfH, group: 'legs' }, legDepthCm);
    thigh.position.set(0, -halfH/2, 0);
    hipGroup.add(thigh);
    meshRecords3D.push({ mesh: thigh, group: 'legs', wCm: legBox.wCm, hCm: halfH });

    // Hip joint sphere: fixed to the pelvis (NOT the hip pivot), sitting on
    // the waist/hip box's own side edge, so it stays put in its socket while
    // the leg swings beneath it. Its center sits exactly on that edge, so
    // roughly half the sphere pokes out past the box's side.
    const sideSign = Math.sign(legBox.xCm) || 1;
    const hipSphereX = waistBox ? waistBox.xCm + sideSign * (waistBox.wCm / 2) : legBox.xCm;
    const hip = makeJointSphere(hipJointCm);
    hip.position.set(hipSphereX, hipY, 0);
    bodyGroup3D.add(hip);
    meshRecords3D.push({ mesh: hip, group: 'joint', wCm: hipJointCm, hCm: hipJointCm });

    // Knee pivot: shin + ankle + foot hang from here, local y=0 at the knee.
    const kneeGroup = new THREE.Group();
    kneeGroup.position.set(0, -halfH, 0);
    hipGroup.add(kneeGroup);
    rig3D[side + 'Knee'] = kneeGroup;

    const shin = makeBoxMesh({ wCm: legBox.wCm, hCm: halfH, group: 'legs' }, legDepthCm);
    shin.position.set(0, -halfH/2, 0);
    kneeGroup.add(shin);
    meshRecords3D.push({ mesh: shin, group: 'legs', wCm: legBox.wCm, hCm: halfH });

    const knee = makeJointSphere(legJointCm);
    knee.position.set(0, 0, 0);
    kneeGroup.add(knee);
    meshRecords3D.push({ mesh: knee, group: 'joint', wCm: legJointCm, hCm: legJointCm });

    // Ankle pivot: the foot hangs from here, local y=0 at the ankle.
    const ankleGroup = new THREE.Group();
    ankleGroup.position.set(0, -halfH, 0);
    kneeGroup.add(ankleGroup);
    rig3D[side + 'Ankle'] = ankleGroup;

    const ankle = makeJointSphere(legJointCm);
    ankle.position.set(0, 0, 0);
    ankleGroup.add(ankle);
    meshRecords3D.push({ mesh: ankle, group: 'joint', wCm: legJointCm, hCm: legJointCm });

    const footBox = boxes.find(b => b.group === 'feet' && Math.sign(b.xCm) === Math.sign(legBox.xCm));
    if (footBox) {
      const { depthCm: footDepthCm, zOffset: footZOffset } = computeBodyDepth3D(footBox);
      const foot = makeBoxMesh({ wCm: footBox.wCm, hCm: footBox.hCm, group: 'feet' }, footDepthCm);
      // Foot's top sits at the ankle; it hangs straight down from there by
      // default, pushed forward the same way it always was.
      foot.position.set(0, -footBox.hCm/2, footZOffset);
      ankleGroup.add(foot);
      meshRecords3D.push({ mesh: foot, group: 'feet', wCm: footBox.wCm, hCm: footBox.hCm });
    }

    noteY(legBox);
  }
  boxes.filter(b => b.group === 'legs').forEach(buildLeg);

  const centerY = (minY + maxY) / 2, totalHeight = maxY - minY;
  controls3D.target.set(0, centerY, 0);
  if (!buildBody3D._hasFramed) {
    camera3D.position.set(0, centerY, totalHeight * 1.6 + 60);
    buildBody3D._hasFramed = true;
  }
  controls3D.update();

  // Rebuilding wipes every pivot's rotation back to 0, so silently
  // re-apply whichever pose was active (without yanking the camera —
  // that only happens when the person explicitly picks a pose).
  applyPose3D(currentPose3D, { reframe: false });
}

// Sets every joint pivot's rotation from a POSES3D entry, tilts the whole
// body for lying poses, and re-grounds the model so its lowest point always
// rests at y=0 (the floor) — whichever part that turns out to be (feet for
// a standing/seated pose, the back of the torso for lying down, etc). Pass
// { reframe:true } to also re-fit the camera to the new silhouette, which
// setPose3D() does for an explicit pose pick; buildBody3D()'s automatic
// re-apply after a rebuild does not, so it doesn't disturb the camera.
function applyPose3D(poseName, { reframe = false } = {}) {
  const pose = POSES3D[poseName] || POSES3D['stand-relaxed'];
  currentPose3D = POSES3D[poseName] ? poseName : 'stand-relaxed';
  const setX = (grp, deg) => { if (grp) grp.rotation.x = deg2rad(deg || 0); };
  setX(rig3D.leftHip, pose.hip);     setX(rig3D.rightHip, pose.hip);
  setX(rig3D.leftKnee, pose.knee);   setX(rig3D.rightKnee, pose.knee);
  setX(rig3D.leftAnkle, pose.ankle); setX(rig3D.rightAnkle, pose.ankle);
  setX(rig3D.leftShoulder, pose.shoulder); setX(rig3D.rightShoulder, pose.shoulder);
  setX(rig3D.leftElbow, pose.elbow);       setX(rig3D.rightElbow, pose.elbow);
  if (poseRootGroup3D) poseRootGroup3D.rotation.x = deg2rad(pose.root || 0);
  groundBody3D(reframe);
}

// Re-grounds the posed model (translates poseRootGroup3D vertically so the
// model's lowest point touches y=0, whatever part that is for the current
// pose) using a real world-space bounding box — robust to any combination
// of joint and root rotation, unlike a per-box half-height estimate.
// Optionally also re-fits the camera to the new silhouette.
function groundBody3D(reframe) {
  if (!poseRootGroup3D || !bodyGroup3D || !meshRecords3D.length) return;
  poseRootGroup3D.position.y = 0;
  poseRootGroup3D.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(bodyGroup3D);
  if (!isFinite(box.min.y)) return;
  poseRootGroup3D.position.y = -box.min.y;
  poseRootGroup3D.updateMatrixWorld(true);
  if (reframe) {
    const box2 = new THREE.Box3().setFromObject(bodyGroup3D);
    const center = box2.getCenter(new THREE.Vector3());
    const size = box2.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.y, size.z) * 1.6 + 60;
    controls3D.target.set(center.x, center.y, center.z);
    camera3D.position.set(center.x, center.y, center.z + dist);
    controls3D.update();
  }
}

// Builds the Pose panel's buttons from POSES3D, grouped into the labeled
// sections each entry declares (Standing, Sitting, Squatting, etc) — add a
// new pose to POSES3D and it shows up here automatically, no HTML to touch.
function renderPosePanel3D() {
  const container = document.getElementById('poseSections');
  if (!container) return;
  const sections = {};
  Object.keys(POSES3D).forEach(key => {
    const pose = POSES3D[key];
    (sections[pose.section] = sections[pose.section] || []).push({ key, ...pose });
  });
  container.innerHTML = Object.keys(sections).map(sectionName => `
    <div class="pose-section">
      <div class="pose-section-title">${sectionName}</div>
      <div class="pose-btn-row">
        ${sections[sectionName].map(p => `<button type="button" class="pose-btn${p.key === currentPose3D ? ' active' : ''}" data-pose="${p.key}" onclick="setPose3D('${p.key}')">${p.label}</button>`).join('')}
      </div>
    </div>
  `).join('');
}
renderPosePanel3D();

// Called from the Pose panel buttons: switches to a named pose, snaps it to
// the floor, and re-frames the camera to the new silhouette.
function setPose3D(poseName) {
  if (!sceneInited3D || !meshRecords3D.length) return;
  applyPose3D(poseName, { reframe: true });
  document.querySelectorAll('.pose-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pose === currentPose3D);
  });
}


// Head depth is relative to the head's own width — never the 2D width/height.
// (Head is always a plain box, so an in-place geometry resize is safe here.)
function updateHeadDepth(value) {
  headDepthMult = parseFloat(value);
  const valEl = document.getElementById('depth-head-val');
  if (valEl) valEl.textContent = headDepthMult.toFixed(1) + '×';
  meshRecords3D.forEach(rec => {
    if (rec.group !== 'head') return;
    rec.mesh.geometry.dispose();
    rec.mesh.geometry = new THREE.BoxGeometry(rec.wCm, rec.hCm, headDepthMult * rec.wCm);
    rec.mesh.children.forEach(c => {
      if (c.geometry) { c.geometry.dispose(); c.geometry = new THREE.EdgesGeometry(rec.mesh.geometry); }
    });
  });
}

// Body depth affects torso/waist/legs/feet (and, via the hourglass
// split, tapers into trapezoid meshes rather than plain boxes) — a mix of
// geometry types that can't all be resized in place, so this just rebuilds
// the whole model from the current 2D layout.
function updateBodyDepth(value) {
  bodyDepthMult = parseFloat(value);
  const valEl = document.getElementById('depth-body-val');
  if (valEl) valEl.textContent = bodyDepthMult.toFixed(1) + '×';
  buildBody3D();
}

// Hourglass pinch amount, as a % of the waist/hip box's own width. Rebuilds
// for the same reason as updateBodyDepth (trapezoid geometry, not a resize).
function updateWaistlinePct(value) {
  waistlinePct = parseFloat(value);
  const valEl = document.getElementById('waistline-pct-val');
  if (valEl) valEl.textContent = Math.round(waistlinePct) + '%';
  buildBody3D();
}

function recenterBody3D() {
  if (!sceneInited3D || !meshRecords3D.length) return;
  buildBody3D._hasFramed = false;
  groundBody3D(true);
}

function switchBodyView(view) {
  const el2D = document.getElementById('preview'), el3D = document.getElementById('preview3D');
  const btn2D = document.getElementById('view2DBtn'), btn3D = document.getElementById('view3DBtn');
  const depthPanel = document.getElementById('depthPanel');
  const posePanel = document.getElementById('posePanel');
  if (view === '3d') {
    el2D.style.display = 'none'; el3D.style.display = 'block'; depthPanel.style.display = 'block';
    if (posePanel) posePanel.style.display = 'block';
    btn2D.classList.remove('active'); btn3D.classList.add('active');
    if (!sceneInited3D) { initScene3D(); buildBody3D(); }
    requestAnimationFrame(resizeBody3D);
  } else {
    el2D.style.display = 'flex'; el3D.style.display = 'none'; depthPanel.style.display = 'none';
    if (posePanel) posePanel.style.display = 'none';
    btn3D.classList.remove('active'); btn2D.classList.add('active');
  }
}
