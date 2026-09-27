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
const FACES_DOT_COLOR = 0x22e0ff;     // neon blue
// All overlay object names share this prefix so other code (see the head
// depth slider's cleanup in body-build-pose.js) can reliably tell "one of
// the Faces panel's overlays" apart from a mesh's own real children, rather
// than guessing by object type.
const FACES_OVERLAY_PREFIX = '__facesOverlay:';
const FACES_MESH_TINT_NAME = FACES_OVERLAY_PREFIX + 'meshTint';
const FACES_FACE_TINT_NAME = FACES_OVERLAY_PREFIX + 'faceTint';
const FACES_OUTLINE_CORE_NAME = FACES_OVERLAY_PREFIX + 'outlineCore';
const FACES_OUTLINE_HALO_NAME = FACES_OVERLAY_PREFIX + 'outlineHalo';
const FACES_DOT_NAME = FACES_OVERLAY_PREFIX + 'dot';

let facesSelectedMeshGroup3D = null; // e.g. 'torso' | null
let facesSelectedFace3D = null;      // e.g. 'front' | null

// ---- Dot system -------------------------------------------------------
// A small neon-blue marker that rides on the surface of whichever face is
// currently highlighted, positioned by two 0-100% sliders (Horizontal /
// Vertical) rather than a raw XYZ offset, so it always stays glued to that
// face's real surface — including a tapered/slanted face like the waistline
// pinch or a torso front — instead of floating in empty space if the mesh
// changes shape. See facesDotLocalPosition3D for how percent -> position.
let facesDotEnabled3D = false;
let facesDotH3D = 50; // 0-100, left -> right across the face
let facesDotV3D = 50; // 0-100, top -> bottom across the face
let facesDotFloatingEl3D = null;
let facesDotFloatingDragging3D = false;
// True once the live dot's current H/V has been Applied as a wrist
// attachment (see the Wrist Attachments block below) — while true, the
// H/V number fields and floating slider card are disabled so an attached
// point can't be nudged out from under whichever wrist depends on it.
// Remove (or navigating to a different mesh/face, which resets the dot
// entirely) is the only way back to an editable dot.
let facesDotLocked3D = false;

// ---- Wrist attachments -------------------------------------------------
// A purely-visual link from a wrist (left/right) to one exact dot (mesh
// group + face + H/V%) — NOT an actual IK target: the wrist joint itself
// never moves because of this, it's only an indicator (see the "Attached
// Wrists" readout above the Mesh dropdown, and each attached wrist's own
// small marker sphere below) for planning where a hand should eventually
// rest. Persistent data, unlike facesSelectedMeshGroup3D/facesDotH3D/etc
// above (which are just the currently-being-edited dot and get wiped on
// every mesh/face change or body rebuild) — an attachment survives both,
// which is why it's stored separately here instead of piggybacking on the
// live dot state. A wrist can only be attached to one point at a time:
// re-attaching it elsewhere overwrites its one slot rather than adding a
// second. Both wrists CAN share the exact same point, though (Apply for
// Left, then switch the selector to Right and Apply again at the same
// still-locked spot).
let facesWristAttachment3D = { left: null, right: null }; // each: {group, face, h, v} | null
let facesWristSelected3D = 'left'; // which wrist Apply/Remove/Mirror act on
const FACES_WRIST_DOT_PREFIX = FACES_OVERLAY_PREFIX + 'wristDot:';
const FACES_WRIST_COLOR = { left: 0xffa63d, right: 0x8dff5c }; // warm orange (L) / lime green (R) — distinct from the neon-blue editing dot and pink face tint
// Side-specific mesh groups (see the leftArm/rightArm/etc split in
// body-build-pose.js) mirror to their opposite; side-neutral groups
// (torso, waistbox, head, neck) mirror to themselves.
const FACES_GROUP_MIRROR_MAP_3D = {
  leftArm: 'rightArm', rightArm: 'leftArm',
  leftHand: 'rightHand', rightHand: 'leftHand',
  leftLeg: 'rightLeg', rightLeg: 'leftLeg',
  leftFoot: 'rightFoot', rightFoot: 'leftFoot',
};
const FACES_GROUP_LABELS_3D = {
  head: 'Head', neck: 'Neck', torso: 'Torso', waistbox: 'Waist',
  leftArm: 'L Arm', rightArm: 'R Arm', leftHand: 'L Hand', rightHand: 'R Hand',
  leftLeg: 'L Leg', rightLeg: 'R Leg', leftFoot: 'L Foot', rightFoot: 'R Foot',
};
const FACES_FACE_LABELS_3D = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right', front: 'Front', back: 'Back' };

