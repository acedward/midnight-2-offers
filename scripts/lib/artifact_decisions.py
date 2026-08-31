#!/usr/bin/env python3
"""Validate config/artifact-decisions.json — the frozen artifact-selection contract.

This is a static, offline checker. It does not touch the network, Docker, or the
registry; it exists so that a later change cannot silently:

  * repack a good official OCI image under an owner registry,
  * fall back to compiling from source when an exact warehouse binary exists,
  * pin an external runtime by tag instead of by immutable digest,
  * drop a Linux platform from a multiarch image,
  * collapse the plain and experimental proof servers onto one identity,
  * select a macOS (or Windows) warehouse asset for a Linux container,
  * or use a `legacy-unverified` warehouse row without independent official
    byte-equality evidence.

Run `--self-test` to prove the checker actually rejects each of those.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")

SCHEMA_VERSION = "artifact-decision-matrix-v1"
SELECTION_ORDER = ["official-oci", "warehouse-binary", "exact-oci-mirror", "source-build"]
RETAINED_DECISIONS = {"official-upstream-direct", "source-build"}

# Every key whose value is an identity rather than prose. Editing any of them changes
# pinsDigest, so a digest cannot be "fixed" to make a build pass without a visible,
# reviewable regeneration step (--update-pins).
IDENTITY_KEYS = frozenset({
    "alias", "assetCount", "assetId", "assetName", "assetSha256", "assetSize",
    "cacheNamespace", "catalogCommit", "catalogProvenance", "checksumsAssetId",
    "checksumsSha256", "commit", "compatibleImageDigests", "compatibleProofServerVersion",
    "configDigest", "decision", "equalityClass", "executableSha256", "fileCount",
    "generation", "id", "indexDigest", "indexMediaType", "installMode", "layerDigests",
    "ledgerStaticSemver", "linuxArchitectures", "manifestDigest", "memberPath",
    "memberSha256", "memberSize", "name", "outerSha256", "outerSize", "payloadCount",
    "readableTag", "releaseId", "releaseTag", "repository", "selection", "selectionOrder",
    "upstreamAssetId", "upstreamAssetName", "variant", "version",
})


def identity_projection(doc) -> list[str]:
    """Flatten every identity-bearing field to a sorted list of 'path=value' strings."""
    out: list[str] = []

    def walk(node, path: str) -> None:
        if isinstance(node, dict):
            for key in sorted(node):
                child = f"{path}.{key}" if path else key
                if key in IDENTITY_KEYS:
                    out.append(f"{child}={json.dumps(node[key], sort_keys=True, separators=(',', ':'))}")
                walk(node[key], child)
        elif isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, f"{path}[{i}]")

    walk(doc, "")
    return sorted(out)


def compute_pins_digest(doc: dict) -> str:
    projection = dict(doc)
    projection.pop("pinsDigest", None)
    payload = "\n".join(identity_projection(projection)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class Failures(list):
    def add(self, component: str, message: str) -> None:
        self.append(f"{component}: {message}")


def _digest(failures: Failures, where: str, label: str, value) -> None:
    if not isinstance(value, str) or not DIGEST_RE.match(value):
        failures.add(where, f"{label} must be a full 'sha256:<64 hex>' digest, got {value!r}")


def _sha256(failures: Failures, where: str, label: str, value) -> None:
    if not isinstance(value, str) or not SHA256_RE.match(value):
        failures.add(where, f"{label} must be 64 lowercase hex characters, got {value!r}")


def _check_oci_image(failures: Failures, where: str, label: str, image: dict, arches: list[str]) -> None:
    """An external OCI runtime reference must be complete and multiarch."""
    repo = image.get("repository")
    if not isinstance(repo, str) or not repo:
        failures.add(where, f"{label}.repository is missing")
    elif "@" in repo or ":" in repo.rsplit("/", 1)[-1]:
        failures.add(where, f"{label}.repository must be a bare repository, not a tagged/digested ref: {repo!r}")

    _digest(failures, where, f"{label}.indexDigest", image.get("indexDigest"))

    platforms = image.get("platforms")
    if not isinstance(platforms, dict):
        failures.add(where, f"{label}.platforms must be an object")
        return

    expected = {f"linux/{a}" for a in arches}
    actual = set(platforms)
    for missing in sorted(expected - actual):
        failures.add(where, f"{label} is missing required platform {missing}")
    for extra in sorted(actual - expected):
        failures.add(where, f"{label} declares unsupported platform {extra}; only {sorted(expected)} are allowed")

    for pname, p in platforms.items():
        if not isinstance(p, dict):
            failures.add(where, f"{label}.platforms[{pname}] must be an object")
            continue
        _digest(failures, where, f"{label}.platforms[{pname}].manifestDigest", p.get("manifestDigest"))
        _digest(failures, where, f"{label}.platforms[{pname}].configDigest", p.get("configDigest"))
        for i, layer in enumerate(p.get("layerDigests") or []):
            _digest(failures, where, f"{label}.platforms[{pname}].layerDigests[{i}]", layer)
        exe = p.get("executableSha256")
        if exe is not None:
            _sha256(failures, where, f"{label}.platforms[{pname}].executableSha256", exe)


def _check_warehouse_asset(
    failures: Failures, where: str, plat: str, asset: dict, forbidden: list[str], arches: list[str]
) -> None:
    name = asset.get("name")
    if not isinstance(name, str) or not name:
        failures.add(where, f"assets[{plat}].name is missing")
        return

    lowered = name.lower()
    for bad in forbidden:
        if bad in lowered:
            failures.add(
                where,
                f"assets[{plat}] selects {name!r}, which contains the forbidden substring {bad!r}; "
                "a Linux container must never install a macOS/Windows or wrong-flavour asset",
            )

    # The platform key and the asset name must agree, so an amd64 slot cannot be
    # quietly fed the arm64 archive (or vice versa).
    try:
        _os, arch = plat.split("/", 1)
    except ValueError:
        failures.add(where, f"assets key {plat!r} must look like 'linux/<arch>'")
        return
    if _os != "linux":
        failures.add(where, f"assets key {plat!r} must target linux")
    if arch not in arches:
        failures.add(where, f"assets key {plat!r} uses unsupported architecture {arch!r}")
    if arch not in lowered:
        failures.add(where, f"assets[{plat}] name {name!r} does not encode architecture {arch!r}")

    _sha256(failures, where, f"assets[{plat}].outerSha256", asset.get("outerSha256"))
    if not isinstance(asset.get("outerSize"), int) or asset["outerSize"] <= 0:
        failures.add(where, f"assets[{plat}].outerSize must be a positive integer")
    if not isinstance(asset.get("assetId"), int):
        failures.add(where, f"assets[{plat}].assetId must be an integer")
    if not asset.get("memberPath"):
        failures.add(where, f"assets[{plat}].memberPath is missing")

    member = asset.get("memberSha256")
    provenance = asset.get("catalogProvenance")

    if provenance == "known":
        _sha256(failures, where, f"assets[{plat}].memberSha256", member)
        if "officialEquality" in asset:
            failures.add(
                where,
                f"assets[{plat}] is catalogued 'known' and must bind its cataloged source identity "
                "directly rather than carrying a legacy officialEquality record",
            )
        src = asset.get("sourceProvenance")
        if isinstance(src, dict) and not GIT_SHA_RE.match(str(src.get("commit", ""))):
            failures.add(where, f"assets[{plat}].sourceProvenance.commit must be a full 40-hex commit")
    elif provenance == "legacy-unverified":
        # The catalog honestly records null source/member fields for these rows.
        # They must NOT be invented; independent official equality is required instead.
        if member is not None:
            failures.add(
                where,
                f"assets[{plat}] is 'legacy-unverified' so its catalog member hash is null upstream; "
                "recording one here would fabricate provenance",
            )
        if asset.get("sourceProvenance") is not None:
            failures.add(
                where,
                f"assets[{plat}] is 'legacy-unverified'; its catalog source fields are null upstream "
                "and must not be back-filled",
            )
        eq = asset.get("officialEquality")
        if not isinstance(eq, dict) or not eq.get("required"):
            failures.add(
                where,
                f"assets[{plat}] is 'legacy-unverified' and MUST carry an independent officialEquality "
                "record binding the exact official release/tag/asset/checksum",
            )
        else:
            for field in ("repository", "releaseTag", "assetName", "verifiedOn"):
                if not eq.get(field):
                    failures.add(where, f"assets[{plat}].officialEquality.{field} is missing")
            for field in ("releaseId", "assetId", "checksumsAssetId", "assetSize"):
                if not isinstance(eq.get(field), int):
                    failures.add(where, f"assets[{plat}].officialEquality.{field} must be an integer")
            _sha256(failures, where, f"assets[{plat}].officialEquality.assetSha256", eq.get("assetSha256"))
            _sha256(failures, where, f"assets[{plat}].officialEquality.checksumsSha256", eq.get("checksumsSha256"))
            if eq.get("assetSha256") != asset.get("outerSha256"):
                failures.add(
                    where,
                    f"assets[{plat}] equality record does not match: warehouse outer SHA-256 "
                    f"{asset.get('outerSha256')} != official {eq.get('assetSha256')}",
                )
            if isinstance(eq.get("assetSize"), int) and eq["assetSize"] != asset.get("outerSize"):
                failures.add(
                    where,
                    f"assets[{plat}] equality record size mismatch: warehouse {asset.get('outerSize')} "
                    f"!= official {eq['assetSize']}",
                )
            forbidden_hit = [b for b in forbidden if b in str(eq.get("assetName", "")).lower()]
            if forbidden_hit:
                failures.add(
                    where,
                    f"assets[{plat}].officialEquality.assetName {eq.get('assetName')!r} contains "
                    f"forbidden substring {forbidden_hit[0]!r}",
                )
    else:
        failures.add(where, f"assets[{plat}].catalogProvenance must be 'known' or 'legacy-unverified', got {provenance!r}")


def validate(doc: dict) -> Failures:
    failures = Failures()

    if doc.get("schemaVersion") != SCHEMA_VERSION:
        failures.add("document", f"schemaVersion must be {SCHEMA_VERSION!r}, got {doc.get('schemaVersion')!r}")

    expected_pins = compute_pins_digest(doc)
    if doc.get("pinsDigest") != expected_pins:
        failures.add(
            "document",
            "pinsDigest does not cover the current identity fields "
            f"(recorded {doc.get('pinsDigest')!r}, computed {expected_pins!r}). An identity field was edited "
            "without re-verifying it against its source. Re-verify, then run "
            "'./scripts/verify-artifact-decisions.sh --update-pins'.",
        )
    if doc.get("selectionOrder") != SELECTION_ORDER:
        failures.add("document", f"selectionOrder must be exactly {SELECTION_ORDER}, got {doc.get('selectionOrder')!r}")

    arches = doc.get("linuxArchitectures")
    if arches != ["amd64", "arm64"]:
        failures.add("document", f"linuxArchitectures must be exactly ['amd64', 'arm64'], got {arches!r}")
        arches = ["amd64", "arm64"]

    forbidden = [s.lower() for s in doc.get("forbiddenAssetSubstrings") or []]
    for required in ("macos", "darwin", "windows"):
        if required not in forbidden:
            failures.add("document", f"forbiddenAssetSubstrings must include {required!r}")

    wh = doc.get("warehouse") or {}
    if wh.get("mutable") is not True:
        failures.add("warehouse", "the 0.3.120 warehouse is mutable; this must stay recorded truthfully")
    if wh.get("distributionTier") != "development-only":
        failures.add("warehouse", "distributionTier must remain 'development-only'")
    if not GIT_SHA_RE.match(str(wh.get("catalogCommit", ""))):
        failures.add("warehouse", "catalogCommit must be a full 40-hex commit")
    if not isinstance(wh.get("assetCount"), int):
        failures.add("warehouse", "assetCount must be an integer")

    components = doc.get("components")
    if not isinstance(components, list) or not components:
        failures.add("document", "components must be a non-empty list")
        return failures

    seen_ids: set[str] = set()
    mirror_identities: dict[str, list[str]] = {}
    destination_aliases: dict[str, list[str]] = {}

    for comp in components:
        cid = comp.get("id") or "<unnamed>"
        if cid in seen_ids:
            failures.add(cid, "duplicate component id")
        seen_ids.add(cid)

        decision = comp.get("decision")
        if decision not in SELECTION_ORDER:
            failures.add(cid, f"decision {decision!r} is not one of {SELECTION_ORDER}")
        if comp.get("inArtifactNormalizationScope") is not True:
            failures.add(cid, "components[] entries are in artifact-normalization scope; use retainedPaths otherwise")
        if not comp.get("reason"):
            failures.add(cid, "a decision without a recorded reason is not reviewable")
        if not comp.get("version"):
            failures.add(cid, "version is missing")

        has_assets = isinstance(comp.get("assets"), dict) and bool(comp["assets"])

        if decision == "official-oci":
            image = comp.get("oci")
            if not isinstance(image, dict):
                failures.add(cid, "official-oci requires an 'oci' block")
            else:
                _check_oci_image(failures, cid, "oci", image, arches)
            # The whole point of 'official-oci': it must not be quietly repacked.
            if comp.get("destination") is not None:
                failures.add(
                    cid,
                    "an official-oci component must NOT declare a destination registry; repacking a good "
                    "official image under an owner registry is explicitly out of scope",
                )
            if has_assets:
                failures.add(cid, "an official-oci component must not also declare warehouse assets")

        elif decision == "warehouse-binary":
            if not has_assets:
                failures.add(cid, "warehouse-binary requires an 'assets' block keyed by linux/<arch>")
            else:
                missing = {f"linux/{a}" for a in arches} - set(comp["assets"])
                for m in sorted(missing):
                    failures.add(cid, f"warehouse-binary is missing an asset for {m}")
                for plat, asset in comp["assets"].items():
                    if isinstance(asset, dict):
                        _check_warehouse_asset(failures, cid, plat, asset, forbidden, arches)
                    else:
                        failures.add(cid, f"assets[{plat}] must be an object")
            if comp.get("oci") is not None:
                failures.add(cid, "a warehouse-binary component must not also pin an official OCI image")
            src = comp.get("sourceProvenance")
            if isinstance(src, dict) and src.get("role") != "provenance-only":
                failures.add(
                    cid,
                    "sourceProvenance on a warehouse-binary component must be marked role='provenance-only' "
                    "so it can never be read as a build instruction",
                )

        elif decision == "exact-oci-mirror":
            upstream = comp.get("upstream")
            dest = comp.get("destination")
            if not isinstance(upstream, dict):
                failures.add(cid, "exact-oci-mirror requires an 'upstream' block")
            else:
                _check_oci_image(failures, cid, "upstream", upstream, arches)
            if not isinstance(dest, dict):
                failures.add(cid, "exact-oci-mirror requires a 'destination' block")
            else:
                _digest(failures, cid, "destination.indexDigest", dest.get("indexDigest"))
                alias = dest.get("alias")
                if not isinstance(alias, str) or not alias:
                    failures.add(cid, "destination.alias is missing")
                else:
                    variant = comp.get("variant")
                    if variant and variant not in alias:
                        failures.add(
                            cid,
                            f"destination.alias {alias!r} does not name its variant {variant!r}; a generic tag "
                            "must never be able to collapse plain and experimental",
                        )
                    up_digest = (upstream or {}).get("indexDigest", "")
                    prefix = up_digest.replace("sha256:", "")[:8]
                    if prefix and prefix not in alias:
                        failures.add(
                            cid,
                            f"destination.alias {alias!r} does not carry the upstream digest prefix {prefix!r}",
                        )
                    destination_aliases.setdefault(alias, []).append(cid)
                if dest.get("equalityClass") == "exact-mirror":
                    if isinstance(upstream, dict) and dest.get("indexDigest") != upstream.get("indexDigest"):
                        failures.add(
                            cid,
                            "an exact-mirror destination digest must equal its upstream index digest; "
                            "otherwise it requires an explicit Effectstream revision identity instead",
                        )
                elif str(dest.get("equalityClass", "")).startswith("revision:"):
                    if "-es." not in str(dest.get("alias", "")):
                        failures.add(cid, "a non-identical image must use an explicit '-es.N' alias")
                else:
                    failures.add(cid, f"destination.equalityClass {dest.get('equalityClass')!r} is not recognised")
                if dest.get("anonymouslyReadable") is True and not dest.get("verifiedOn"):
                    failures.add(cid, "destination claims anonymous readability but records no verification date")
            if isinstance(upstream, dict):
                mirror_identities.setdefault(str(upstream.get("indexDigest")), []).append(cid)

        elif decision == "source-build":
            if has_assets:
                failures.add(
                    cid,
                    "this component declares warehouse assets, so it must not be built from source; "
                    "an exact reusable executable artifact exists",
                )

    # Plain and experimental must never converge on one identity.
    variants = {c.get("variant"): c for c in components if c.get("variant")}
    if "plain" in variants and "experimental" in variants:
        plain, exp = variants["plain"], variants["experimental"]
        pu = (plain.get("upstream") or {}).get("indexDigest")
        eu = (exp.get("upstream") or {}).get("indexDigest")
        if pu == eu:
            failures.add("proof-server", "plain and experimental upstream index digests are identical")
        pd = (plain.get("destination") or {}).get("indexDigest")
        ed = (exp.get("destination") or {}).get("indexDigest")
        if pd == ed:
            failures.add("proof-server", "plain and experimental destination index digests are identical")
        pa = (plain.get("destination") or {}).get("alias")
        ea = (exp.get("destination") or {}).get("alias")
        if pa == ea:
            failures.add("proof-server", "plain and experimental share a destination alias")
        for arch in arches:
            key = f"linux/{arch}"
            pe = ((plain.get("upstream") or {}).get("platforms") or {}).get(key, {}).get("executableSha256")
            ee = ((exp.get("upstream") or {}).get("platforms") or {}).get(key, {}).get("executableSha256")
            if pe is not None and pe == ee:
                failures.add(
                    "proof-server",
                    f"plain and experimental {key} executables hash identically ({pe}); the experimental "
                    "binary must never be represented as the plain one",
                )

    for digest, owners in mirror_identities.items():
        if len(owners) > 1:
            failures.add("proof-server", f"upstream index {digest} is claimed by more than one component: {owners}")
    for alias, owners in destination_aliases.items():
        if len(owners) > 1:
            failures.add("proof-server", f"destination alias {alias!r} is claimed by more than one component: {owners}")

    pd = doc.get("proofData")
    if not isinstance(pd, dict):
        failures.add("proofData", "the proof-data generation block is missing")
    else:
        _sha256(failures, "proofData", "generation", pd.get("generation"))
        if pd.get("payloadCount") != 21:
            failures.add("proofData", f"payloadCount must be 21, got {pd.get('payloadCount')!r}")
        if pd.get("cacheNamespace") != "9":
            failures.add("proofData", f"cacheNamespace must be '9', got {pd.get('cacheNamespace')!r}")
        if pd.get("midnightParamSourceMustNotBeGitHub") is not True:
            failures.add("proofData", "GitHub must never be set as MIDNIGHT_PARAM_SOURCE")
        mirror_digests = set(pd.get("compatibleImageDigests") or [])
        declared = {
            (c.get("upstream") or {}).get("indexDigest")
            for c in components
            if c.get("decision") == "exact-oci-mirror"
        }
        if mirror_digests != declared:
            failures.add(
                "proofData",
                f"compatibleImageDigests {sorted(mirror_digests)} do not match the mirrored proof images "
                f"{sorted(d for d in declared if d)}",
            )
        src = pd.get("manifestSourceOfTruth") or {}
        if not GIT_SHA_RE.match(str(src.get("commit", ""))):
            failures.add("proofData", "manifestSourceOfTruth.commit must be a full 40-hex commit")
        if not src.get("paths"):
            failures.add("proofData", "manifestSourceOfTruth.paths must name the exact manifests to import")

    for entry in doc.get("retainedPaths") or []:
        rid = entry.get("id") or "<unnamed>"
        if entry.get("inArtifactNormalizationScope") is not False:
            failures.add(rid, "retainedPaths entries must be marked out of artifact-normalization scope")
        if entry.get("decision") not in RETAINED_DECISIONS:
            failures.add(rid, f"decision {entry.get('decision')!r} is not one of {sorted(RETAINED_DECISIONS)}")
        if not entry.get("reason"):
            failures.add(rid, "a retained path without a recorded reason is not reviewable")
        if rid in seen_ids:
            failures.add(rid, "id also appears in components[]; a component is either in scope or retained, not both")

    return failures


# --------------------------------------------------------------------------- #
# Negative self-tests: prove the checker actually rejects the fixture classes
# the plan requires it to reject.
# --------------------------------------------------------------------------- #

def _find(doc: dict, cid: str) -> dict:
    return next(c for c in doc["components"] if c["id"] == cid)


def _fx_altered_asset_digest(doc: dict) -> dict:
    comp = _find(doc, "indexer-standalone")
    comp["assets"]["linux/amd64"]["outerSha256"] = "0" * 64
    return doc


def _fx_altered_digest_laundered(doc: dict) -> dict:
    """Regenerating pinsDigest is not a way out: downgrading a 'known' row to
    'legacy-unverified' to justify an unexplained hash is itself rejected."""
    comp = _find(doc, "indexer-standalone")
    comp["assets"]["linux/amd64"]["outerSha256"] = "0" * 64
    comp["assets"]["linux/amd64"]["memberSha256"] = "0" * 64
    comp["assets"]["linux/amd64"]["catalogProvenance"] = "legacy-unverified"
    return doc


def _fx_altered_official_equality(doc: dict) -> dict:
    comp = _find(doc, "celestia-appd")
    comp["assets"]["linux/amd64"]["officialEquality"]["assetSha256"] = "1" * 64
    return doc


def _fx_missing_legacy_equality(doc: dict) -> dict:
    comp = _find(doc, "celestia-node")
    del comp["assets"]["linux/amd64"]["officialEquality"]
    return doc


def _fx_fabricated_legacy_provenance(doc: dict) -> dict:
    comp = _find(doc, "celestia-node")
    comp["assets"]["linux/amd64"]["memberSha256"] = "2" * 64
    return doc


def _fx_missing_platform(doc: dict) -> dict:
    del _find(doc, "proof-server-plain")["upstream"]["platforms"]["linux/arm64"]
    return doc


def _fx_missing_warehouse_arch(doc: dict) -> dict:
    del _find(doc, "indexer-standalone")["assets"]["linux/arm64"]
    return doc


def _fx_swapped_plain_experimental(doc: dict) -> dict:
    plain = _find(doc, "proof-server-plain")
    exp = _find(doc, "proof-server-experimental")
    exp["upstream"] = copy.deepcopy(plain["upstream"])
    exp["destination"]["indexDigest"] = plain["destination"]["indexDigest"]
    return doc


def _fx_generic_proof_alias(doc: dict) -> dict:
    _find(doc, "proof-server-experimental")["destination"]["alias"] = "9.0.0-rc.5"
    return doc


def _fx_macos_asset(doc: dict) -> dict:
    comp = _find(doc, "indexer-standalone")
    comp["assets"]["linux/arm64"]["name"] = "indexer-standalone-macos-arm64-v4.4.0-rc.3.zip"
    return doc


def _fx_standalone_lookalike(doc: dict) -> dict:
    comp = _find(doc, "celestia-appd")
    comp["assets"]["linux/amd64"]["officialEquality"]["assetName"] = "celestia-app-standalone_Linux_x86_64.tar.gz"
    return doc


def _fx_tag_only_ref(doc: dict) -> dict:
    _find(doc, "midnight-node")["oci"]["indexDigest"] = "2.0.0-rc.4"
    return doc


def _fx_official_repack(doc: dict) -> dict:
    _find(doc, "midnight-node")["destination"] = {
        "repository": "ghcr.io/effectstream/midnight-node",
        "alias": "2.0.0-rc.4",
        "equalityClass": "exact-mirror",
        "indexDigest": _find(doc, "midnight-node")["oci"]["indexDigest"],
    }
    return doc


def _fx_source_build_over_warehouse(doc: dict) -> dict:
    comp = _find(doc, "indexer-standalone")
    comp["decision"] = "source-build"
    return doc


def _fx_arch_name_mismatch(doc: dict) -> dict:
    comp = _find(doc, "celestia-node")
    comp["assets"]["linux/arm64"]["name"] = "celestia-node-linux-amd64-v0.28.4.tar.gz"
    return doc


def _fx_mirror_not_exact(doc: dict) -> dict:
    _find(doc, "proof-server-plain")["destination"]["indexDigest"] = "sha256:" + "3" * 64
    return doc


def _fx_proofdata_wrong_namespace(doc: dict) -> dict:
    doc["proofData"]["cacheNamespace"] = "10"
    return doc


def _fx_proofdata_duplicate_source(doc: dict) -> dict:
    del doc["proofData"]["manifestSourceOfTruth"]["paths"]
    return doc


# (label, mutation, repin). repin=True recomputes pinsDigest after the mutation so the
# fixture exercises its own rule rather than tripping the pins guard. repin=False is used
# only to prove the pins guard itself catches a hand-edited identity field.
SELF_TESTS = [
    ("altered warehouse asset digest, not re-pinned", _fx_altered_asset_digest, False),
    ("altered digest laundered as legacy-unverified", _fx_altered_digest_laundered, True),
    ("altered official equality checksum", _fx_altered_official_equality),
    ("legacy row missing official equality evidence", _fx_missing_legacy_equality),
    ("fabricated provenance on a legacy-unverified row", _fx_fabricated_legacy_provenance),
    ("missing OCI platform", _fx_missing_platform),
    ("missing warehouse architecture", _fx_missing_warehouse_arch),
    ("swapped plain/experimental proof identity", _fx_swapped_plain_experimental),
    ("generic proof-server alias", _fx_generic_proof_alias),
    ("macOS asset selected for a Linux container", _fx_macos_asset),
    ("celestia -standalone look-alike asset", _fx_standalone_lookalike),
    ("tag-only external runtime reference", _fx_tag_only_ref),
    ("repacking a good official OCI image", _fx_official_repack),
    ("source build chosen despite an exact warehouse binary", _fx_source_build_over_warehouse),
    ("architecture/name mismatch in a warehouse asset", _fx_arch_name_mismatch),
    ("exact-mirror destination that is not byte-equal", _fx_mirror_not_exact),
    ("wrong Ledger-static cache namespace", _fx_proofdata_wrong_namespace),
    ("proof-data manifest source of truth erased", _fx_proofdata_duplicate_source),
]


def run_self_test(doc: dict) -> int:
    bad = 0
    for entry in SELF_TESTS:
        label, mutate = entry[0], entry[1]
        repin = entry[2] if len(entry) > 2 else True
        fixture = mutate(copy.deepcopy(doc))
        if repin:
            fixture["pinsDigest"] = compute_pins_digest(fixture)
        failures = validate(fixture)
        if failures:
            print(f"  rejected  {label}")
            print(f"            -> {failures[0]}")
        else:
            print(f"  ACCEPTED  {label}  <-- the validator failed to catch this")
            bad += 1
    return bad


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("matrix", type=Path, help="path to config/artifact-decisions.json")
    parser.add_argument("--self-test", action="store_true", help="also prove the checker rejects known-bad fixtures")
    parser.add_argument(
        "--update-pins",
        action="store_true",
        help="recompute pinsDigest after an identity field was legitimately re-verified against its source",
    )
    args = parser.parse_args()

    try:
        doc = json.loads(args.matrix.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"artifact decision matrix not found: {args.matrix}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"artifact decision matrix is not valid JSON: {exc}", file=sys.stderr)
        return 1

    if args.update_pins:
        recomputed = compute_pins_digest(doc)
        if doc.get("pinsDigest") == recomputed:
            print(f"  pinsDigest already current: {recomputed}")
        else:
            doc["pinsDigest"] = recomputed
            args.matrix.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"  pinsDigest updated to {recomputed}")

    failures = validate(doc)
    if failures:
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        print(f"{len(failures)} artifact-decision violation(s)", file=sys.stderr)
        return 1

    n_components = len(doc.get("components") or [])
    n_retained = len(doc.get("retainedPaths") or [])
    print(f"  matrix is internally consistent: {n_components} in-scope component(s), {n_retained} retained path(s)")

    if args.self_test:
        print(f"  negative fixtures ({len(SELF_TESTS)}):")
        bad = run_self_test(doc)
        if bad:
            print(f"{bad} negative fixture(s) were not rejected", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
