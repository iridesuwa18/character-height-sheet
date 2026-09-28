// ── button-feedback.js ───────────────────────────────────────────────
// Global press feedback for EVERY <button> on the page (including ones the
// app creates later, like the pose grid), with no per-button wiring:
//   1. a quick gold glow the instant a button is pressed, and
//   2. a small toast at the bottom saying what happened.
// One delegated listener on document does both, so new buttons get it for
// free. Plain global script, no modules — load order: anywhere after
// char-constants.js; it only READS other files' globals lazily at click time.
//
// Adding a custom message for a button: give it data-feedback="Text" (shown
// as-is), or data-feedback="off" to keep the glow but skip the toast.
(function () {
  const css = `
    @keyframes bfGlow {
      0%   { box-shadow: 0 0 0 0 rgba(240,192,64,0.95), 0 0 16px 4px rgba(240,192,64,0.85); filter: brightness(1.4); }
      100% { box-shadow: 0 0 0 7px rgba(240,192,64,0), 0 0 0 0 rgba(240,192,64,0); filter: brightness(1); }
    }
    button.bf-flash { animation: bfGlow 0.55s ease-out; }
    button:not(:disabled):active { filter: brightness(1.35); }
    #bfToast {
      position: fixed; left: 50%; bottom: calc(84px + env(safe-area-inset-bottom, 0px));
      transform: translate(-50%, 8px); z-index: 10050; max-width: min(86vw, 420px);
      padding: 8px 14px; border-radius: 999px; pointer-events: none;
      background: rgba(20,20,22,0.94); border: 1px solid var(--accent-gold, #f0c040);
      color: var(--accent-gold, #f0c040); font-family: 'Space Mono', monospace;
      font-size: 11px; font-weight: 700; letter-spacing: 0.02em; text-align: center;
      box-shadow: 0 4px 18px rgba(0,0,0,0.5); opacity: 0;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #bfToast.show { opacity: 1; transform: translate(-50%, 0); }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  let toastEl = null, toastTimer = null;
  function toast(msg, ms) {
    if (!msg) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'bfToast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // force a restart so a quick second press visibly re-shows it
    toastEl.classList.remove('show'); void toastEl.offsetWidth; toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 1700);
  }
  window.showToast3D = toast; // handy for other files (e.g. after a save finishes)

  function flash(btn) {
    btn.classList.remove('bf-flash'); void btn.offsetWidth; btn.classList.add('bf-flash');
    btn.addEventListener('animationend', () => btn.classList.remove('bf-flash'), { once: true });
  }
  function fnName(btn) {
    const m = (btn.getAttribute('onclick') || '').match(/^\s*([A-Za-z0-9_$]+)\s*\(/);
    return m ? m[1] : '';
  }
  // Human label: drop leading emoji/arrows/symbols ("⇤ Snap Back" -> "Snap Back"),
  // fall back to title/aria-label for icon-only buttons (⚙, ±, ⇄).
  function labelOf(btn) {
    let t = (btn.textContent || '').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z0-9]+/, '').trim();
    if (!t) t = (btn.getAttribute('title') || btn.getAttribute('aria-label') || '').trim();
    return t;
  }
  const $ = id => document.getElementById(id);
  const sideName = s => (s === 'left' ? 'Left' : 'Right');

  // Functions that just open/close/scroll something you can already SEE
  // change — glow only, no toast.
  const SILENT = /^(open|close|cancel|toggleJointSettingsPopup|toggleWristPinInfo|scrollTo|toggleHudMinimize)/i;
  // Pick-one / on-off buttons: the toast reports the state AFTER the click.
  const SELECT_FN = new Set(['toggleJoint3D', 'setGizmoMode3D', 'setJointEditorCameraView3D', 'setFacesDotMode3D',
    'setFacesWristSelect3D', 'switchTab', 'switchBodyView', 'ccSwitchPanel', 'toggleBoxDragMode', 'setPose3D']);
  // Actions with a specific, state-checked message (runs after the handler).
  const CUSTOM = {
    applyWristPin3D() {
      const s = facesWristSelected3D, pin = wristPinsForPose3D(currentPose3D)[s];
      return pin ? `${sideName(s)} wrist pinned` : `${sideName(s)} wrist NOT pinned`;
    },
    clearWristPin3D() {
      const s = facesWristSelected3D;
      return wristPinsForPose3D(currentPose3D)[s] ? `${sideName(s)} pin not cleared` : `${sideName(s)} pin cleared`;
    },
    snapWristPin3D() { return `${sideName(facesWristSelected3D)} wrist snapped back`; },
    applyFacesWristAttachment3D() {
      const s = facesWristSelected3D;
      return facesWristAttachment3D[s] ? `${sideName(s)} attached wrist set` : 'Nothing to attach — pick a face first';
    },
    removeFacesWristAttachment3D() {
      const s = facesWristSelected3D;
      return facesWristAttachment3D[s] ? `${sideName(s)} attachment not removed` : `${sideName(s)} attachment removed`;
    },
    mirrorFacesWristAttachment3D() { return 'Attachment mirrored L → R'; },
    mirrorSelectedJoint3D() { return 'Arm + hand mirrored to other side'; },
    resetSelectedJoint3D() { return 'Joint reset'; },
    resetFacesSelection3D() { return 'Face selection cleared'; },
    recenterBody3D() { return 'Camera recentered'; },
    flipJointNumSign3D() { return 'Sign flipped'; },
    copyElbowWristFromPose3D() { return 'Copied onto this pose'; },
    quickSaveJointsToGitHub3D() { return 'Saving to GitHub…'; },
    ghSavePreset() { return 'Saving to GitHub…'; },
    ghLoadPreset() { return 'Loading preset…'; },
    ghRefreshPresetList() { return 'Refreshing list…'; },
    downloadSheet() { return 'Preparing download…'; },
    downloadSheetPng() { return 'Preparing download…'; },
    downloadFace() { return 'Preparing download…'; },
    downloadFacePng() { return 'Preparing download…'; },
    exportExcel() { return 'Preparing Excel file…'; },
    exportFaceExcel() { return 'Preparing Excel file…'; },
    exportFaceJSON() { return 'Preparing JSON file…'; },
    generateHeight() { return 'Body generated'; },
    generateFace() { return 'Face generated'; },
  };

  function report(btn, labelBefore) {
    const custom = btn.getAttribute('data-feedback');
    if (custom === 'off') return;
    if (custom) { toast(custom); return; }
    const fn = fnName(btn);
    // Use the label from BEFORE the handler ran — some buttons rename themselves
    // when pressed (Edit Boxes -> Done Editing).
    const label = labelBefore || labelOf(btn);
    if (SILENT.test(fn) || /^(close|cancel)$/i.test(label)) return;
    if (typeof CUSTOM[fn] === 'function') {
      let msg = null;
      try { msg = CUSTOM[fn](btn); } catch (e) { msg = label ? `${label} pressed` : null; }
      toast(msg); return;
    }
    if (SELECT_FN.has(fn)) {
      if (!label) return;
      if (fn === 'toggleBoxDragMode') { toast(`${label} ${btn.classList.contains('active') ? 'on' : 'off'}`); return; }
      toast(btn.classList.contains('active') ? `${label} selected` : `${label} deselected`);
      return;
    }
    if (label) toast(`${label} ✓`);
  }

  document.addEventListener('pointerdown', e => {
    const btn = e.target.closest && e.target.closest('button');
    if (btn && !btn.disabled) flash(btn);
  }, true);
  let labelBefore = '';
  document.addEventListener('click', e => {  // capture: runs BEFORE the button's own onclick
    const btn = e.target.closest && e.target.closest('button');
    labelBefore = btn ? labelOf(btn) : '';
  }, true);
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn || btn.disabled) return;
    if (!btn.classList.contains('bf-flash')) flash(btn); // keyboard / programmatic activation
    const lb = labelBefore;
    // Let the button's own onclick finish first, so the toast can report the RESULT.
    setTimeout(() => report(btn, lb), 0);
  });
})();