function setFacesWristSelect3D(side) {
  facesWristSelected3D = side;
  const lBtn = document.getElementById('facesWristSelL'), rBtn = document.getElementById('facesWristSelR');
  if (lBtn) lBtn.classList.toggle('active', side === 'left');
  if (rBtn) rBtn.classList.toggle('active', side === 'right');
}
// Whether `side`'s stored attachment is exactly the dot currently being
// edited (same group/face/h/v) — the basis for both the H/V lock and for
// recomputing it after a Remove (the OTHER wrist may still sit here).
function facesWristMatchesCurrentDot3D(side) {
  const a = facesWristAttachment3D[side];
  return !!(a && a.group === facesSelectedMeshGroup3D && a.face === facesSelectedFace3D
    && a.h === facesDotH3D && a.v === facesDotV3D);
}
function applyFacesWristAttachment3D() {
  if (!facesSelectedMeshGroup3D || !facesSelectedFace3D || !facesDotEnabled3D) return;
  facesWristAttachment3D[facesWristSelected3D] = {
    group: facesSelectedMeshGroup3D, face: facesSelectedFace3D, h: facesDotH3D, v: facesDotV3D,
  };
  facesDotLocked3D = true;
  syncFacesDotInputs3D();
  refreshFacesWristReadouts3D();
  applyFacesHighlight3D();
}
function removeFacesWristAttachment3D() {
  const side = facesWristSelected3D;
  facesWristAttachment3D[side] = null;
  // The point stays locked if the OTHER wrist still depends on this exact spot.
  facesDotLocked3D = facesWristMatchesCurrentDot3D(side === 'left' ? 'right' : 'left');
  syncFacesDotInputs3D();
  refreshFacesWristReadouts3D();
  applyFacesHighlight3D();
}
function mirrorFacesMeshGroupName3D(group) { return FACES_GROUP_MIRROR_MAP_3D[group] || group; }
function mirrorFacesFaceName3D(face) {
  if (face === 'left') return 'right';
  if (face === 'right') return 'left';
  return face;
}
// front/back/top/bottom all run Horizontal left->right across the face
// (see facesDotLocalPosition3D), so mirroring those flips H; left/right
// faces run Horizontal across DEPTH instead (front-to-back), which a
// left-right mirror shouldn't touch, so only the face itself flips there.
// Vertical never flips either way (a mirror never turns top into bottom).
function mirrorWristAttachmentSpec3D(att) {
  if (!att) return null;
  const flipH = att.face === 'front' || att.face === 'back' || att.face === 'top' || att.face === 'bottom';
  return {
    group: mirrorFacesMeshGroupName3D(att.group),
    face: mirrorFacesFaceName3D(att.face),
    h: flipH ? (100 - att.h) : att.h,
    v: att.v,
  };
}
function mirrorFacesWristAttachment3D() {
  const src = facesWristAttachment3D.left;
  if (!src) return;
  facesWristAttachment3D.right = mirrorWristAttachmentSpec3D(src);
  facesDotLocked3D = facesWristMatchesCurrentDot3D('left') || facesWristMatchesCurrentDot3D('right');
  syncFacesDotInputs3D();
  refreshFacesWristReadouts3D();
  applyFacesHighlight3D();
}

