// ── joint-faces-panel.js ──────────────────────────────────────────────────
// The Faces popup (▦, next to ⚙ and ⇄ in the Joint Editor toolbar): pick a
// mesh group — every mesh in it is tinted a saturated green with a glowing
// purple edge outline — then pick one of its six box faces on top of that —
// every matching face is tinted a saturated pink. The Face dropdown is
// disabled until a mesh is chosen.
//
// This never touches the target meshes' own materials — other code already
// mutates those live (e.g. applyHandFlipVisuals3D recolors the forearm mesh
// red/blue for palm/dorsum on every pose change), so reassigning material
// there would either get silently overwritten or, if turned into a
// per-face material array, crash the very next pose update. Instead every
// highlight here is a separate, purely-visual overlay mesh (a translucent
// prism for the mesh tint, a translucent plane/trapezoid for the face
// tint), parented directly onto the target mesh so it always tracks it.
// Every overlay is built from the mesh's own real vertex data (see
// facesMeshOutline3D) rather than its bounding box, so it correctly follows
// a tapered piece's slanted shape instead of just enclosing it in a
// rectangle — see the comment on facesMeshOutline3D and addFacesFaceOverlay3D
// for how each shape is derived.
// Purely an inspection/highlight layer for now — the face-anchored pinning
// system builds on top of this next.
// Shares one global scope with the other files below (plain <script> tags,
// no modules) — load order matters, see index.html.

const FACES_MESH_COLOR = 0x5fbf7a;    // desaturated green
const FACES_OUTLINE_COLOR = 0xb833ff; // glowing purple
const FACES_FACE_COLOR = 0xff2fa0;    // saturated pink
// All overlay object names share this prefix so other code (see the head
// depth slider's cleanup in body-build-pose.js) can reliably tell "one of
// the Faces panel's overlays" apart from a mesh's own real children, rather
// than guessing by object type.
const FACES_OVERLAY_PREFIX = '__facesOverlay:';
const FACES_MESH_TINT_NAME = FACES_OVERLAY_PREFIX + 'meshTint';
const FACES_FACE_TINT_NAME = FACES_OVERLAY_PREFIX + 'faceTint';
const FACES_OUTLINE_CORE_NAME = FACES_OVERLAY_PREFIX + 'outlineCore';
const FACES_OUTLINE_HALO_NAME = FACES_OVERLAY_PREFIX + 'outlineHalo';

let facesSelectedMeshGroup3D = null; // e.g. 'torso' | null
let facesSelectedFace3D = null;      // e.g. 'front' | null

function removeFacesOverlay3D(mesh, name) {
  const existing = mesh.children.find(c => c.name === name);
  if (!existing) return;
  mesh.remove(existing);
  existing.geometry.dispose();
  existing.material.dispose();
}

// Samples the geometry's real vertex positions — rather than trusting its
// axis-aligned bounding box — to find the exact left/right X extent at the
// bottom (min Y) and top (max Y) of a mesh: the two flat cross-sections
// every one of these body-part prisms has, whether it's a plain box (same
// extent top and bottom) or one of the hourglass waistline's tapered
// trapezoids (narrower at one end, per makeTrapezoidMesh in body-scene.js).
// This one routine is what lets every overlay below match a tapered mesh's
// real slanted shape instead of just its rectangular bounding box.
function facesMeshOutline3D(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const eps = Math.max((bb.max.y - bb.min.y) * 0.002, 0.01);
  const pos = geo.attributes.position;
  const extentAtY = (targetY) => {
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - targetY) <= eps) {
        const x = pos.getX(i);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    return minX === Infinity ? { minX: bb.min.x, maxX: bb.max.x } : { minX, maxX };
  };
  return {
    minY: bb.min.y, maxY: bb.max.y, minZ: bb.min.z, maxZ: bb.max.z,
    bottom: extentAtY(bb.min.y), top: extentAtY(bb.max.y),
  };
}

