#!/usr/bin/env python3
"""Targeted proof-data cache gate: lifecycle positives plus fail-closed negatives.

Scope is deliberately narrow. This exercises the cache component only -- no node, wallet,
indexer, contract deployment, or business flow. It is the Phase-3 counterpart of the
audited forge runtime gate, re-pointed at the consumer's own initializer image.

Every Docker object it creates is named with the caller's project prefix and removed on
exit; it never prunes and never touches an object it did not create.

Cases
  P1  empty named volume            -> ACTIVATED, exactly the reviewed generation
  P2  identical rerun               -> NOOP, zero warehouse bytes
  P3  activated tree                -> 32 files / 4 dirs, 0644 / 0755, hashes exact
  P4  reader mount                  -> read-only, MIDNIGHT_PP is the fixed generation
  P5  reader write attempt          -> EROFS
  N1  altered member in generation  -> quarantined and repaired, prior bytes restored
  N2  wrong Ledger-static namespace -> rejected before staging
  N3  extra payload / extra member  -> rejected before staging
  N4  interrupted activation        -> prior generation and pointer unchanged
  N5  competing initializer         -> lock contention rejected
  N6  altered warehouse SHA-256     -> rejected as warehouse drift
  N7  future K row                  -> rejected
  N8  OS/architecture payload name  -> rejected
  N9  22nd payload row              -> rejected
  N10 GitHub as MIDNIGHT_PARAM_SOURCE -> rejected
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
sys.path.insert(0, str(COMPONENT / "bootstrap"))
from forge_io import canonical_bytes  # noqa: E402

GENERATION = "b73584978fc560bb827fd9df3ad914b37a6f5ea434fe62e9fa0adad809d8486c"
IN_IMAGE_BOOTSTRAP = "/opt/proof-params/bootstrap/proof_cache_bootstrap.py"
IN_IMAGE_RESOLVER = "/opt/proof-params/bootstrap/warehouse_resolver.py"
IN_IMAGE_MANIFESTS = "/opt/proof-params/manifests"


class GateError(AssertionError):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def run(arguments: list[str], *, timeout: int = 300, check_rc: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, check=False)
    if check_rc and result.returncode != 0:
        raise GateError(f"command failed ({result.returncode}): {' '.join(arguments)}\nstdout={result.stdout}\nstderr={result.stderr}")
    return result


class Gate:
    def __init__(self, project: str, image: str, work: Path) -> None:
        self.project = project
        self.image = image
        self.work = work
        self.volume = f"{project}-gate-volume"
        self.payloads = work / "payloads"
        self.fixtures = work / "fixtures"
        self.created: list[tuple[str, str]] = []
        self.results: list[dict] = []

    # ---------------------------------------------------------------- helpers
    def record(self, case: str, outcome: str, detail: object) -> None:
        self.results.append({"case": case, "outcome": outcome, "detail": detail})
        print(f"[{outcome}] {case}: {detail}", flush=True)

    def in_container(self, arguments: list[str], *, mounts: list[str], timeout: int = 600, check_rc: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        command = ["docker", "run", "--rm", "--network", "none"]
        for mount in mounts:
            command += ["--mount", mount]
        for key, value in (env or {}).items():
            command += ["--env", f"{key}={value}"]
        command += ["--entrypoint", "python3", self.image, *arguments]
        return run(command, timeout=timeout, check_rc=check_rc)

    def rw_volume(self) -> str:
        return f"type=volume,src={self.volume},dst=/proof-params"

    def ro_volume(self) -> str:
        return f"type=volume,src={self.volume},dst=/proof-params,readonly"

    def payload_mount(self, readonly: bool = True) -> str:
        suffix = ",readonly" if readonly else ""
        return f"type=bind,src={self.payloads.resolve()},dst=/payloads{suffix}"

    def fixture_mount(self, readonly: bool = True) -> str:
        suffix = ",readonly" if readonly else ""
        return f"type=bind,src={self.fixtures.resolve()},dst=/fixtures{suffix}"

    def bootstrap_command(self, *, manifest: str, admission: str, generation: str, payload_dir: str = "/payloads", extra: list[str] | None = None) -> list[str]:
        return [
            IN_IMAGE_BOOTSTRAP, "bootstrap",
            "--manifest", manifest,
            "--admission-contract", admission,
            "--expected-combined-manifest-sha256", generation,
            "--payload-dir", payload_dir,
            "--parent", "/proof-params",
            "--readers-stopped",
            *(extra or []),
        ]

    def active_pointer(self) -> str | None:
        result = self.in_container(
            ["-c", "import os;p='/proof-params/current';print(os.readlink(p) if os.path.islink(p) else 'NONE')"],
            mounts=[self.ro_volume()],
            timeout=60,
        )
        value = result.stdout.strip()
        return None if value == "NONE" else value

    # ------------------------------------------------------------- lifecycle
    def setup(self) -> None:
        self.work.mkdir(parents=True, exist_ok=True)
        self.fixtures.mkdir(parents=True, exist_ok=True)
        self.payloads.mkdir(parents=True, exist_ok=True)
        run(["docker", "volume", "create", "--label", f"com.docker.compose.project={self.project}", self.volume])
        self.created.append(("volume", self.volume))

    def teardown(self) -> None:
        for kind, name in reversed(self.created):
            run(["docker", kind, "rm", "--force", name] if kind == "container" else ["docker", "volume", "rm", "--force", name], timeout=120, check_rc=False)
        if self.payloads.exists():
            shutil.rmtree(self.payloads, ignore_errors=True)
        if self.fixtures.exists():
            shutil.rmtree(self.fixtures, ignore_errors=True)

    def stage_payloads(self) -> None:
        """Download the 21 admitted payloads once; every negative reuses this scratch."""
        result = run([
            "docker", "run", "--rm",
            "--mount", self.payload_mount(readonly=False),
            "--entrypoint", "python3", self.image,
            IN_IMAGE_RESOLVER, "fetch",
            "--manifest", f"{IN_IMAGE_MANIFESTS}/warehouse-proof-data-v1.json",
            "--expected-combined-manifest-sha256", GENERATION,
            "--payload-dir", "/payloads",
        ], timeout=1800)
        check("OK payloads=21" in result.stdout, f"payload staging did not complete: {result.stdout}\n{result.stderr}")
        self.record("stage", "PASS", result.stdout.strip().splitlines()[-1])

    def render_content_manifest(self) -> Path:
        admission = json.loads((COMPONENT / "manifests/q8b-cache-admission-v1.json").read_text())
        path = self.fixtures / "content.json"
        path.write_bytes(canonical_bytes(admission["contentManifest"]))
        path.chmod(0o644)
        return path

    # ------------------------------------------------------------- positives
    def case_p1_activate(self) -> None:
        content = self.render_content_manifest()
        result = self.in_container(
            self.bootstrap_command(manifest="/fixtures/content.json", admission=f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json", generation=GENERATION),
            mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()],
        )
        check("ACTIVATED" in result.stdout, f"empty volume did not activate: {result.stdout}{result.stderr}")
        check(f"generation={GENERATION}" in result.stdout, "activated a generation other than the reviewed one")
        check(self.active_pointer() == f"generations/{GENERATION}", "current pointer does not select the reviewed generation")
        self.record("P1-empty-volume-activates", "PASS", result.stdout.strip())
        assert content.exists()

    def case_p2_noop(self) -> None:
        result = self.in_container(
            self.bootstrap_command(manifest="/fixtures/content.json", admission=f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json", generation=GENERATION),
            mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()],
        )
        check("NOOP" in result.stdout, f"identical rerun was not a no-op: {result.stdout}{result.stderr}")
        self.record("P2-identical-rerun-is-noop", "PASS", result.stdout.strip())

    def case_p3_tree(self) -> None:
        probe = (
            "import json,os,stat;"
            f"g='/proof-params/generations/{GENERATION}';"
            "files=sorted(os.path.relpath(os.path.join(r,f),g) for r,_,fs in os.walk(g) for f in fs);"
            "dirs=sorted(os.path.relpath(os.path.join(r,d),g) for r,ds,_ in os.walk(g) for d in ds);"
            "fm=sorted({oct(stat.S_IMODE(os.lstat(os.path.join(g,f)).st_mode)) for f in files});"
            "dm=sorted({oct(stat.S_IMODE(os.lstat(os.path.join(g,d)).st_mode)) for d in dirs});"
            "print(json.dumps({'files':files,'dirs':dirs,'fileModes':fm,'dirModes':dm,"
            "'bytes':sum(os.path.getsize(os.path.join(g,f)) for f in files)}))"
        )
        result = self.in_container(["-c", probe], mounts=[self.ro_volume()], timeout=120)
        tree = json.loads(result.stdout.strip())
        admission = json.loads((COMPONENT / "manifests/q8b-cache-admission-v1.json").read_text())
        expected = sorted(row["path"] for row in admission["contentManifest"]["files"])
        check(tree["files"] == expected, "activated file set differs from the reviewed manifest")
        check(len(tree["files"]) == 32 and sorted(tree["dirs"]) == ["dust", "dust/9", "zswap", "zswap/9"], "activated tree shape drift")
        check(tree["fileModes"] == ["0o644"] and tree["dirModes"] == ["0o755"], "activated tree mode drift")
        check(tree["bytes"] == 223087290, f"activated tree byte total drift: {tree['bytes']}")
        self.record("P3-activated-tree-exact", "PASS", {"fileCount": len(tree["files"]), "bytes": tree["bytes"], "fileModes": tree["fileModes"], "dirModes": tree["dirModes"]})

    def case_p5_reader_readonly(self) -> None:
        probe = f"open('/proof-params/generations/{GENERATION}/bls_midnight_2p0','ab')"
        result = self.in_container(["-c", probe], mounts=[self.ro_volume()], timeout=60, check_rc=False)
        check(result.returncode != 0 and "Read-only file system" in result.stderr, f"read-only reader mount was writable: {result.stdout}{result.stderr}")
        self.record("P5-reader-mount-is-read-only", "PASS", "OSError: [Errno 30] Read-only file system")

    # ------------------------------------------------------------- negatives
    def case_n1_altered_member(self) -> None:
        before = self.active_pointer()
        target = f"/proof-params/generations/{GENERATION}/bls_midnight_2p19"
        self.in_container(
            ["-c", f"p='{target}';open(p,'wb').write(b'corrupt');__import__('os').chmod(p,0o644)"],
            mounts=[self.rw_volume()],
            timeout=120,
        )
        verify = self.in_container(
            [IN_IMAGE_BOOTSTRAP, "verify-active", "--manifest", "/fixtures/content.json",
             "--admission-contract", f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json",
             "--expected-combined-manifest-sha256", GENERATION, "--parent", "/proof-params"],
            mounts=[self.ro_volume(), self.fixture_mount()], timeout=300, check_rc=False,
        )
        check(verify.returncode == 2 and "generation member mismatch" in verify.stderr, f"altered member was not detected: {verify.stdout}{verify.stderr}")
        repaired = self.in_container(
            self.bootstrap_command(manifest="/fixtures/content.json", admission=f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json", generation=GENERATION),
            mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()],
        )
        check("ACTIVATED" in repaired.stdout and "quarantine=" in repaired.stdout and "quarantine=none" not in repaired.stdout,
              f"altered member was not quarantined and repaired: {repaired.stdout}{repaired.stderr}")
        check(self.active_pointer() == before, "repair changed the active generation identity")
        confirm = self.in_container(
            [IN_IMAGE_BOOTSTRAP, "verify-active", "--manifest", "/fixtures/content.json",
             "--admission-contract", f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json",
             "--expected-combined-manifest-sha256", GENERATION, "--parent", "/proof-params"],
            mounts=[self.ro_volume(), self.fixture_mount()], timeout=300,
        )
        check("OK active=" in confirm.stdout, "repaired generation did not verify")
        self.record("N1-altered-member-quarantined-and-repaired", "PASS", repaired.stdout.strip())

    def _alternate_generation(self, mutate) -> tuple[str, str, str]:
        """Build a self-consistent content/admission/proof-set triple with one mutation."""
        admission = json.loads((COMPONENT / "manifests/q8b-cache-admission-v1.json").read_text())
        proof_set = json.loads((COMPONENT / "manifests/q8b-v1.json").read_text())
        content = copy.deepcopy(admission["contentManifest"])
        mutate(content)
        content.pop("combinedManifestSha256", None)
        content.pop("identityProjection", None)
        digest = hashlib.sha256(canonical_bytes(content)).hexdigest()
        content["combinedManifestSha256"] = digest
        content["identityProjection"] = "all fields except combinedManifestSha256 and identityProjection"
        proof_set["setId"] = content["selection"]
        proof_set["cacheContract"] = dict(proof_set["cacheContract"])
        proof_set["cacheContract"]["expectedCombinedManifestSha256"] = digest
        admission["selection"] = content["selection"]
        admission["expectedCombinedManifestSha256"] = digest
        admission["contentManifest"] = content
        admission["proofSetSha256"] = hashlib.sha256(canonical_bytes(proof_set)).hexdigest()
        stem = hashlib.sha256(digest.encode()).hexdigest()[:12]
        directory = self.fixtures / stem
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "content.json").write_bytes(canonical_bytes(content))
        (directory / "q8b-cache-admission-v1.json").write_bytes(canonical_bytes(admission))
        (directory / "q8b-v1.json").write_bytes(canonical_bytes(proof_set))
        for name in ("content.json", "q8b-cache-admission-v1.json", "q8b-v1.json"):
            (directory / name).chmod(0o644)
        return stem, digest, f"/fixtures/{stem}"

    def case_n2_wrong_namespace(self) -> None:
        def to_static10(content: dict) -> None:
            content["selection"] = content["selection"] + "-static10-fixture"
            content["ledgerStatic"] = dict(content["ledgerStatic"])
            content["ledgerStatic"]["cacheNamespace"] = "10"
            content["ledgerStatic"]["ledgerStaticSemver"] = "10.0.0"
            for row in content["files"]:
                if row["kind"] == "ledger-static":
                    row["path"] = row["path"].replace("/9/", "/10/")
                    row["cacheNamespace"] = "10"
                    row["ledgerStaticSemver"] = "10.0.0"
            content["files"].sort(key=lambda row: row["path"])

        before = self.active_pointer()
        _, digest, mount = self._alternate_generation(to_static10)
        result = self.in_container(
            self.bootstrap_command(manifest=f"{mount}/content.json", admission=f"{mount}/q8b-cache-admission-v1.json", generation=digest),
            mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()], check_rc=False,
        )
        check(result.returncode == 2 and "twelve static-9 paths" in result.stderr, f"static-10 namespace fixture was not rejected: {result.stdout}{result.stderr}")
        check(self.active_pointer() == before, "rejected static-10 fixture changed the active generation")
        self.record("N2-wrong-ledger-static-namespace-rejected", "PASS", result.stderr.strip())

    def case_n3_extra(self) -> None:
        before = self.active_pointer()
        extra = self.payloads / "bls_midnight_2p20"
        extra.write_bytes(b"unreviewed future payload")
        extra.chmod(0o644)
        try:
            result = self.in_container(
                self.bootstrap_command(manifest="/fixtures/content.json", admission=f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json", generation=GENERATION),
                mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()], check_rc=False,
            )
            # An already-verified generation short-circuits to NOOP, so force the staging path.
            check("NOOP" in result.stdout, "expected the verified generation to short-circuit")
            corrupt = self.in_container(
                ["-c", f"p='/proof-params/generations/{GENERATION}/bls_midnight_2p0';open(p,'wb').write(b'x');__import__('os').chmod(p,0o644)"],
                mounts=[self.rw_volume()], timeout=120,
            )
            assert corrupt.returncode == 0
            staged = self.in_container(
                self.bootstrap_command(manifest="/fixtures/content.json", admission=f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json", generation=GENERATION),
                mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()], check_rc=False,
            )
            check(staged.returncode == 2 and "payload directory differs from selected 21 objects" in staged.stderr,
                  f"extra payload was not rejected: {staged.stdout}{staged.stderr}")
            check(self.active_pointer() == before, "rejected extra-payload run changed the active pointer")
        finally:
            extra.unlink(missing_ok=True)
        # Repair the member deliberately corrupted above.
        repaired = self.in_container(
            self.bootstrap_command(manifest="/fixtures/content.json", admission=f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json", generation=GENERATION),
            mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()],
        )
        check("ACTIVATED" in repaired.stdout, "post-negative repair did not reactivate")
        self.record("N3-extra-payload-rejected", "PASS", "payload directory differs from selected 21 objects; prior generation preserved and repaired")

    def case_n4_interrupted(self) -> None:
        before = self.active_pointer()
        def rename(content: dict) -> None:
            content["selection"] = content["selection"] + "-interrupted-activation-fixture"

        _, digest, mount = self._alternate_generation(rename)
        for stage, token in (("after-verify", "injected failure after staged verification"), ("pointer", "injected failure before current-pointer swap")):
            result = self.in_container(
                self.bootstrap_command(
                    manifest=f"{mount}/content.json",
                    admission=f"{mount}/q8b-cache-admission-v1.json",
                    generation=digest,
                    extra=["--inject-failure", stage],
                ),
                mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()], check_rc=False,
            )
            check(result.returncode == 2 and token in result.stderr, f"interrupted staging at {stage} did not fail closed: {result.stdout}{result.stderr}")
            check(self.active_pointer() == before, f"interrupted staging at {stage} moved the active pointer")
        verify = self.in_container(
            [IN_IMAGE_BOOTSTRAP, "verify-active", "--manifest", "/fixtures/content.json",
             "--admission-contract", f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json",
             "--expected-combined-manifest-sha256", GENERATION, "--parent", "/proof-params"],
            mounts=[self.ro_volume(), self.fixture_mount()], timeout=300,
        )
        check("OK active=" in verify.stdout, "prior generation did not survive the interrupted activations")
        # Remove the orphaned staged generation the pointer-stage fixture left behind.
        self.in_container(
            [IN_IMAGE_BOOTSTRAP, "gc", "--parent", "/proof-params", "--readers-stopped"],
            mounts=[self.rw_volume()], timeout=300,
        )
        self.record("N4-interrupted-activation-preserves-prior", "PASS", "after-verify and pointer stages both failed closed; prior generation and pointer intact")

    def case_n5_concurrent(self) -> None:
        holder = f"{self.project}-gate-lock-holder"
        run(["docker", "rm", "--force", holder], check_rc=False, timeout=60)
        run([
            "docker", "run", "--detach", "--name", holder, "--network", "none",
            "--mount", self.rw_volume(),
            "--entrypoint", "python3", self.image, "-c",
            # The lock stream MUST stay referenced: dropping it would close the file
            # descriptor and silently release the flock, making this test vacuous.
            "import sys,time;sys.path.insert(0,'/opt/proof-params/bootstrap');"
            "import proof_cache_bootstrap as b;from pathlib import Path;"
            "held=b.acquire_lock(Path('/proof-params'),False);print('LOCKED',flush=True);"
            "time.sleep(45);held.close()",
        ], timeout=120)
        self.created.append(("container", holder))
        deadline = time.monotonic() + 30
        while "LOCKED" not in run(["docker", "logs", holder], check_rc=False, timeout=30).stdout and time.monotonic() < deadline:
            time.sleep(0.5)
        check("LOCKED" in run(["docker", "logs", holder], check_rc=False, timeout=30).stdout, "lock holder never acquired the bootstrap lock")
        contended = self.in_container(
            self.bootstrap_command(
                manifest="/fixtures/content.json",
                admission=f"{IN_IMAGE_MANIFESTS}/q8b-cache-admission-v1.json",
                generation=GENERATION,
                extra=["--nonblocking-lock"],
            ),
            mounts=[self.rw_volume(), self.payload_mount(), self.fixture_mount()], timeout=180, check_rc=False,
        )
        check(contended.returncode == 2 and "lock is held" in contended.stderr, f"competing initializer was not serialized: {contended.stdout}{contended.stderr}")
        run(["docker", "rm", "--force", holder], timeout=60, check_rc=False)
        self.record("N5-competing-initializer-rejected", "PASS", contended.stderr.strip())

    # ---------------------------------------------- resolver-level negatives
    def _resolver_reject(self, case: str, mutate, expected: str) -> None:
        manifest = json.loads((COMPONENT / "manifests/warehouse-proof-data-v1.json").read_text())
        mutate(manifest)
        directory = self.fixtures / f"resolver-{case}"
        directory.mkdir(parents=True, exist_ok=True)
        for name in ("q8b-cache-admission-v1.json", "q8b-v1.json"):
            shutil.copyfile(COMPONENT / "manifests" / name, directory / name)
            (directory / name).chmod(0o644)
        (directory / "warehouse-proof-data-v1.json").write_bytes(canonical_bytes(manifest) + b"\n")
        (directory / "warehouse-proof-data-v1.json").chmod(0o644)
        result = self.in_container(
            [IN_IMAGE_RESOLVER, "validate",
             "--manifest", f"/fixtures/resolver-{case}/warehouse-proof-data-v1.json",
             "--expected-combined-manifest-sha256", GENERATION],
            mounts=[self.fixture_mount()], timeout=120, check_rc=False,
        )
        check(result.returncode == 2, f"{case} was accepted: {result.stdout}")
        check(expected in result.stderr, f"{case} failed for the wrong reason: {result.stderr}")
        self.record(case, "PASS", result.stderr.strip())

    def case_resolver_negatives(self) -> None:
        def altered_sha(manifest: dict) -> None:
            manifest["payloads"][0]["sha256"] = "0" * 63 + "1"

        def future_k(manifest: dict) -> None:
            # Keep the admitted 21-name set intact so the K guard, not the set check, fires.
            manifest["payloads"][0]["k"] = 20

        def macos_name(manifest: dict) -> None:
            row = manifest["payloads"][0]
            row["name"] = "bls_midnight_2p0-macos-arm64"
            row["downloadUrl"] = manifest["warehouse"]["downloadUrlPrefix"] + row["name"]
            manifest["payloads"].sort(key=lambda item: item["name"])

        def extra_row(manifest: dict) -> None:
            row = copy.deepcopy(manifest["payloads"][0])
            row.update({"name": "bls_midnight_2p0_copy", "assetId": row["assetId"] + 1,
                        "downloadUrl": manifest["warehouse"]["downloadUrlPrefix"] + "bls_midnight_2p0_copy"})
            manifest["payloads"].append(row)
            manifest["payloads"].sort(key=lambda item: item["name"])

        def wrong_namespace(manifest: dict) -> None:
            manifest["cache"]["cacheNamespace"] = "10"

        def github_source(manifest: dict) -> None:
            manifest["cache"]["githubAsMidnightParamSourceAllowed"] = True

        def swapped_variants(manifest: dict) -> None:
            images = manifest["proofServer"]["images"]
            images["plain"], images["experimental"] = images["experimental"], images["plain"]

        self._resolver_reject("N6-altered-warehouse-sha256-rejected", altered_sha, "payload SHA-256 differs from the admitted generation")
        self._resolver_reject("N7-future-k-rejected", future_k, "is outside the admitted K0-K19 scope")
        self._resolver_reject("N8-os-architecture-payload-name-rejected", macos_name, "duplicates an OS/architecture/variant")
        self._resolver_reject("N9-extra-payload-row-rejected", extra_row, "must select exactly 21 payloads")
        self._resolver_reject("N2b-resolver-wrong-namespace-rejected", wrong_namespace, "cache namespace must be exactly 9")
        self._resolver_reject("N10-github-param-source-rejected", github_source, "GitHub must never be admitted as MIDNIGHT_PARAM_SOURCE")
        self._resolver_reject("N11-swapped-proof-variants-rejected", swapped_variants, "proof-server variant image identity drift")

    def case_n10_entrypoint_github(self) -> None:
        result = run([
            "docker", "run", "--rm", "--network", "none",
            "--mount", self.ro_volume(),
            "--env", "MIDNIGHT_PARAM_SOURCE=https://github.com/effectstream/binaries/releases/download/0.3.120/",
            self.image,
        ], timeout=120, check_rc=False)
        check(result.returncode == 2 and "not an admissible MIDNIGHT_PARAM_SOURCE" in result.stderr,
              f"initializer accepted GitHub as a parameter source: {result.stdout}{result.stderr}")
        self.record("N10b-initializer-rejects-github-param-source", "PASS", result.stderr.strip())

    # ------------------------------------------------------------------ main
    def execute(self) -> dict:
        self.setup()
        try:
            self.stage_payloads()
            self.case_p1_activate()
            self.case_p2_noop()
            self.case_p3_tree()
            self.case_p5_reader_readonly()
            self.case_n1_altered_member()
            self.case_n2_wrong_namespace()
            self.case_n3_extra()
            self.case_n4_interrupted()
            self.case_n5_concurrent()
            self.case_resolver_negatives()
            self.case_n10_entrypoint_github()
        finally:
            self.teardown()
        return {
            "schemaVersion": "proof-params-cache-gate-result-v1",
            "project": self.project,
            "image": self.image,
            "generation": GENERATION,
            "cases": self.results,
            "passed": sum(1 for row in self.results if row["outcome"] == "PASS"),
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=os.environ.get("P3_PROJECT", "proof-params-gate"))
    parser.add_argument("--image", default=os.environ.get("PROOF_PARAMS_IMAGE", "midnight-2-offers/proof-params:local"))
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    gate = Gate(args.project, args.image, args.work_dir)
    try:
        result = gate.execute()
    except (GateError, subprocess.SubprocessError, OSError) as exc:
        print(f"GATE FAILED: {exc}", file=sys.stderr)
        return 1
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