// Resolves one attachment's stored (group,face,h,v) into a real spine-local
// XYZ, for the "Attached Wrists" readout above the Mesh dropdown — this can
// be asked about a group that ISN'T the currently-selected one, so (unlike
// the live dot) it re-derives its own mesh records/outline instead of
// reusing whatever's currently highlighted. Every exposed group now
// resolves into exactly one stack (see buildFacesDotStacks3D's joint-bridge
// merge — a hand's thumb is the one exception, its own separate appendage,
// but an attachment is never placed on it), so the first stack found is used.
// The raw world-space point, with no spine-local conversion — split out of
// resolveWristAttachmentPoint3D below so the puppet-line code (which needs
// a world point to draw between two world objects, not a spine-local one)
// can share this same resolution logic instead of duplicating it.
function resolveWristAttachmentWorldPoint3D(att) {
  if (!att || !meshRecords3D.length) return null;
  const records = meshRecords3D.filter(r => r.group === att.group);
  if (!records.length) return null;
  const stacks = buildFacesDotStacks3D(records.map(r => r.mesh));
  for (const meshes of stacks) {
    const pieces = meshes.map(mesh => ({ mesh, outline: facesMeshOutline3D(mesh.geometry) }));
    const combined = combineFacesOutlineStack3D(pieces);
    const pt = facesDotLocalPosition3D(att.face, combined, att.h, att.v);
    if (!pt || !combined.refFrame) continue;
    return combined.refFrame.localToWorld(pt.clone());
  }
  return null;
}
function resolveWristAttachmentPoint3D(att) {
  const world = resolveWristAttachmentWorldPoint3D(att);
  if (!world) return null;
  if (rig3D.spine) { rig3D.spine.updateMatrixWorld(true); return rig3D.spine.worldToLocal(world.clone()); }
  return world;
}
// Updates the "Attached Wrists" summary above the Mesh dropdown — call
// whenever an attachment changes (Apply/Remove/Mirror) or the popup opens,
// and after a body rebuild (the rig the XYZ is resolved against is new).
function refreshFacesWristReadouts3D() {
  ['left', 'right'].forEach(side => {
    const el = document.getElementById(side === 'left' ? 'facesWristAttachL' : 'facesWristAttachR');
    if (!el) return;
    const att = facesWristAttachment3D[side];
    if (!att) { el.textContent = '—'; return; }
    const groupLabel = FACES_GROUP_LABELS_3D[att.group] || att.group;
    const faceLabel = FACES_FACE_LABELS_3D[att.face] || att.face;
    const pt = resolveWristAttachmentPoint3D(att);
    const xyz = pt ? `(${round1(pt.x).toFixed(1)}, ${round1(pt.y).toFixed(1)}, ${round1(pt.z).toFixed(1)})` : '(—)';
    el.textContent = `${groupLabel} · ${faceLabel} · ${xyz}`;
  });
}
// ---- Puppet lines -------------------------------------------------------
// A persistent neon-blue "string" from a wrist's current joint position to
// whatever point it's attached to (facesWristAttachment3D above) — unlike
// the small colored wrist-marker spheres below (only shown while that
// exact mesh/face happens to be selected in the Faces popup), this is
// meant to be visible constantly, on both wrists at once, independent of
// whatever's currently picked in the dropdowns. Lives directly in scene3D
// (not parented under bodyGroup3D or any rig joint), since it needs to
// stretch between two different moving things every frame — the wrist
// joint's own world position and the attachment point's world position —
// so it's simplest to just recompute both endpoints in world space each
// frame rather than trying to parent it under either one. Being outside
// bodyGroup3D also means a pose rebuild's mesh disposal (buildBody3D)
// never touches it, matching how facesWristAttachment3D itself survives
// a rebuild.
const PUPPET_LINE_NAME_PREFIX = '__puppetLine:';
let puppetLineObjs3D = { left: null, right: null };
function ensurePuppetLine3D(side) {
  if (puppetLineObjs3D[side]) return puppetLineObjs3D[side];
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const mat = new THREE.LineBasicMaterial({ color: FACES_DOT_COLOR, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.name = PUPPET_LINE_NAME_PREFIX + side;
  line.renderOrder = 5;
  line.frustumCulled = false;
  line.visible = false;
  scene3D.add(line);
  puppetLineObjs3D[side] = line;
  return line;
}
// Runs every frame from animate3D (see body-scene.js): for each wrist that
// currently has an attachment, re-resolves both the wrist joint's and the
// attachment point's current world positions and re-stretches that wrist's
// line between them; a wrist with no attachment (or if the rig/meshes
// aren't around to resolve against) just gets its line hidden.
function updatePuppetLines3D() {
  ['left', 'right'].forEach(side => {
    const att = facesWristAttachment3D[side];
    const wristGroup = rig3D && rig3D[side + 'Wrist'];
    const targetWorld = att ? resolveWristAttachmentWorldPoint3D(att) : null;
    if (!att || !wristGroup || !targetWorld) {
      if (puppetLineObjs3D[side]) puppetLineObjs3D[side].visible = false;
      return;
    }
    const wristWorld = new THREE.Vector3();
    wristGroup.getWorldPosition(wristWorld);
    const line = ensurePuppetLine3D(side);
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, wristWorld.x, wristWorld.y, wristWorld.z);
    pos.setXYZ(1, targetWorld.x, targetWorld.y, targetWorld.z);
    pos.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.visible = true;
  });
}

// Small colored marker (one color per wrist, distinct from the neon-blue
// editing dot) at an attached wrist's stored point — same owner-piece and
// local-space logic as the editing dot's own addFacesDotOverlayAtPosition3D,
// just its own overlay name/color so both can coexist. Only ever called for
// the CURRENTLY selected group/face (see applyFacesWristDotsToGroup3D) —
// "only seen when the correct mesh and face is selected", per spec.
function addFacesWristDotOverlay3D(meshes, side, att) {
  const pieces = meshes.map(mesh => ({ mesh, outline: facesMeshOutline3D(mesh.geometry) }));
  const combined = combineFacesOutlineStack3D(pieces);
  const pt = facesDotLocalPosition3D(att.face, combined, att.h, att.v);
  if (!pt) return;
  let owner = pieces[0];
  for (let i = 0; i < pieces.length; i++) {
    const seg = combined.segments[i];
    if (pt.y >= seg.minY - 1e-4 && pt.y <= seg.maxY + 1e-4) { owner = pieces[i]; break; }
  }
  const local = frameLocalToMeshLocal3D(pt, combined.refFrame, owner.mesh);
  const name = FACES_WRIST_DOT_PREFIX + side;
  const existing = owner.mesh.children.find(c => c.name === name);
  if (existing) { owner.mesh.remove(existing); existing.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
  const o = owner.outline;
  const scale = Math.max(o.maxY - o.minY, o.maxZ - o.minZ, o.top.maxX - o.top.minX, o.bottom.maxX - o.bottom.minX);
  const r = Math.max(scale * 0.022, 0.032);
  const coreMat = new THREE.MeshBasicMaterial({ color: FACES_WRIST_COLOR[side], depthWrite: false, depthTest: false });
  const core = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), coreMat);
  const haloMat = new THREE.MeshBasicMaterial({ color: FACES_WRIST_COLOR[side], transparent: true, opacity: 0.4, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(r * 2.2, 12, 8), haloMat);
  const group = new THREE.Group();
  group.name = name;
  group.add(halo, core);
  group.position.copy(local);
  owner.mesh.add(group);
}
function removeFacesWristDotOverlaysFromRecords3D(records) {
  ['left', 'right'].forEach(side => {
    const name = FACES_WRIST_DOT_PREFIX + side;
    records.forEach(r => {
      const existing = r.mesh.children.find(c => c.name === name);
      if (!existing) return;
      r.mesh.remove(existing);
      existing.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    });
  });
}
// Places (or clears) each wrist's marker for the currently-selected group —
// only the wrist(s) whose stored attachment's group AND face match what's
// currently picked actually get a marker; everything else stays hidden.
function applyFacesWristDotsToGroup3D(records) {
  removeFacesWristDotOverlaysFromRecords3D(records);
  if (!records.length) return;
  const stacks = buildFacesDotStacks3D(records.map(r => r.mesh));
  ['left', 'right'].forEach(side => {
    const att = facesWristAttachment3D[side];
    if (!att || att.group !== facesSelectedMeshGroup3D || att.face !== facesSelectedFace3D) return;
    stacks.forEach(meshes => addFacesWristDotOverlay3D(meshes, side, att));
  });
}

function removeFacesOverlay3D(mesh, name) {
  const existing = mesh.children.find(c => c.name === name);
  if (!existing) return;
  mesh.remove(existing);
  existing.geometry.dispose();
  existing.material.dispose();
}

// The dot overlay is a small Group (a core sphere + a glow halo sphere)
// rather than one mesh, so it needs its own cleanup that disposes both
// children instead of the single geometry/material removeFacesOverlay3D
// expects.
function removeFacesDotOverlay3D(mesh) {
  const existing = mesh.children.find(c => c.name === FACES_DOT_NAME);
  if (!existing) return;
  mesh.remove(existing);
  existing.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
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

// Finds which segment of a bottom→top ordered stack a given absolute Y
// falls into, so the dot's vertical travel can bend at each real seam
// instead of drawing a straight line from the stack's outer bottom to its
// outer top. Falls back to the last segment for a Y past the very top
// (floating point overshoot at v=100%).
function pickFacesDotSegment3D(segments, y) {
  for (const seg of segments) {
    if (y <= seg.maxY + 1e-4) return seg;
  }
  return segments[segments.length - 1];
}
// How far (0-1) a Y sits between one segment's OWN minY/maxY — i.e. the
// local bottom/top-of-this-one-piece fraction, not the whole stack's.
function facesDotSegmentFraction3D(seg, y) {
  const span = seg.maxY - seg.minY;
  return span <= 1e-6 ? 0 : Math.max(0, Math.min(1, (y - seg.minY) / span));
}

// Turns the dot's Horizontal/Vertical percentages into a real mesh-local
// point on the currently highlighted face — reusing exactly the same real
// corners (o.segments[].bottom/top, o.min/max) that addFacesFaceOverlay3D
// uses to draw that face's tint, just bilinearly interpolated instead of
// drawn as a full plane. That's what makes the dot follow a slanted/
// tapered face (the waistline pinch, an angled torso front, etc.)
// correctly: it's walking the same real quad the tint overlay traces, not
// a flat assumption of one — and for a multi-piece stack (e.g. the
// hourglass waistline's upper/lower trapezoids meeting at a pinch seam)
// Vertical still sweeps the stack's overall bottom(0%)->top(100%) in one
// smooth motion, but at each Y it slants toward whichever ONE piece's own
// real bottom/top corners that Y currently falls between (via o.segments),
// so the dot's path bends right at the seam along with the mesh — down
// toward the seam through the upper piece, then down toward the outer
// bottom edge through the lower piece — instead of cutting a single
// straight line through both.
//  - front/back: h runs left→right, v runs top(0%)→bottom(100%), across the
//    mesh's real (possibly trapezoid, possibly multi-segment) cap shape.
//  - top/bottom: h runs left→right across that level's real width, v runs
//    back→front across the mesh's depth (this one has no true top/bottom of
//    its own, so it keeps the plain 0%→100% direction, unflipped).
//  - left/right: h runs across the depth (Z), v runs top(0%)→bottom(100%)
//    along the side's own real slant per segment (interpolating X together
//    with Y so a tapered/bent side's dot rides the slant instead of cutting
//    through it).
function facesDotLocalPosition3D(faceName, outline, hPct, vPct) {
  const o = outline;
  const h = Math.max(0, Math.min(100, hPct)) / 100;
  // Vertical is authored top(0%) -> bottom(100%), matching how people read
  // a face on screen, but every height lerp below is naturally bottom(0)->
  // top(1) (it walks o.minY up to o.maxY / o.bottom up to o.top), so flip
  // it once here rather than re-deriving each face's math around it.
  const v = 1 - Math.max(0, Math.min(100, vPct)) / 100;
  const lerp = (a, b, t) => a + (b - a) * t;
  // Same tiny hairline reasoning as the mesh/face tint overlays above — the
  // dot's material also has depthTest off, so this only needs to be just
  // enough to clear the real surface, not a visible gap.
  const eps = 0.004;

  if (faceName === 'front' || faceName === 'back') {
    const y = lerp(o.minY, o.maxY, v);
    const seg = pickFacesDotSegment3D(o.segments, y);
    const t = facesDotSegmentFraction3D(seg, y);
    const xBottom = lerp(seg.bottom.minX, seg.bottom.maxX, h);
    const xTop = lerp(seg.top.minX, seg.top.maxX, h);
    const x = lerp(xBottom, xTop, t);
    const z = faceName === 'front' ? o.maxZ + eps : o.minZ - eps;
    return new THREE.Vector3(x, y, z);
  }
  if (faceName === 'top' || faceName === 'bottom') {
    // Vertical here runs across the mesh's depth (Z), not its height — a
    // horizontal plane has no real top/bottom of its own to flip toward —
    // so this one intentionally keeps the un-flipped percentage.
    const vDepth = Math.max(0, Math.min(100, vPct)) / 100;
    const atTop = faceName === 'top';
    const level = atTop ? o.top : o.bottom;
    const x = lerp(level.minX, level.maxX, h);
    const z = lerp(o.minZ, o.maxZ, vDepth);
    const y = (atTop ? o.maxY : o.minY) + (atTop ? eps : -eps);
    return new THREE.Vector3(x, y, z);
  }
  if (faceName === 'left' || faceName === 'right') {
    const isLeft = faceName === 'left';
    const y = lerp(o.minY, o.maxY, v);
    const seg = pickFacesDotSegment3D(o.segments, y);
    const t = facesDotSegmentFraction3D(seg, y);
    const bx = isLeft ? seg.bottom.minX : seg.bottom.maxX;
    const tx = isLeft ? seg.top.minX : seg.top.maxX;
    // Normal is derived from this one segment's own slant direction, not
    // the whole stack's outer bottom-to-top line, so a bent stack (narrows
    // then widens again) gets each half's own outward tilt right instead
    // of one averaged tilt for the whole side.
    const dx = tx - bx, dy = seg.maxY - seg.minY;
    const heightDir = new THREE.Vector3(dx, dy, 0).normalize();
    const widthDir = new THREE.Vector3(0, 0, 1);
    // Same left/right cross-product order swap as addFacesFaceOverlay3D, so
    // the dot pops off the same outward side that face's tint does.
    const normal = isLeft
      ? new THREE.Vector3().crossVectors(widthDir, heightDir).normalize()
      : new THREE.Vector3().crossVectors(heightDir, widthDir).normalize();
    const x = lerp(bx, tx, t);
    const z = lerp(o.minZ, o.maxZ, h);
    return new THREE.Vector3(x + normal.x * eps, y + normal.y * eps, z + normal.z * eps);
  }
  return null;
}

// The dot itself: a crisp core sphere plus a bigger, additively-blended,
// more-transparent halo sphere behind it — the same glow trick the purple
// outline uses — parented onto whichever physical mesh piece currently owns
// it (see addFacesDotForStack3D) so it tracks that piece like every other
// overlay here.
function addFacesDotOverlayAtPosition3D(mesh, localPos, outline) {
  removeFacesDotOverlay3D(mesh);
  // Radius scales gently with the owning piece's own size so it reads
  // sensibly on both a finger-sized hand piece and a torso, but never
  // shrinks below a floor that would make it hard to see on a small part.
  const scale = Math.max(outline.maxY - outline.minY, outline.maxZ - outline.minZ,
    outline.top.maxX - outline.top.minX, outline.bottom.maxX - outline.bottom.minX);
  const r = Math.max(scale * 0.02, 0.03);
  const group = new THREE.Group();
  group.name = FACES_DOT_NAME;
  const coreMat = new THREE.MeshBasicMaterial({ color: FACES_DOT_COLOR, depthWrite: false, depthTest: false });
  const core = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), coreMat);
  core.renderOrder = 4;
  const haloMat = new THREE.MeshBasicMaterial({ color: FACES_DOT_COLOR, transparent: true, opacity: 0.4, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(r * 2.4, 14, 10), haloMat);
  halo.renderOrder = 4;
  group.add(halo, core);
  group.position.copy(localPos);
  mesh.add(group);
}

// Clusters the group's mesh pieces into "stacks": a stack is one or more
// pieces that together read as ONE continuous limb surface — either a flat
// split (pieces sharing the same parent AND the same (x, z) position, e.g.
// the male torso's pinched upper/lower trapezoids) or pieces bridged by a
// real rotating joint (a thigh + its shin, an upper arm + its forearm) —
// merged in a second pass below so the whole limb gets ONE dot the same
// way the torso already does, including across a bent knee/elbow. A joint
// bridge is recognised structurally: the lower piece's own pivot group
// sits DIRECTLY INSIDE the upper piece's pivot group (kneeGroup is a child
// of hipGroup, which is exactly the thigh's own parent) — as opposed to an
// unrelated appendage stuck on the SIDE of the same pivot (a thumb's pivot
// is a SIBLING of the hand's pivot, both hanging off the wrist group, not
// nested one level inside it), which correctly stays its own separate stack.
function buildFacesDotStacks3D(meshes) {
  const flat = [];
  meshes.forEach(mesh => {
    const s = flat.find(s => s.parent === mesh.parent
      && Math.abs(s.x - mesh.position.x) < 1e-4
      && Math.abs(s.z - mesh.position.z) < 1e-4);
    if (s) s.meshes.push(mesh);
    else flat.push({ parent: mesh.parent, x: mesh.position.x, z: mesh.position.z, meshes: [mesh] });
  });
  flat.forEach(s => s.meshes.sort((a, b) => a.position.y - b.position.y));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < flat.length && !merged; i++) {
      for (let j = 0; j < flat.length && !merged; j++) {
        if (i === j) continue;
        const upperMesh = flat[i].meshes[flat[i].meshes.length - 1];
        const lowerMesh = flat[j].meshes[0];
        if (lowerMesh.parent && lowerMesh.parent.parent === upperMesh.parent) {
          // Bottom-to-top order: the lower (deeper-nested) cluster's own
          // pieces first, then the upper (ancestor) cluster's.
          flat[j].meshes = flat[j].meshes.concat(flat[i].meshes);
          flat.splice(i, 1);
          merged = true;
        }
      }
    }
  }
  return flat.map(s => s.meshes);
}