// A translucent overlay that traces the mesh's own real silhouette (not
// just its bounding box) enlarged by a small margin — a box for a plain
// box, an actual tapered prism for a trapezoid piece — via the same
// Shape+ExtrudeGeometry approach the trapezoid meshes themselves are built
// with (see makeTrapezoidMesh in body-scene.js), just fed real widths read
// off the mesh instead of the design-time ones. Parented onto the mesh so
// it moves/rotates with it automatically.
function addFacesMeshOverlay3D(mesh, outline) {
  removeFacesOverlay3D(mesh, FACES_MESH_TINT_NAME);
  const o = outline;
  // Depth-testing is off on this material (see below), so there's no more
  // z-fighting reason to puff the overlay out past the real surface — the
  // margin here is now just a hairline (a fixed, tiny constant) rather than
  // a size-scaled clearance, so it hugs the mesh instead of visibly floating
  // outside it.
  const marginXY = 0.002;
  const marginZ = 0.002;
  const shape = new THREE.Shape();
  shape.moveTo(o.bottom.minX - marginXY, o.minY - marginXY);
  shape.lineTo(o.bottom.maxX + marginXY, o.minY - marginXY);
  shape.lineTo(o.top.maxX + marginXY, o.maxY + marginXY);
  shape.lineTo(o.top.minX - marginXY, o.maxY + marginXY);
  shape.closePath();
  const depth = (o.maxZ - o.minZ) + marginZ * 2;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, o.minZ - marginZ); // shape's X/Y are already mesh-local; only Z needs placing
  // depthTest: false means this always draws on top of the real mesh
  // underneath it, so it no longer needs a real-world offset to stay
  // visible — that's what let the margin above shrink to a hairline.
  const mat = new THREE.MeshBasicMaterial({ color: FACES_MESH_COLOR, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const overlay = new THREE.Mesh(geo, mat);
  overlay.name = FACES_MESH_TINT_NAME;
  overlay.renderOrder = 1;
  mesh.add(overlay);
}

// A glowing purple outline traced along the mesh's own real edges — this
// already uses THREE.EdgesGeometry(mesh.geometry) directly rather than the
// bounding box, so it already hugs a tapered trapezoid's actual slanted
// silhouette correctly with no changes needed here.
// "Glow" is faked the usual way for a plain WebGLRenderer with no
// post-processing/bloom pass here: a crisp core line plus a second,
// slightly-enlarged, more-transparent, additively-blended copy behind it —
// the halo. The enlargement lives on the halo's own transform (scale), not
// baked into its geometry, so it survives a geometry swap untouched.
function addFacesOutlineOverlay3D(mesh) {
  removeFacesOverlay3D(mesh, FACES_OUTLINE_CORE_NAME);
  removeFacesOverlay3D(mesh, FACES_OUTLINE_HALO_NAME);
  const coreGeo = new THREE.EdgesGeometry(mesh.geometry);
  const coreMat = new THREE.LineBasicMaterial({ color: FACES_OUTLINE_COLOR, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false });
  const core = new THREE.LineSegments(coreGeo, coreMat);
  core.name = FACES_OUTLINE_CORE_NAME;
  core.renderOrder = 2;
  mesh.add(core);

  const haloGeo = new THREE.EdgesGeometry(mesh.geometry);
  const haloMat = new THREE.LineBasicMaterial({ color: FACES_OUTLINE_COLOR, transparent: true, opacity: 0.35, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.LineSegments(haloGeo, haloMat);
  halo.name = FACES_OUTLINE_HALO_NAME;
  halo.scale.multiplyScalar(1.03);
  halo.renderOrder = 2;
  mesh.add(halo);
}

// One face overlay per face name, all built from the mesh's real per-level
// corners (see facesMeshOutline3D) rather than a rectangle assumed from the
// bounding box:
//  - top/bottom: a flat rectangle at that end's own real width (which can
//    differ from the other end's, on a tapered piece) spanning the full depth.
//  - front/back: the mesh's own actual cap shape — a rectangle for a plain
//    box, a genuine trapezoid outline for a tapered piece — traced from its
//    real corners, so two adjacent tapered pieces (e.g. the male torso's
//    upper/lower pinch halves) visibly meet and merge at their shared,
//    narrowest seam rather than each showing a full-width rectangle there.
//  - left/right: the slanted side surface itself, tilted to converge toward
//    the narrow end on a tapered piece — built from an actual 3-axis basis
//    (the constant depth direction, the real bottom→top slant direction,
//    and their cross product as the outward normal) rather than assumed to
//    be a flat vertical plane, which is what this basis reduces to anyway
//    on a plain (untapered) box.
function addFacesFaceOverlay3D(mesh, faceName, outline) {
  removeFacesOverlay3D(mesh, FACES_FACE_TINT_NAME);
  if (!faceName) return;
  const o = outline;
  // Same reasoning as the mesh-tint overlay above: depthTest is off on this
  // material, so it no longer needs a size-scaled clearance to avoid
  // z-fighting with the real face underneath it — a fixed hairline is
  // enough, which is what keeps this sitting flush on the actual surface
  // instead of visibly floating off it.
  const eps = 0.002;
  const mat = () => new THREE.MeshBasicMaterial({ color: FACES_FACE_COLOR, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  let overlay;

  if (faceName === 'front' || faceName === 'back') {
    const shape = new THREE.Shape();
    shape.moveTo(o.bottom.minX, o.minY);
    shape.lineTo(o.bottom.maxX, o.minY);
    shape.lineTo(o.top.maxX, o.maxY);
    shape.lineTo(o.top.minX, o.maxY);
    shape.closePath();
    overlay = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat());
    overlay.position.z = faceName === 'front' ? o.maxZ + eps : o.minZ - eps;

  } else if (faceName === 'top' || faceName === 'bottom') {
    const atTop = faceName === 'top';
    const level = atTop ? o.top : o.bottom;
    const w = Math.max(level.maxX - level.minX, 0.01), cx = (level.maxX + level.minX) / 2;
    overlay = new THREE.Mesh(new THREE.PlaneGeometry(w, Math.max(o.maxZ - o.minZ, 0.01)), mat());
    overlay.rotation.x = atTop ? -Math.PI / 2 : Math.PI / 2;
    overlay.position.set(cx, (atTop ? o.maxY : o.minY) + (atTop ? eps : -eps), (o.minZ + o.maxZ) / 2);

  } else if (faceName === 'left' || faceName === 'right') {
    const isLeft = faceName === 'left';
    const bx = isLeft ? o.bottom.minX : o.bottom.maxX;
    const tx = isLeft ? o.top.minX : o.top.maxX;
    const dx = tx - bx, dy = o.maxY - o.minY;
    const slantLen = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const heightDir = new THREE.Vector3(dx, dy, 0).normalize();
    const widthDir = new THREE.Vector3(0, 0, 1);
    // Order swapped between left/right so the cross product's outward
    // direction comes out correct for each side without a separate flip step.
    const normal = isLeft
      ? new THREE.Vector3().crossVectors(widthDir, heightDir).normalize()
      : new THREE.Vector3().crossVectors(heightDir, widthDir).normalize();
    const basis = new THREE.Matrix4().makeBasis(widthDir, heightDir, normal);
    overlay = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(o.maxZ - o.minZ, 0.01), slantLen), mat());
    overlay.quaternion.setFromRotationMatrix(basis);
    overlay.position.set(
      (bx + tx) / 2 + normal.x * eps,
      (o.minY + o.maxY) / 2 + normal.y * eps,
      (o.minZ + o.maxZ) / 2 + normal.z * eps,
    );
  } else {
    return;
  }
  overlay.name = FACES_FACE_TINT_NAME;
  overlay.renderOrder = 3;
  mesh.add(overlay);
}

function clearFacesHighlight3D() {
  meshRecords3D.forEach(r => {
    removeFacesOverlay3D(r.mesh, FACES_MESH_TINT_NAME);
    removeFacesOverlay3D(r.mesh, FACES_OUTLINE_CORE_NAME);
    removeFacesOverlay3D(r.mesh, FACES_OUTLINE_HALO_NAME);
    removeFacesOverlay3D(r.mesh, FACES_FACE_TINT_NAME);
  });
}
function applyFacesHighlight3D() {
  clearFacesHighlight3D();
  if (!facesSelectedMeshGroup3D || !meshRecords3D.length) return;
  meshRecords3D.filter(r => r.group === facesSelectedMeshGroup3D).forEach(r => {
    const outline = facesMeshOutline3D(r.mesh.geometry);
    addFacesMeshOverlay3D(r.mesh, outline);
    addFacesOutlineOverlay3D(r.mesh);
    addFacesFaceOverlay3D(r.mesh, facesSelectedFace3D, outline);
  });
}

function onFacesMeshChange3D(value) {
  facesSelectedMeshGroup3D = value || null;
  facesSelectedFace3D = null;
  const faceSel = document.getElementById('facesFaceSelect');
  if (faceSel) { faceSel.value = ''; faceSel.disabled = !facesSelectedMeshGroup3D; }
  applyFacesHighlight3D();
}
function onFacesFaceChange3D(value) {
  if (!facesSelectedMeshGroup3D) return; // dropdown is disabled until a mesh is picked, but guard anyway
  facesSelectedFace3D = value || null;
  applyFacesHighlight3D();
}

// Called whenever the underlying meshes are about to be thrown away (a
// rebuild) or the editor is closed — either way, the overlays and the
// selection they were based on are no longer valid/relevant.
function resetFacesSelection3D() {
  clearFacesHighlight3D();
  facesSelectedMeshGroup3D = null;
  facesSelectedFace3D = null;
  const meshSel = document.getElementById('facesMeshSelect'); if (meshSel) meshSel.value = '';
  const faceSel = document.getElementById('facesFaceSelect'); if (faceSel) { faceSel.value = ''; faceSel.disabled = true; }
}
function openFacesPopup3D() {
  const el = document.getElementById('jeFacesPopup');
  if (el) el.classList.add('open');
}
function closeFacesPopup3D() {
  const el = document.getElementById('jeFacesPopup');
  if (el) el.classList.remove('open');
}
