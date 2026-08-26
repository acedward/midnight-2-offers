Placeholder build context for the OPTIONAL k=18 `execute` overlay.

When `AA_EXECUTE_K18=1`, point `AA_K18_DIR` at a handoff folder containing
`execute.zkir` / `execute.bzkir` / `execute.prover` / `execute.verifier`
(e.g. the 00020-manager-k18-main delivery). With the flag off (default),
this stub keeps `docker compose build` working without the artifact.