// Reads one piece's real outline into `refGroup`'s own local frame. When the
// piece's own parent already IS refGroup this is the plain translation the
// flat-split case always needed (the torso's own upper/lower halves, say —
// only Y differs between pieces, see the header comment above). When the
// piece sits one real rotating joint deeper (a shin inside the knee pivot,
// nested inside the hip pivot that owns the thigh) there's an actual
// rotation to account for, not just a translation — so this instead reads
// the piece's 8 real corners through the joint's CURRENT rotation
// (mesh.localToWorld -> refGroup.worldToLocal) and re-derives a fresh
// axis-aligned min/max per axis from them. That's exact for these parts
// (all plain, untapered boxes) whatever angle the joint is currently bent
// to — a straight leg reads exactly like one continuous column (same as
// the torso), and a bent knee still keeps the dot right on the real surface
// rather than assuming it's still perfectly straight.
function pieceOutlineInFrame3D(piece, refGroup) {
  const o = piece.outline;
  if (piece.mesh.parent === refGroup) {
    return {
      minY: piece.mesh.position.y + o.minY, maxY: piece.mesh.position.y + o.maxY,
      minZ: piece.mesh.position.z + o.minZ, maxZ: piece.mesh.position.z + o.maxZ,
      bottom: { minX: piece.mesh.position.x + o.bottom.minX, maxX: piece.mesh.position.x + o.bottom.maxX },
      top: { minX: piece.mesh.position.x + o.top.minX, maxX: piece.mesh.position.x + o.top.maxX },
    };
  }
  const corners = [];
  [[o.minY, o.bottom], [o.maxY, o.top]].forEach(([y, level]) => {
    [level.minX, level.maxX].forEach(x => {
      [o.minZ, o.maxZ].forEach(z => {
        corners.push(refGroup.worldToLocal(piece.mesh.localToWorld(new THREE.Vector3(x, y, z))));
      });
    });
  });
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y), zs = corners.map(c => c.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  return {
    minY: Math.min(...ys), maxY: Math.max(...ys),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
    bottom: { minX, maxX }, top: { minX, maxX },
  };
}

