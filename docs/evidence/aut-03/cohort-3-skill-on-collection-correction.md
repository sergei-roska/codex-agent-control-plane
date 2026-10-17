# AUT-03 cohort 3 skill-on collection correction

The collector omitted the flattened `settingsSha256` and `promptSha256` fields from all four skill-on `run.json` records. The values are present in each hashed `preflight.json` under `pinValidation` and agree with the runtime attestation and the frozen prompt manifest. The correction adds those two fields only; no task was resumed or rerun. Initial run bytes are preserved beside each task as `collection-correction/run-initial.json`.

- `pilot-price-f2` task `5320ac49-ae98-45b9-90ee-dcfacb4b3d8d`:
  - Initial run SHA-256: `7578975ac742a1c96bbce9199b51a7c3ac8a1555cab941d91d2b6fb7e6d86b72`
  - Corrected run SHA-256: `8296711e08ba896dcf4c8aafe690a6ae107c35653dd39c8ac8edca2957aeb188`
  - Settings SHA-256: `5d315d1f1053e2429f012e5aa587672276823cb6859b90a00d36dd41d5d573f3`
  - Prompt SHA-256: `6da3315ce17b1bd7eb9de41adaf85cc32fd9e4f919c9d3f9d837cb0f43773185`
  - Source preflight: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/pilot-price-f2/preflight.json` (`6cbfc07d697839ee59b37ccfbf85898ae1a7deb01a86a3fd7864c87441ba9e53`)
  - Runtime attestation: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/pilot-price-f2/attestation.json` (`6c359fb4552df9470d8be0b1e4792adf0017a26bb58db1cc778c2b3d88139fa5`)
- `bounded-dependencies` task `b637d77a-48d6-457c-8c7f-30fb2a4ea794`:
  - Initial run SHA-256: `d9f176039e313d9c18d6f15ca09251731f90ef43df3dc4be5b8684ee0cd7fc54`
  - Corrected run SHA-256: `2cd01bb80fe9620730702f195e3bc4e8127b4ce6004a7629bee0c776e222f45b`
  - Settings SHA-256: `5d315d1f1053e2429f012e5aa587672276823cb6859b90a00d36dd41d5d573f3`
  - Prompt SHA-256: `2b63683e83ffb7a17381ff4d432aa6d871e2036df76e4d10965a8d193c09bdc3`
  - Source preflight: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/bounded-dependencies/preflight.json` (`3896b682e77052d762cc1c6516c59ffbc45a6224a3ac1fc3a631006019f07c2c`)
  - Runtime attestation: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/bounded-dependencies/attestation.json` (`de92fc59c996bd35b269ad8e8a69dbe8163b127aa23f292dbf1d36341b9b988b`)
- `owner-decision-required` task `5a4c8462-64d7-46e9-9f04-e8654edaf46c`:
  - Initial run SHA-256: `2ffbec07c74464aac346e3ad1e9d757f06a13b9512ec03ac3fe5d4f6fb8b54a7`
  - Corrected run SHA-256: `ed903af6141c10092f63d970ed43136be1ca0140a04a415f95f5fb14f4a488d1`
  - Settings SHA-256: `5d315d1f1053e2429f012e5aa587672276823cb6859b90a00d36dd41d5d573f3`
  - Prompt SHA-256: `3b461e267dcf3258cc86d0eca5a9ed760b0e0fdcb4991642343376880495c514`
  - Source preflight: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/owner-decision-required/preflight.json` (`79c5cd69e710fa32a72afb0bc06502d81eeb550aba71b490e329e61660ae8266`)
  - Runtime attestation: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/owner-decision-required/attestation.json` (`6d7380443a974c5e119f8c5ad446a01c2e5ded02002a12f0f491a0919f5f5489`)
- `contradictory-source-blocker` task `2888f97e-cf8c-461a-a5a2-ee1b58477840`:
  - Initial run SHA-256: `a17a8955a80bb6722226cacab58f49430d8aad945325101a3f3e0d385063ed87`
  - Corrected run SHA-256: `51da09f67c126ea5d8c8c46a76ef6967656586563716152b3ad4bfbf9d636f4c`
  - Settings SHA-256: `5d315d1f1053e2429f012e5aa587672276823cb6859b90a00d36dd41d5d573f3`
  - Prompt SHA-256: `d01368d9d2f97074842cd5c16b969f40fdd0f4a1f5d3fa319e00ceb9d5fd7940`
  - Source preflight: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/contradictory-source-blocker/preflight.json` (`5bc84ed222731ac0e51126e68093ab4edcb486765e20ab124a97a392241859d5`)
  - Runtime attestation: `docs/evidence/aut-03/live-trial/cohort-3/skill-on/contradictory-source-blocker/attestation.json` (`c9877c236937421700e2538344e9b935ac2fe0f6f8296eeedc85d3529ee38651`)

The gate remains closed. Independent review is required before the skill-on freeze can be accepted.
