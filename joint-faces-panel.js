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
// box for the mesh tint, a translucent plane for the face tint), parented
// directly onto the target mesh so it always tracks it, and sized off the
// mesh's own real bounding box rather than stored dimensions — which is
// what makes this work uniformly for both plain boxes and the hourglass
// waistline's tapered trapezoids without any per-shape-special-casing.
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

// A translucent box, sized to the mesh's own bounding box (with a small
// outward margin to avoid z-fighting with the mesh's real surface),
// parented onto the mesh so it moves/rotates with it automatically.
function addFacesMeshOverlay3D(mesh) {
  removeFacesOverlay3D(mesh, FACES_MESH_TINT_NAME);
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const sx = (bb.max.x - bb.min.x) * 1.02, sy = (bb.max.y - bb.min.y) * 1.02, sz = (bb.max.z - bb.min.z) * 1.02;
  const cx = (bb.max.x + bb.min.x) / 2, cy = (bb.max.y + bb.min.y) / 2, cz = (bb.max.z + bb.min.z) / 2;
  const geo = new THREE.BoxGeometry(Math.max(sx, 0.01), Math.max(sy, 0.01), Math.max(sz, 0.01));
  const mat = new THREE.MeshBasicMaterial({ color: FACES_MESH_COLOR, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  const overlay = new THREE.Mesh(geo, mat);
  overlay.name = FACES_MESH_TINT_NAME;
  overlay.position.set(cx, cy, cz);
  mesh.add(overlay);
}

// A glowing purple outline traced along the mesh's own real edges — unlike
// the tint box/face plane above, this uses THREE.EdgesGeometry(mesh.geometry)
// directly rather than the bounding box, so it hugs the actual silhouette
// (useful once the hourglass waistline's tapered trapezoids are involved,
// where a bounding-box outline would visibly float off the tapered sides).
// "Glow" is faked the usual way for a plain WebGLRenderer with no
// post-processing/bloom pass here: a crisp core line plus a second,
// slightly-enlarged, more-transparent, additively-blended copy behind it —
// the halo. The enlargement lives on the halo's own transform (scale), not
// baked into its geometry, so it survives a geometry swap untouched.
function addFacesOutlineOverlay3D(mesh) {
  removeFacesOverlay3D(mesh, FACES_OUTLINE_CORE_NAME);
  removeFacesOverlay3D(mesh, FACES_OUTLINE_HALO_NAME);
  const coreGeo = new THREE.EdgesGeometry(mesh.geometry);
  const coreMat = new THREE.LineBasicMaterial({ color: FACES_OUTLINE_COLOR, transparent: true, opacity: 0.95, depthWrite: false });
  const core = new THREE.LineSegments(coreGeo, coreMat);
  core.name = FACES_OUTLINE_CORE_NAME;
  mesh.add(core);

  const haloGeo = new THREE.EdgesGeometry(mesh.geometry);
  const haloMat = new THREE.LineBasicMaterial({ color: FACES_OUTLINE_COLOR, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.LineSegments(haloGeo, haloMat);
  halo.name = FACES_OUTLINE_HALO_NAME;
  halo.scale.multiplyScalar(1.03);
  mesh.add(halo);
}

// Face name → an overlay plane's size/position/rotation, all in the target
// mesh's own local space. "Left"/"Right" and "Front"/"Back" follow this
// app's existing conventions elsewhere (negative X = the character's own
// left; +Z = front, matching the 'front'/'back' camera views).
function facesFaceOverlayTransform3D(bb, faceName) {
  const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
  const cx = (bb.max.x + bb.min.x) / 2, cy = (bb.max.y + bb.min.y) / 2, cz = (bb.max.z + bb.min.z) / 2;
  const eps = Math.max(sx, sy, sz) * 0.02 + 0.05;
  switch (faceName) {
    case 'right':  return { w: sz, h: sy, pos: [bb.max.x + eps, cy, cz], rot: [0,  Math.PI / 2, 0] };
    case 'left':   return { w: sz, h: sy, pos: [bb.min.x - eps, cy, cz], rot: [0, -Math.PI / 2, 0] };
    case 'top':    return { w: sx, h: sz, pos: [cx, bb.max.y + eps, cz], rot: [-Math.PI / 2, 0, 0] };
    case 'bottom': return { w: sx, h: sz, pos: [cx, bb.min.y - eps, cz], rot: [ Math.PI / 2, 0, 0] };
    case 'front':  return { w: sx, h: sy, pos: [cx, cy, bb.max.z + eps], rot: [0, 0, 0] };
    case 'back':   return { w: sx, h: sy, pos: [cx, cy, bb.min.z - eps], rot: [0, 0, 0] };
    default: return null;
  }
}
function addFacesFaceOverlay3D(mesh, faceName) {
  removeFacesOverlay3D(mesh, FACES_FACE_TINT_NAME);
  if (!faceName) return;
  mesh.geometry.computeBoundingBox();
  const t = facesFaceOverlayTransform3D(mesh.geometry.boundingBox, faceName);
  if (!t) return;
  const geo = new THREE.PlaneGeometry(Math.max(t.w, 0.01), Math.max(t.h, 0.01));
  const mat = new THREE.MeshBasicMaterial({ color: FACES_FACE_COLOR, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  const overlay = new THREE.Mesh(geo, mat);
  overlay.name = FACES_FACE_TINT_NAME;
  overlay.position.set(t.pos[0], t.pos[1], t.pos[2]);
  overlay.rotation.set(t.rot[0], t.rot[1], t.rot[2]);
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
    addFacesMeshOverlay3D(r.mesh);
    addFacesOutlineOverlay3D(r.mesh);
    addFacesFaceOverlay3D(r.mesh, facesSelectedFace3D);
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