// Combines a bottom-to-top ordered stack (see buildFacesDotStacks3D — one or
// more real pieces that together read as one continuous limb) into one
// outline spanning the whole stack, expressed in the TOPMOST piece's own
// parent frame (`refFrame` on the returned object — the frame every
// consumer below converts a resolved point back out of). A stack of exactly
// one piece just IS that piece's own outline in its own parent's frame.
// Also carries `segments`: each individual piece's own Y range plus its OWN
// bottom/top corners (not just the stack's outer two), all in that same
// refFrame. facesDotLocalPosition3D walks these instead of treating the
// whole stack as one straight-sided shape, so a stack that bends partway —
// the hourglass waistline's own pinch, or a genuinely bent knee/elbow —
// gets a dot path that bends at the real seam instead of cutting straight
// through it.
function combineFacesOutlineStack3D(pieces) {
  if (typeof bodyGroup3D !== 'undefined' && bodyGroup3D) bodyGroup3D.updateMatrixWorld(true);
  const refFrame = pieces[pieces.length - 1].mesh.parent;
  const segments = pieces.map(p => ({ ...pieceOutlineInFrame3D(p, refFrame) }));
  return {
    minY: segments[0].minY,
    maxY: segments[segments.length - 1].maxY,
    minZ: Math.min(...segments.map(s => s.minZ)),
    maxZ: Math.max(...segments.map(s => s.maxZ)),
    bottom: segments[0].bottom,
    top: segments[segments.length - 1].top,
    segments,
    refFrame,
  };
}

