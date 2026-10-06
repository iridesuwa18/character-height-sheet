// ── 3d-init.js ──────────────────────────────────────────────
// Runs the handful of top-level statements that used to fire mid-file in
// the monolithic 3d_character.js (right after POSES3D was defined, right
// after resetDepthSlidersToDefault was defined, etc). Moved here — loaded
// dead last, after every other split file — so they always run with the
// FULL set of functions/data already defined, no matter which file they
// originally sat next to. Order matches the original file exactly.

// Pose sets (every other .json in presets/) start loading first; the saved-edits pull below waits for them
// so edits to a set's poses have something to attach to.
poseSetsReady3D = loadPoseSetsFromPresets3D();
pullPoseOverridesFromGitHub();
resetDepthSlidersToDefault();
renderPosePanel3D();
