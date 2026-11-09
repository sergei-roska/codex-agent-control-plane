# AUT-03 oracle cases handoff

Status: revised after independent review; candidate case set frozen for
independent review. No baseline capture is permitted until an independent
reviewer approves all synthetic input documents and oracle expectations and the
lead records trial conditions in `docs/evidence/aut-03/entry.json`.

## Files and decisions

Created fixture specification and three candidate cases under
`test/fixtures/autonomy/aut-03/cases/`:

- `manifest.json`: declares the case set, exact accepted F2 references,
  synthetic-input status, and review/baseline gate.
- `bounded-dependencies/input.md` and `oracle.json`: bounded multi-requirement
  planning case with a three-task dependency chain and an independent A1
  integration-point investigation, plus explicit paths, checks, and evidence.
  A1 is blocked because the available inputs do not identify a source-backed
  report-page integration point. The oracle requires R4 coverage through the
  existing report-view and JSON endpoint regression tests.
- `owner-decision-required/input.md` and `oracle.json`: 30-versus-90-day
  owner decision; dependent work is blocked and the unapproved engineer draft
  cannot settle it.
- `contradictory-source-blocker/input.md`, `product-security-policy.md`,
  `product-report-requirements.md`, and `oracle.json`: equal-authority approved
  sources conflict about email export; affected planning is blocked pending an
  authoritative owner resolution.

The accepted AUT-01 F2 fixture is reference-only; no bytes were copied or
modified. Its three exact paths and hashes are in `manifest.json` and match
`docs/evidence/aut-01/acceptance.json` and the current files. No accepted
AUT-01 context or map is claimed for any synthetic case. The case files are
candidate evaluation material, not accepted evidence or observed model output.
The independent review found that the first version marked this case ready
without identifying a report-page integration point and omitted R4 regression
coverage. The revision makes the missing integration point an explicit blocker,
adds a non-mutating investigation task, states that existing report-view and
JSON endpoint tests cover R4, and changes the test command to the repository's
`npm test` script (`node --test test/*.test.js`). A second independent review
found that the investigation had been made a prerequisite for independent
serializer work. The revised oracle removes that edge, makes T0 independent,
preserves the T1-T2-T3 dependency chain, and lists valid full orders and the
unblocked partial plan. No product code, tests, tracked documentation, entry
file, or runbook changed.

## Hashes

Fixture hashes (SHA-256):

- `test/fixtures/autonomy/aut-03/cases/manifest.json`:
  `e1dcd068f74291a04576f55ee01a5f9ad5e8db30f2b0e558e22d33c2641432b6`
- `test/fixtures/autonomy/aut-03/cases/bounded-dependencies/input.md`:
  `4d269d915263551f82fbe962b01f711cddc99ff6335fa8d838114b1ab9df619c`
- `test/fixtures/autonomy/aut-03/cases/bounded-dependencies/oracle.json`:
  `4811593346459aff20d9de29e3ac0a2cce689ebccfc07cf04971bc4fa397f7c7`
- `test/fixtures/autonomy/aut-03/cases/owner-decision-required/input.md`:
  `5c6e4e96e81299ba0c53d2184cddb89c3e1cabb3e6d4179fa4147f4cd4b9234b`
- `test/fixtures/autonomy/aut-03/cases/owner-decision-required/oracle.json`:
  `d4589e5fd2acc9363d977f8a7476c046205b019e8d6cce1b615ff8ce2ee588c0`
- `test/fixtures/autonomy/aut-03/cases/contradictory-source-blocker/input.md`:
  `c00f21f35af0f607652cbd5d50dc0114ca67f3064eebbe59aa02cf04140e82db`
- `test/fixtures/autonomy/aut-03/cases/contradictory-source-blocker/oracle.json`:
  `6b501e890570d6950eb84dacb8a9ee2a272b097f78fdfa18356b3425699cb0bd`
- `test/fixtures/autonomy/aut-03/cases/contradictory-source-blocker/product-security-policy.md`:
  `d493c058f8cceb0b94487a5c2bd3aef8445161b9d5115f32d2e94f81c1d1a3d9`
- `test/fixtures/autonomy/aut-03/cases/contradictory-source-blocker/product-report-requirements.md`:
  `8660bc95ef3336162b774aa8453602bade7f5e753901b0b4844157f77b7361e8`

The fixture manifest contains hashes for every synthetic input, oracle, and
additional contradictory-source document. Accepted F2 reference hashes are
also recorded there. This handoff is coordination material and is not included
in the fixture manifest.

## Verification

- `node -e 'JSON.parse(require("fs").readFileSync("test/fixtures/autonomy/aut-03/cases/manifest.json")); console.log("manifest JSON: valid")'`:
  PASS.
- `node -e 'const p=require("./package.json"); console.log(p.scripts.test)'`:
  confirms `node --test test/*.test.js`; the fixture now specifies `npm test`.
- A local graph consistency check confirms T0 has no incoming or outgoing edge,
  T1-T2-T3 remain ordered, all four listed topological orders are valid, and
  the partial plan leaves A1 blocked while T1-T3 remain unblocked: PASS.
- A local Node consistency check rehashed all 9 fixture files, checked their
  manifest values, compared all 3 F2 anchor hashes against the accepted AUT-01
  manifest and working-tree files, and checked fixture bytes for ASCII:
  PASS; 3 case entries, 9 fixture files, 3 anchor references, zero mismatches.
- No tests, live services, or model calls were run.

Independent review remains required because the synthetic case semantics and
oracles are new authored material, including the revised blocker and R4
coverage. No outputs should be scored or treated as a baseline until that
review and the trial-entry declaration are complete.