// Converts a point expressed in a combined stack's own refFrame (see
// combineFacesOutlineStack3D) into `ownerMesh`'s own local space, so it can
// be parented directly onto that real mesh. A plain subtraction when
// ownerMesh's parent already IS refFrame (the common, flat-split case);
// otherwise a real world-space round trip through whatever joint rotation
// sits between them.
function frameLocalToMeshLocal3D(pt, refFrame, ownerMesh) {
  if (ownerMesh.parent === refFrame) {
    return new THREE.Vector3(pt.x - ownerMesh.position.x, pt.y - ownerMesh.position.y, pt.z - ownerMesh.position.z);
  }
  return ownerMesh.worldToLocal(refFrame.localToWorld(pt.clone()));
}

// Places exactly one dot for a stack: computes the dot's point across the
// COMBINED surface (so Vertical 0-100% sweeps smoothly from the top of the
// topmost piece through to the bottom of the bottommost piece, right across
// every seam — including a real joint now, not just a flat split), then
// figures out which single physical piece that point actually falls on and
// parents the dot there, converting the point back into that piece's own
// local space.
function addFacesDotForStack3D(meshes, faceName) {
  const pieces = meshes.map(mesh => ({ mesh, outline: facesMeshOutline3D(mesh.geometry) }));
  const combined = combineFacesOutlineStack3D(pieces);
  const pt = facesDotLocalPosition3D(faceName, combined, facesDotH3D, facesDotV3D);
  if (!pt) return;
  let owner = pieces[0];
  for (let i = 0; i < pieces.length; i++) {
    const seg = combined.segments[i];
    if (pt.y >= seg.minY - 1e-4 && pt.y <= seg.maxY + 1e-4) { owner = pieces[i]; break; }
  }
  const local = frameLocalToMeshLocal3D(pt, combined.refFrame, owner.mesh);
  addFacesDotOverlayAtPosition3D(owner.mesh, local, owner.outline);
}

// Entry point used by both applyFacesHighlight3D and updateFacesDotOnly3D:
// clears any dot left over on every candidate mesh (a stack only ever
// carries one now, but it may have been on a different piece last time),
// then places one fresh dot per stack.
function applyFacesDotToGroup3D(records) {
  records.forEach(r => removeFacesDotOverlay3D(r.mesh));
  if (!facesDotEnabled3D || !facesSelectedFace3D || !records.length) return;
  buildFacesDotStacks3D(records.map(r => r.mesh)).forEach(meshes => addFacesDotForStack3D(meshes, facesSelectedFace3D));
}

// Rebuilds only the dot (not the mesh tint / outline / face tint) — used
// while dragging the Horizontal/Vertical sliders so the dot moves smoothly
// without the other overlays flickering as they'd have to if
// applyFacesHighlight3D() (which tears down and rebuilds everything) ran on
// every slider tick.
function updateFacesDotOnly3D() {
  if (!facesSelectedMeshGroup3D || !meshRecords3D.length) return;
  applyFacesDotToGroup3D(meshRecords3D.filter(r => r.group === facesSelectedMeshGroup3D));
}

