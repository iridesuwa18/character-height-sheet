# character-height-sheet
https://iridesuwa18.github.io/character-height-sheet/

## Pose sets (add as many as you like)

Every `.json` file directly in `presets/` is a **pose set**, and every one is the same kind of file
as `pose-overrides.json` (which is simply the first set: the original poses). They're all loaded
automatically at launch and appear in the Pose panel, the 3D editor's Switch Pose list and the
Copy Poses menu. Subfolders (`presets/body`, `presets/face`) are not touched.

Name files anything: `model poses v1.json`, `model poses v2.json`, ...

**Saving:** a pose's edits (⬆ Save in the 3D editor) go back into the file that pose lives in. A pose
from `model poses v2.json` saves into `model poses v2.json`; an original pose saves into
`pose-overrides.json`. Each file only ever receives its own poses' data.

**File layout** (identical to pose-overrides.json): one top-level entry per pose key, plus the reserved
blobs that Save fills in (`_jointEdits`, `_handWristOverrides`, `_wristPins`, `_wristAttachments`,
each keyed by pose key). A brand-new set file only needs the pose entries:

```json
{
  "_name": "Model Poses v1",
  "mv1-hand-on-neck": {
    "label": "Hand on Neck",
    "spineTwist": 10,
    "right": { "shoulder": 80, "shoulderAbd": 40, "elbow": -140, "wrist": -20 }
  }
}
```

- `_name` is optional (defaults to the filename). `section` per pose is optional (defaults to the set name).
- Pose fields are the same as the entries in `js/poses-data.js`: `spineBend/spineSide/spineTwist`,
  `root/rootZ`, and per-limb `hip, hipAbd, hipTurn, knee, ankle, ankleTurn, shoulder, shoulderAbd,
  shoulderRoll, elbow, wrist, wristTurn, wristSwing`. Top level = both sides; inside `left` / `right` = one side.
- Pose keys must be unique across all files (letters, numbers, `-`, `_`, `.`). A clashing or odd key is
  skipped and listed as a warning at the bottom of the Pose panel.
- "Clear saved edits" still only deletes `pose-overrides.json`.

**Search:** the Pose panel, Switch Pose pop-up and Copy Poses pop-up each have a search box (matches name,
key, section and set name; several words must all match) and a set dropdown to search inside one JSON only.

The file list comes from the GitHub API (one request per launch; last list cached in the browser as a
fallback). With a token saved, files are read via the API so you always see your latest save; without one,
visitors read the site's own copy (no API rate limit).
