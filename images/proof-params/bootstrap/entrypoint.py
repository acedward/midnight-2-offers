#!/usr/bin/env python3
"""One-shot proof-data cache initializer.

Order of operations, all fail-closed:

  1. validate the pinned warehouse selection against the reviewed Q8B admission contract;
  2. if the expected generation is already active and byte-exact, stop immediately --
     nothing is downloaded and the tree the running readers have mounted is never touched;
  3. otherwise download exactly the 21 admitted noarch payloads into container-local
     scratch, stage, fsync, and atomically activate `generations/<combined-sha256>`;
  4. re-verify the active tree and print one machine-readable summary line.

Step 2 is what makes `docker compose up` after a recreate cost zero warehouse bytes, and
it is also the guard that keeps this initializer from mutating a generation that a proof
server already has open.  Activation itself is only reached when the readers are stopped,
which Compose enforces with `depends_on: { condition: service_completed_successfully }`.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

import proof_cache_bootstrap
import warehouse_resolver
from forge_io import ForgeError, expect

DEFAULT_GENERATION = "b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c"
MANIFEST_DIR = Path(os.environ.get("PROOF_PARAMS_MANIFEST_DIR", "/opt/proof-params/manifests"))
WAREHOUSE_MANIFEST = MANIFEST_DIR / "warehouse-proof-data-v1.json"
ADMISSION_CONTRACT = MANIFEST_DIR / "q8b-cache-admission-v1.json"


def emit(payload: dict) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")), flush=True)


def main() -> int:
    parent = Path(os.environ.get("PROOF_PARAMS_DIR", "/proof-params"))
    work = Path(os.environ.get("PROOF_PARAMS_WORK", "/work"))
    generation = os.environ.get("PROOF_DATA_GENERATION", DEFAULT_GENERATION)
    timeout = int(os.environ.get("PROOF_PARAMS_TIMEOUT_SECONDS", "180"))
    retries = int(os.environ.get("PROOF_PARAMS_RETRIES", "3"))
    payload_dir = work / "payloads"
    content_path = work / "proof-cache-content-manifest-v1.json"
    try:
        # The initializer must never be pointed at the release warehouse as a live
        # proof-server parameter source; that is exactly what this cache replaces.
        source = os.environ.get("MIDNIGHT_PARAM_SOURCE", "")
        expect("github.com" not in source and "githubusercontent" not in source, "GitHub is not an admissible MIDNIGHT_PARAM_SOURCE")

        manifest, admission, proof_set = warehouse_resolver.load_contracts(WAREHOUSE_MANIFEST, generation)
        payloads = warehouse_resolver.validate_manifest(manifest, admission, proof_set)
        expect(parent.is_dir() and not parent.is_symlink(), f"persistent proof-data parent is not a directory: {parent}")

        work.mkdir(parents=True, exist_ok=True)
        warehouse_resolver.render_content_manifest(admission, content_path)

        try:
            active = proof_cache_bootstrap.verify_active(content_path, ADMISSION_CONTRACT, generation, parent)
        except (ForgeError, OSError) as exc:
            active = None
            reason = str(exc)
        else:
            reason = ""

        if active is not None:
            emit({
                "schemaVersion": "proof-params-initializer-result-v1",
                "result": "NOOP",
                "generation": generation,
                "activePath": active,
                "payloadCount": len(payloads),
                "downloadedBytes": 0,
                "warehouseRelease": f"{manifest['warehouse']['repository']}@{manifest['warehouse']['releaseTag']}",
            })
            return 0

        print(f"proof-params: generation {generation} is not active ({reason}); populating from the warehouse", file=sys.stderr, flush=True)
        if payload_dir.exists():
            shutil.rmtree(payload_dir)
        payload_dir.mkdir(parents=True)
        downloaded = warehouse_resolver.fetch(WAREHOUSE_MANIFEST, generation, payload_dir, timeout, retries)
        proof_cache_bootstrap.bootstrap(
            content_path,
            ADMISSION_CONTRACT,
            generation,
            payload_dir,
            parent,
            readers_stopped=True,
            nonblocking=False,
            fail_stage=os.environ.get("PROOF_PARAMS_INJECT_FAILURE") or None,
        )
        activated = proof_cache_bootstrap.verify_active(content_path, ADMISSION_CONTRACT, generation, parent)
        emit({
            "schemaVersion": "proof-params-initializer-result-v1",
            "result": "ACTIVATED",
            "generation": generation,
            "activePath": activated,
            "payloadCount": len(payloads),
            "downloadedBytes": downloaded,
            "warehouseRelease": f"{manifest['warehouse']['repository']}@{manifest['warehouse']['releaseTag']}",
        })
        return 0
    except (ForgeError, OSError, KeyError, TypeError, ValueError, zipfile.BadZipFile) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    finally:
        # Payload scratch lives on the container layer, never in the persistent volume,
        # so the 223 MB of proof data exists exactly once after activation.
        if payload_dir.exists():
            shutil.rmtree(payload_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