function clearFacesHighlight3D() {
  meshRecords3D.forEach(r => {
    removeFacesOverlay3D(r.mesh, FACES_MESH_TINT_NAME);
    removeFacesOverlay3D(r.mesh, FACES_OUTLINE_CORE_NAME);
    removeFacesOverlay3D(r.mesh, FACES_OUTLINE_HALO_NAME);
    removeFacesOverlay3D(r.mesh, FACES_FACE_TINT_NAME);
    removeFacesDotOverlay3D(r.mesh);
  });
  removeFacesWristDotOverlaysFromRecords3D(meshRecords3D);
}
function applyFacesHighlight3D() {
  clearFacesHighlight3D();
  if (!facesSelectedMeshGroup3D || !meshRecords3D.length) return;
  const records = meshRecords3D.filter(r => r.group === facesSelectedMeshGroup3D);
  records.forEach(r => {
    const outline = facesMeshOutline3D(r.mesh.geometry);
    addFacesMeshOverlay3D(r.mesh, outline);
    addFacesOutlineOverlay3D(r.mesh);
    addFacesFaceOverlay3D(r.mesh, facesSelectedFace3D, outline);
  });
  applyFacesDotToGroup3D(records);
  applyFacesWristDotsToGroup3D(records); // wrist markers only ever render for whichever group/face this is
}

// Resets the dot back to its default Off/50/50 state and shows or hides the
// whole Dot section — it only makes sense (and only shows up) once a face
// is actually chosen, per the Face dropdown above it.
function resetFacesDotState3D() {
  facesDotEnabled3D = false;
  facesDotH3D = 50;
  facesDotV3D = 50;
  facesDotLocked3D = false;
  const section = document.getElementById('facesDotSection');
  if (section) section.style.display = facesSelectedFace3D ? '' : 'none';
  const offBtn = document.getElementById('facesDotOffBtn'), onBtn = document.getElementById('facesDotOnBtn');
  if (offBtn) offBtn.classList.add('active');
  if (onBtn) onBtn.classList.remove('active');
  const controls = document.getElementById('facesDotControls');
  if (controls) controls.style.display = 'none';
  syncFacesDotInputs3D();
}

function onFacesMeshChange3D(value) {
  facesSelectedMeshGroup3D = value || null;
  facesSelectedFace3D = null;
  const faceSel = document.getElementById('facesFaceSelect');
  if (faceSel) { faceSel.value = ''; faceSel.disabled = !facesSelectedMeshGroup3D; }
  resetFacesDotState3D();
  applyFacesHighlight3D();
}
function onFacesFaceChange3D(value) {
  if (!facesSelectedMeshGroup3D) return; // dropdown is disabled until a mesh is picked, but guard anyway
  facesSelectedFace3D = value || null;
  resetFacesDotState3D();
  applyFacesHighlight3D();
}

function setFacesDotMode3D(on) {
  if (!facesSelectedFace3D) return; // Dot section is hidden in this state anyway, but guard regardless
  facesDotEnabled3D = !!on;
  const offBtn = document.getElementById('facesDotOffBtn'), onBtn = document.getElementById('facesDotOnBtn');
  if (offBtn) offBtn.classList.toggle('active', !facesDotEnabled3D);
  if (onBtn) onBtn.classList.toggle('active', facesDotEnabled3D);
  const controls = document.getElementById('facesDotControls');
  if (controls) controls.style.display = facesDotEnabled3D ? '' : 'none';
  updateFacesDotOnly3D();
}

// Shared handler for all four Horizontal/Vertical inputs — the popup's own
// number fields and the floating card's sliders next to the model — so
// typing a number and dragging a slider always agree with each other.
function onFacesDotAxisInput3D(axis, value) {
  let n = parseFloat(value);
  if (isNaN(n)) return;
  n = Math.max(0, Math.min(100, n));
  if (axis === 'h') facesDotH3D = n; else facesDotV3D = n;
  syncFacesDotInputs3D();
  updateFacesDotOnly3D();
}

// Keeps every Horizontal/Vertical control in sync with the live state:
// the popup's number inputs, and the floating card's sliders + value
// readouts next to the model. Skips whichever single control currently has
// focus so it doesn't fight the user mid-type/mid-drag. Also enforces
// facesDotLocked3D (see its declaration above) by disabling all four
// controls once this exact dot has been Applied to a wrist — re-enabled
// automatically the moment Remove clears the last wrist depending on it.
function syncFacesDotInputs3D() {
  const setNum = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; el && (el.disabled = facesDotLocked3D); };
  setNum('facesDotHNum', facesDotH3D);
  setNum('facesDotVNum', facesDotV3D);
  const setSlider = (id, valId, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v;
    if (el) el.disabled = facesDotLocked3D;
    const val = document.getElementById(valId);
    if (val) val.textContent = Math.round(v);
  };
  setSlider('fdcHSlider', 'fdcHVal', facesDotH3D);
  setSlider('fdcVSlider', 'fdcVVal', facesDotV3D);
}

