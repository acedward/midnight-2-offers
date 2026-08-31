#!/usr/bin/env python3
"""Validate a RENDERED docker compose configuration against this repository's frozen
artifact decisions.

`config/artifact-decisions.json` freezes *what* this stack promised to consume;
`images/proof-server-mirror/mirror-manifest.json` freezes the proof-server mirror record.
Neither of them can tell whether Compose actually asks for those bytes. This checker closes
that gap: it reads the document `docker compose config --format json` produces — i.e. after
every `${VAR:-default}` has been resolved exactly the way the daemon will see it — and
asserts the rendered services really do carry the pinned identities and the proof-cache
topology.

What it rejects (each maps to a specification requirement):

  * a tag-only external runtime image reference                             FR-010
  * a node/toolkit reference that is not the frozen official index digest   FR-006
  * a proof-server reference that is not the recorded destination digest    FR-007
  * plain and experimental collapsed onto one image, or aliased             FR-008
  * a proof server with no initializer dependency, or a weak condition      FR-011/FR-012
  * a proof reader with a writable cache mount, or a second writer          FR-011
  * MIDNIGHT_PP pointing at the volume root or the mutable `current` link   FR-012
  * proof data duplicated into a second volume or per variant               FR-013
  * a `command`/`entrypoint` override on a proof-server image               (T0.3 finding)
  * a forced `platform:` on any service                                     SC-002
  * a retired build argument that would read as a live control              FR-017
  * more than one published proof host port                                 T4.2

Usage:
    compose_pins.py <rendered.json> --matrix <path> --mirror <path> [--self-test]

Exit status is 0 when every check passes.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

DIGEST_REF = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")

# Images built by this repository from a local context. They are identified by the build
# context, not by their tag, so a run-specific tag from scripts/pick-ports.sh is fine.
LOCAL_IMAGE_PREFIX = "midnight-2-offers/"

CACHE_VOLUME = "proof-params"
CACHE_MOUNT = "/proof-params"
INITIALIZER = "proof-params-init"


class Failures(list):
    def add(self, where: str, message: str) -> None:
        self.append(f"{where}: {message}")


# ── helpers ──────────────────────────────────────────────────────────────────


def _services(doc: dict) -> dict:
    return doc.get("services") or {}


def _is_local_build(svc: dict) -> bool:
    return bool(svc.get("build")) or str(svc.get("image", "")).startswith(LOCAL_IMAGE_PREFIX)


def _cache_mounts(svc: dict) -> list[dict]:
    return [
        v
        for v in (svc.get("volumes") or [])
        if v.get("type") == "volume" and v.get("source") == CACHE_VOLUME
    ]


# Which service is REQUIRED to run which proof-server variant. Keyed by service name on
# purpose: deriving the variant from the image the service happens to carry would make
# "both servers point at the plain image" internally self-consistent, and the aliasing this
# is here to catch would become invisible. The names are ours, declared in compose/core.yml
# and compose/aa.yml.
PROOF_SERVICE_VARIANT = {
    "proof-server": "plain",
    "aa-proof-server": "experimental",
}


def _repo(image: str) -> str:
    """The repository part of an image reference, digest- or tag-form."""
    head = image.split("@", 1)[0]
    last = head.rsplit("/", 1)[-1]
    return head[: -(len(last) - last.index(":"))] if ":" in last else head


def _proof_services(doc: dict, mirror: dict) -> dict[str, str | None]:
    """service name -> required variant (None = consumes a proof image but is not a
    declared proof service, which is itself a finding)."""
    repos = {m["destination"]["repository"] for m in mirror["mirrors"]}
    repos |= {m["source"]["repository"] for m in mirror["mirrors"]}
    found: dict[str, str | None] = {}
    for name, svc in _services(doc).items():
        if name in PROOF_SERVICE_VARIANT:
            found[name] = PROOF_SERVICE_VARIANT[name]
        elif _repo(svc.get("image") or "") in repos:
            found[name] = None
    return found


def _component(matrix: dict, cid: str) -> dict:
    for c in matrix.get("components", []):
        if c.get("id") == cid:
            return c
    raise KeyError(cid)


# ── checks ───────────────────────────────────────────────────────────────────


def _check_digest_refs(f: Failures, doc: dict) -> None:
    for name, svc in sorted(_services(doc).items()):
        image = svc.get("image")
        if not image:
            f.add(name, "service declares no image")
            continue
        if _is_local_build(svc):
            continue
        if not DIGEST_REF.match(image):
            f.add(
                name,
                f"external runtime image is not digest-pinned: {image!r} "
                "(expected <repository>@sha256:<64 hex>; a tag is not an identity)",
            )


def _check_official_oci(f: Failures, doc: dict, matrix: dict) -> None:
    wanted = {}
    for cid, services in (
        ("midnight-node", ("node",)),
        ("midnight-node-toolkit", ("fund",)),
    ):
        oci = _component(matrix, cid)["oci"]
        expect = f"{oci['repository']}@{oci['indexDigest']}"
        for svc in services:
            wanted[svc] = (cid, expect)

    for name, (cid, expect) in sorted(wanted.items()):
        svc = _services(doc).get(name)
        if svc is None:
            continue  # profile not selected in this rendering
        if svc.get("image") != expect:
            f.add(
                name,
                f"{cid} must be the frozen official index digest {expect!r}, "
                f"rendered {svc.get('image')!r}",
            )


def _check_proof_images(f: Failures, doc: dict, matrix: dict, mirror: dict) -> None:
    by_variant = {m["variant"]: m for m in mirror["mirrors"]}
    refs = {v: m["destination"]["consumerRef"] for v, m in by_variant.items()}

    if len(set(refs.values())) != len(refs):
        f.add("mirror-record", "plain and experimental share one consumer reference")

    # The mirror record and the decision matrix must not have drifted apart.
    for cid, variant in (("proof-server-plain", "plain"), ("proof-server-experimental", "experimental")):
        comp = _component(matrix, cid)
        dest = comp.get("destination") or {}
        expect_repo = by_variant[variant]["destination"]["repository"]
        if dest.get("repository") not in (None, expect_repo):
            f.add(cid, f"matrix destination repository {dest.get('repository')!r} != mirror record {expect_repo!r}")

    found = _proof_services(doc, mirror)
    by_variant_service: dict[str, str] = {}
    for name, variant in sorted(found.items()):
        svc = _services(doc)[name]
        if variant is None:
            f.add(
                name,
                f"consumes the proof-server repository ({svc.get('image')!r}) but is not a "
                "declared proof service; only "
                + " and ".join(sorted(PROOF_SERVICE_VARIANT))
                + " may run a proof server",
            )
            continue
        by_variant_service[variant] = name
        if svc.get("image") != refs[variant]:
            f.add(
                name,
                f"must run the {variant} variant {refs[variant]!r}, rendered "
                f"{svc.get('image')!r}"
                + (
                    "  <-- that is the OTHER variant's image"
                    if svc.get("image") in set(refs.values())
                    else ""
                ),
            )

    if "proof-server" not in found:
        f.add("compose", "no service consumes the plain proof-server mirror")

    # Distinctness in the rendered document itself, not merely in the record: two services
    # required to run different variants may never resolve to the same bytes.
    if len(by_variant_service) > 1:
        images = {v: _services(doc)[n].get("image") for v, n in by_variant_service.items()}
        if len(set(images.values())) != len(images):
            f.add(
                "compose",
                "plain and experimental proof servers resolve to the SAME image "
                f"({sorted(set(images.values()))!r}) — they are different programs "
                "(their executables hash differently and they share no layer) and must "
                "stay separately pinned",
            )


def _check_no_overrides(f: Failures, doc: dict, mirror: dict) -> None:
    for name in sorted(_proof_services(doc, mirror)):
        svc = _services(doc)[name]
        for key in ("command", "entrypoint"):
            if svc.get(key):
                f.add(
                    name,
                    f"overrides `{key}` on a proof-server image; these images have no "
                    "Entrypoint and their Cmd is one argv element containing `--port $PORT`, "
                    "so an override changes how the process is launched",
                )


def _check_cache_topology(f: Failures, doc: dict, matrix: dict, mirror: dict) -> None:
    volumes = doc.get("volumes") or {}
    if CACHE_VOLUME not in volumes:
        f.add("compose", f"no `{CACHE_VOLUME}` volume is declared")

    generation = (matrix.get("proofData") or {}).get("generation")
    if not generation or not SHA256_HEX.match(str(generation)):
        f.add("matrix", "proofData.generation is not a 64-hex content digest")
    expect_pp = f"{CACHE_MOUNT}/generations/{generation}"

    writers: list[str] = []
    readers: list[str] = []
    for name, svc in sorted(_services(doc).items()):
        for mount in _cache_mounts(svc):
            if mount.get("read_only"):
                readers.append(name)
            else:
                writers.append(name)

    if writers != [INITIALIZER]:
        f.add(
            "compose",
            f"the {CACHE_VOLUME} volume must be writable by exactly one service "
            f"({INITIALIZER}); writable in {writers or 'nothing'}",
        )
    if INITIALIZER not in _services(doc):
        f.add("compose", f"no `{INITIALIZER}` service is declared")

    proof_services = _proof_services(doc, mirror)
    for name in sorted(proof_services):
        svc = _services(doc)[name]
        mounts = _cache_mounts(svc)
        if not mounts:
            f.add(name, f"proof server does not mount the shared `{CACHE_VOLUME}` cache")
            continue
        if name not in readers:
            f.add(name, f"proof server mounts `{CACHE_VOLUME}` read-write; readers must be :ro")

        dep = (svc.get("depends_on") or {}).get(INITIALIZER)
        if not dep:
            f.add(
                name,
                f"proof server does not depend on `{INITIALIZER}` — it could start against "
                "an empty, partial or unverified cache",
            )
        elif dep.get("condition") != "service_completed_successfully":
            f.add(
                name,
                f"depends on `{INITIALIZER}` with condition {dep.get('condition')!r}; only "
                "`service_completed_successfully` proves the generation was verified and "
                "atomically activated",
            )

        pp = (svc.get("environment") or {}).get("MIDNIGHT_PP")
        if pp is None:
            f.add(name, "MIDNIGHT_PP is unset, so the server would fetch proof data itself")
        elif pp in (CACHE_MOUNT, f"{CACHE_MOUNT}/", f"{CACHE_MOUNT}/current"):
            f.add(
                name,
                f"MIDNIGHT_PP={pp!r} is the volume root or the mutable `current` pointer; it "
                "must name the FIXED generation directory so a pointer swap cannot move a "
                "running server onto different bytes",
            )
        elif pp != expect_pp:
            f.add(name, f"MIDNIGHT_PP={pp!r}, expected {expect_pp!r}")

        src = (svc.get("environment") or {}).get("MIDNIGHT_PARAM_SOURCE")
        if src and "github" in src.lower():
            f.add(
                name,
                f"MIDNIGHT_PARAM_SOURCE={src!r} — the development-only GitHub warehouse is "
                "not an admissible proof-parameter source",
            )

    # One generation, one copy. A second volume mounted under the cache path, or a bind
    # mount of proof data, would reintroduce the per-variant duplication FR-013 forbids.
    for name, svc in sorted(_services(doc).items()):
        for mount in svc.get("volumes") or []:
            target = mount.get("target") or ""
            if target.startswith(CACHE_MOUNT) and mount.get("source") != CACHE_VOLUME:
                f.add(
                    name,
                    f"mounts {mount.get('source')!r} at {target!r}: proof data must come from "
                    f"the single `{CACHE_VOLUME}` volume and exist exactly once",
                )


def _check_no_platform(f: Failures, doc: dict) -> None:
    for name, svc in sorted(_services(doc).items()):
        if svc.get("platform"):
            f.add(name, f"forces platform {svc['platform']!r}; every image here is multiarch")
        build = svc.get("build") or {}
        if build.get("platforms"):
            f.add(name, f"build forces platforms {build['platforms']!r}")


def _check_build_args(f: Failures, doc: dict, matrix: dict) -> None:
    retired = ("INDEXER_PLATFORM", "INDEXER_REPO", "INDEXER_REF", "INDEXER_RUST_VERSION")
    warehouse = matrix.get("warehouse") or {}
    for name, svc in sorted(_services(doc).items()):
        args = ((svc.get("build") or {}).get("args")) or {}
        for key in retired:
            if key in args:
                f.add(name, f"passes the retired build argument {key}")
        if "WAREHOUSE_REPO" in args and args["WAREHOUSE_REPO"] != warehouse.get("repository"):
            f.add(name, f"WAREHOUSE_REPO={args['WAREHOUSE_REPO']!r} != matrix {warehouse.get('repository')!r}")
        if "WAREHOUSE_RELEASE" in args and args["WAREHOUSE_RELEASE"] != warehouse.get("releaseTag"):
            f.add(name, f"WAREHOUSE_RELEASE={args['WAREHOUSE_RELEASE']!r} != matrix {warehouse.get('releaseTag')!r}")
        if "INDEXER_VERSION" in args:
            want = _component(matrix, "indexer-standalone").get("version")
            if args["INDEXER_VERSION"] != want:
                f.add(name, f"INDEXER_VERSION={args['INDEXER_VERSION']!r} != matrix {want!r}")
        if "PROOF_DATA_GENERATION" in args:
            want = (matrix.get("proofData") or {}).get("generation")
            if args["PROOF_DATA_GENERATION"] != want:
                f.add(name, f"PROOF_DATA_GENERATION={args['PROOF_DATA_GENERATION']!r} != matrix {want!r}")


def _check_proof_ports(f: Failures, doc: dict, mirror: dict) -> None:
    published = []
    for name in sorted(_proof_services(doc, mirror)):
        for port in _services(doc)[name].get("ports") or []:
            if port.get("target") == 6300:
                published.append(f"{name}:{port.get('published')}")
    if len(published) > 1:
        f.add(
            "compose",
            "more than one proof host port is published "
            f"({', '.join(published)}); the experimental server is internal-only",
        )


def validate(doc: dict, matrix: dict, mirror: dict) -> Failures:
    f = Failures()
    _check_digest_refs(f, doc)
    _check_official_oci(f, doc, matrix)
    _check_proof_images(f, doc, matrix, mirror)
    _check_no_overrides(f, doc, mirror)
    _check_cache_topology(f, doc, matrix, mirror)
    _check_no_platform(f, doc)
    _check_build_args(f, doc, matrix)
    _check_proof_ports(f, doc, mirror)
    return f


# ── negative fixtures ────────────────────────────────────────────────────────
#
# Every fixture mutates the REAL rendered document, so a check that stopped biting because
# the compose files were restructured fails here rather than passing vacuously.


def _fx_tag_only_proof(doc):
    doc["services"]["proof-server"]["image"] = "midnightntwrk/proof-server:9.0.0-rc.5"
    return doc


def _fx_tag_only_node(doc):
    doc["services"]["node"]["image"] = "midnightntwrk/midnight-node:2.0.0-rc.4"
    return doc


def _fx_wrong_node_digest(doc):
    doc["services"]["node"]["image"] = "docker.io/midnightntwrk/midnight-node@sha256:" + "0" * 64
    return doc


def _fx_aliased_variants(doc):
    doc["services"]["aa-proof-server"]["image"] = doc["services"]["proof-server"]["image"]
    return doc


def _fx_swapped_variants(doc):
    plain = doc["services"]["proof-server"]["image"]
    doc["services"]["proof-server"]["image"] = doc["services"]["aa-proof-server"]["image"]
    doc["services"]["aa-proof-server"]["image"] = plain
    return doc


def _fx_upstream_registry(doc):
    doc["services"]["proof-server"]["image"] = (
        "docker.io/midnightntwrk/proof-server@sha256:"
        "d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9"
    )
    return doc


def _fx_no_initializer_dependency(doc):
    doc["services"]["proof-server"].pop("depends_on", None)
    return doc


def _fx_weak_dependency_condition(doc):
    doc["services"]["aa-proof-server"]["depends_on"][INITIALIZER]["condition"] = "service_started"
    return doc


def _fx_reader_writable(doc):
    for mount in doc["services"]["proof-server"]["volumes"]:
        if mount.get("source") == CACHE_VOLUME:
            mount["read_only"] = False
    return doc


def _fx_second_writer(doc):
    doc["services"]["indexer"].setdefault("volumes", []).append(
        {"type": "volume", "source": CACHE_VOLUME, "target": CACHE_MOUNT, "read_only": False}
    )
    return doc


def _fx_pp_volume_root(doc):
    doc["services"]["proof-server"]["environment"]["MIDNIGHT_PP"] = CACHE_MOUNT
    return doc


def _fx_pp_current_symlink(doc):
    doc["services"]["proof-server"]["environment"]["MIDNIGHT_PP"] = f"{CACHE_MOUNT}/current"
    return doc


def _fx_pp_wrong_generation(doc):
    doc["services"]["aa-proof-server"]["environment"]["MIDNIGHT_PP"] = (
        f"{CACHE_MOUNT}/generations/" + "0" * 64
    )
    return doc


def _fx_duplicate_proof_data(doc):
    doc["services"]["aa-proof-server"]["volumes"] = [
        {"type": "volume", "source": "aa-proof-params", "target": CACHE_MOUNT, "read_only": True}
    ]
    doc.setdefault("volumes", {})["aa-proof-params"] = {"name": "x_aa-proof-params"}
    return doc


def _fx_missing_cache_mount(doc):
    doc["services"]["aa-proof-server"]["volumes"] = []
    return doc


def _fx_github_param_source(doc):
    doc["services"]["proof-server"]["environment"]["MIDNIGHT_PARAM_SOURCE"] = (
        "https://github.com/effectstream/binaries/releases/download/0.3.120/"
    )
    return doc


def _fx_command_override(doc):
    doc["services"]["proof-server"]["command"] = ["midnight-proof-server", "--port", "6300"]
    return doc


def _fx_entrypoint_override(doc):
    doc["services"]["aa-proof-server"]["entrypoint"] = ["/bin/sh", "-c", "true"]
    return doc


def _fx_forced_platform(doc):
    doc["services"]["indexer"]["platform"] = "linux/amd64"
    return doc


def _fx_retired_build_arg(doc):
    doc["services"]["indexer"]["build"]["args"]["INDEXER_PLATFORM"] = "linux/amd64"
    return doc


def _fx_drifted_warehouse_release(doc):
    doc["services"]["indexer"]["build"]["args"]["WAREHOUSE_RELEASE"] = "0.3.999"
    return doc


def _fx_second_proof_port(doc):
    doc["services"]["aa-proof-server"]["ports"] = [
        {"mode": "ingress", "host_ip": "127.0.0.1", "target": 6300, "published": "6301", "protocol": "tcp"}
    ]
    return doc


def _fx_missing_initializer(doc):
    doc["services"].pop(INITIALIZER, None)
    return doc


def _fx_generation_build_arg_drift(doc):
    doc["services"][INITIALIZER]["build"]["args"]["PROOF_DATA_GENERATION"] = "1" * 64
    return doc


SELF_TESTS = [
    ("proof-server pinned by tag instead of digest", _fx_tag_only_proof),
    ("node pinned by tag instead of digest", _fx_tag_only_node),
    ("node digest drifted from the frozen matrix", _fx_wrong_node_digest),
    ("plain and experimental aliased onto one image", _fx_aliased_variants),
    ("plain and experimental swapped", _fx_swapped_variants),
    ("proof image taken from an unrecorded (upstream) reference", _fx_upstream_registry),
    ("proof server with no initializer dependency", _fx_no_initializer_dependency),
    ("initializer dependency weakened to service_started", _fx_weak_dependency_condition),
    ("proof reader given a writable cache mount", _fx_reader_writable),
    ("a second service writes the cache volume", _fx_second_writer),
    ("MIDNIGHT_PP pointing at the volume root", _fx_pp_volume_root),
    ("MIDNIGHT_PP pointing at the mutable current symlink", _fx_pp_current_symlink),
    ("MIDNIGHT_PP naming a different generation", _fx_pp_wrong_generation),
    ("proof data duplicated into a per-variant volume", _fx_duplicate_proof_data),
    ("proof server not mounting the shared cache", _fx_missing_cache_mount),
    ("GitHub warehouse set as MIDNIGHT_PARAM_SOURCE", _fx_github_param_source),
    ("command override on a proof-server image", _fx_command_override),
    ("entrypoint override on a proof-server image", _fx_entrypoint_override),
    ("a service forcing linux/amd64", _fx_forced_platform),
    ("a retired INDEXER_PLATFORM build argument", _fx_retired_build_arg),
    ("warehouse release drifted from the matrix", _fx_drifted_warehouse_release),
    ("a second published proof host port", _fx_second_proof_port),
    ("the initializer service removed entirely", _fx_missing_initializer),
    ("proof-data generation build argument drifted", _fx_generation_build_arg_drift),
]


def run_self_test(doc: dict, matrix: dict, mirror: dict) -> int:
    rejected = accepted = 0
    for label, mutate in SELF_TESTS:
        broken = mutate(copy.deepcopy(doc))
        failures = validate(broken, matrix, mirror)
        if failures:
            rejected += 1
            print(f"  reject  {label}\n            → {failures[0]}")
        else:
            accepted += 1
            print(f"  ACCEPT  {label}   <-- the checker did not bite")
    print(f"\nnegative fixtures: {rejected} rejected, {accepted} accepted")
    return 0 if accepted == 0 else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("rendered", type=Path, help="`docker compose config --format json` output ('-' for stdin)")
    p.add_argument("--matrix", type=Path, required=True)
    p.add_argument("--mirror", type=Path, required=True)
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()

    raw = sys.stdin.read() if str(args.rendered) == "-" else args.rendered.read_text()
    doc = json.loads(raw)
    matrix = json.loads(args.matrix.read_text())
    mirror = json.loads(args.mirror.read_text())

    failures = validate(doc, matrix, mirror)
    for line in failures:
        print(f"FAIL {line}")
    if failures:
        print(f"\n{len(failures)} rendered-compose pin violation(s)")
        return 1
    print(f"rendered compose: {len(_services(doc))} services, all pins verified")

    if args.self_test:
        print()
        return run_self_test(doc, matrix, mirror)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