// The floating Horizontal/Vertical slider card that sits next to the
// highlighted face on screen once the Faces popup is closed — same pattern
// as ensureWristSliders3D()/#wristSliders3D for the wrist Bend/Turn sliders.
function ensureFacesDotFloatingCard3D() {
  if (facesDotFloatingEl3D) return facesDotFloatingEl3D;
  const host = document.getElementById('preview3D');
  if (!host) return null;
  if (!document.getElementById('facesDotFloatCss3D')) {
    const st = document.createElement('style');
    st.id = 'facesDotFloatCss3D';
    st.textContent = `
      #facesDotFloat3D { position:absolute; z-index:30; width:168px; padding:8px 10px 6px;
        background:rgba(20,20,24,0.88); border:1px solid #22e0ff; border-radius:10px;
        font-family:'Space Mono',monospace; font-size:10px; color:#eee; display:none;
        touch-action:none; user-select:none; -webkit-user-select:none; }
      #facesDotFloat3D .fd-row { display:flex; align-items:center; gap:6px; margin:4px 0; }
      #facesDotFloat3D .fd-lab { width:20px; color:#22e0ff; font-weight:700; }
      #facesDotFloat3D .fd-val { width:30px; text-align:right; }
      #facesDotFloat3D input[type=range] { flex:1; min-width:0; height:28px; margin:0; accent-color:#22e0ff; touch-action:none; }
    `;
    document.head.appendChild(st);
  }
  const el = document.createElement('div');
  el.id = 'facesDotFloat3D';
  el.innerHTML = `
    <div class="fd-row"><span class="fd-lab">H</span><input type="range" id="fdcHSlider" min="0" max="100" step="1" value="50"><span class="fd-val" id="fdcHVal">50</span></div>
    <div class="fd-row"><span class="fd-lab">V</span><input type="range" id="fdcVSlider" min="0" max="100" step="1" value="50"><span class="fd-val" id="fdcVVal">50</span></div>`;
  // Keep touches/clicks on the card away from orbit/pan on the canvas.
  ['pointerdown','pointermove','pointerup','touchstart','touchmove','mousedown','wheel'].forEach(ev =>
    el.addEventListener(ev, e => e.stopPropagation(), { passive: true }));
  host.appendChild(el);
  const bind = (id, axis) => {
    const inp = el.querySelector('#' + id);
    inp.addEventListener('input', () => onFacesDotAxisInput3D(axis, inp.value));
    inp.addEventListener('pointerdown', () => { facesDotFloatingDragging3D = true; });
    const end = () => { facesDotFloatingDragging3D = false; };
    inp.addEventListener('pointerup', end); inp.addEventListener('pointercancel', end); inp.addEventListener('change', end);
  };
  bind('fdcHSlider', 'h'); bind('fdcVSlider', 'v');
  facesDotFloatingEl3D = el;
  return el;
}

// Runs every frame from animate3D (see body-scene.js), same as
// updateWristSliderOverlay3D(): keeps the popup's live world-XYZ readout
// current, and shows/positions the floating H/V card next to the dot's
// actual on-screen position once the Faces popup is closed.
function updateFacesDotOverlayFrame3D() {
  const active = !!(facesDotEnabled3D && facesSelectedMeshGroup3D && facesSelectedFace3D && meshRecords3D.length && jointEditorModeActive3D);
  if (!active) {
    ['facesDotWorldX', 'facesDotWorldY', 'facesDotWorldZ'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '—';
    });
    if (facesDotFloatingEl3D && facesDotFloatingEl3D.style.display !== 'none') facesDotFloatingEl3D.style.display = 'none';
    return;
  }
  // A stack now carries exactly one dot, but it can be parented on any one
  // of the group's matching meshes depending on where Vertical currently
  // lands (see addFacesDotForStack3D) — so scan all of them rather than
  // assuming it's on the first. If the group has more than one independent
  // stack (e.g. left/right sides), this only reads the first dot found.
  const records = meshRecords3D.filter(r => r.group === facesSelectedMeshGroup3D);
  if (!records.length) return;
  let dotObj = null;
  for (const r of records) {
    const d = r.mesh.children.find(c => c.name === FACES_DOT_NAME);
    if (d) { dotObj = d; break; }
  }
  if (!dotObj) return;
  const world = new THREE.Vector3();
  dotObj.getWorldPosition(world);
  // Same spine-local frame the joint X/Y/Z panel uses (see
  // updateJointPanelValues3D), so this reads on the same coordinate system
  // as every joint's own position.
  let coord = world;
  if (rig3D.spine) {
    rig3D.spine.updateMatrixWorld(true);
    coord = rig3D.spine.worldToLocal(world.clone());
  }
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = round1(v).toFixed(1); };
  setTxt('facesDotWorldX', coord.x);
  setTxt('facesDotWorldY', coord.y);
  setTxt('facesDotWorldZ', coord.z);

  const popup = document.getElementById('jeFacesPopup');
  const popupOpen = !!(popup && popup.classList.contains('open'));
  const card = ensureFacesDotFloatingCard3D();
  if (!card) return;
  if (popupOpen) { card.style.display = 'none'; return; }
  const host = document.getElementById('preview3D');
  const W = host.clientWidth, H = host.clientHeight;
  const proj = world.clone().project(camera3D);
  const sx = (proj.x * 0.5 + 0.5) * W, sy = (-proj.y * 0.5 + 0.5) * H;
  if (card.style.display !== 'block') { card.style.display = 'block'; syncFacesDotInputs3D(); }
  const cw = card.offsetWidth || 168, ch = card.offsetHeight || 70;
  let x = sx < W / 2 ? sx + 24 : sx - cw - 24;
  x = Math.max(4, Math.min(W - cw - 4, x));
  let minY = 4; const hostTop = host.getBoundingClientRect().top;
  ['jointEditorTopBar', 'jointToggleBar', 'jeCopyBar'].forEach(id => {
    const b = document.getElementById(id);
    if (b && b.offsetParent !== null) minY = Math.max(minY, b.getBoundingClientRect().bottom - hostTop + 6);
  });
  const y = Math.max(minY, Math.min(H - ch - 4, sy - ch / 2));
  card.style.left = Math.round(x) + 'px';
  card.style.top = Math.round(y) + 'px';
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
  resetFacesDotState3D();
}
function openFacesPopup3D() {
  const el = document.getElementById('jeFacesPopup');
  if (el) el.classList.add('open');
  refreshFacesWristReadouts3D();
}
function closeFacesPopup3D() {
  const el = document.getElementById('jeFacesPopup');
  if (el) el.classList.remove('open');
}
