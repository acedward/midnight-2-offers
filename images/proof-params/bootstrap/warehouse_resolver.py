#!/usr/bin/env python3
"""Resolve and download exactly the admitted Q8B proof-data payloads from the warehouse.

The reviewed admission contract (`q8b-cache-admission-v1.json`, imported unchanged from
midnight-binary-forge `546185faefcf91f9d1fe9169041b05394e8e4d29`) is the only source of
truth for *what* the generation contains.  This module adds the *where*: a pinned,
non-floating binding from each of the 21 admitted noarch payloads to one exact
`effectstream/binaries@0.3.120` release asset.

Every check below fails closed.  The warehouse release is explicitly mutable and
development-only, so download-time SHA-256 is authoritative: a byte change at a pinned
asset name is treated as warehouse drift and aborts before anything is staged.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from forge_io import (
    ForgeError,
    canonical_bytes,
    expect,
    load_json,
    parse_sha256,
    safe_basename,
    sha256_file,
    validate_regular_file,
)

# Names that would mean the noarch proof data had been duplicated per architecture,
# per operating system, or per proof-server variant (FR-013/FR-016).
FORBIDDEN_NAME_TOKENS = (
    "amd64",
    "arm64",
    "aarch64",
    "darwin",
    "linux",
    "macos",
    "rc.5",
    "windows",
    "x86_64",
)
ADMITTED_K = tuple(range(20))
USER_AGENT = "midnight-2-offers/proof-params-warehouse-resolver-v1"
CHUNK = 1024 * 1024


class HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    """GitHub release downloads redirect to object storage; keep every hop clean HTTPS."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ForgeError(f"redirect target is not credential-free HTTPS: {newurl!r}")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def _check_url(url: str, prefix: str, name: str) -> None:
    expect(url == f"{prefix}{name}", f"payload URL is not the pinned warehouse asset URL: {name}")
    parsed = urllib.parse.urlsplit(url)
    expect(parsed.scheme == "https", f"payload URL must use HTTPS: {name}")
    expect(bool(parsed.hostname) and not parsed.username and not parsed.password, f"payload URL must not embed credentials: {name}")
    expect(parsed.query == "" and parsed.fragment == "", f"payload URL must not carry a query or fragment: {name}")


def load_contracts(manifest_path: Path, expected_digest: str) -> tuple[dict, dict, dict]:
    """Load the warehouse manifest and bind it to the reviewed admission contract."""
    expected_digest = parse_sha256(expected_digest, "expected combined manifest SHA-256")
    manifest = load_json(manifest_path)
    expect(manifest.get("schemaVersion") == "warehouse-proof-data-source-v1", "unsupported warehouse proof-data manifest")
    expect(manifest.get("canonicalization") == "forge-canonical-json-v1", "unsupported warehouse manifest canonicalization")

    admission_ref = manifest.get("admissionContract")
    expect(isinstance(admission_ref, dict), "warehouse manifest is missing its admission-contract binding")
    admission_path = manifest_path.parent / safe_basename(admission_ref["path"], "admission contract path")
    proof_set_path = manifest_path.parent / safe_basename(admission_ref["proofSetPath"], "proof-set path")
    admission = load_json(admission_path)
    proof_set = load_json(proof_set_path)

    expect(admission.get("schemaVersion") == "proof-cache-admission-v1", "unsupported proof-cache admission contract")
    expect(admission.get("canonicalization") == "forge-canonical-json-v1", "unsupported admission canonicalization")
    expect(proof_set.get("schemaVersion") == "proof-data-set-v1" and proof_set.get("decision") == "Q8=B", "sibling is not the reviewed Q8B proof-set contract")
    expect(hashlib.sha256(canonical_bytes(proof_set)).hexdigest() == admission.get("proofSetSha256"), "admission proof-set identity mismatch")
    expect(admission_ref.get("proofSetSha256") == admission.get("proofSetSha256"), "warehouse manifest proof-set identity mismatch")

    # One generation identity, agreed by four independent records.
    expect(manifest.get("expectedCombinedManifestSha256") == expected_digest, "warehouse manifest differs from the configured expected generation")
    expect(admission.get("expectedCombinedManifestSha256") == expected_digest, "admission contract differs from the configured expected generation")
    expect(proof_set.get("cacheContract", {}).get("expectedCombinedManifestSha256") == expected_digest, "Q8B proof-set differs from the configured expected generation")
    expect(admission.get("contentManifest", {}).get("combinedManifestSha256") == expected_digest, "admitted content manifest differs from the configured expected generation")
    expect(manifest.get("selection") == admission.get("selection") == proof_set.get("setId"), "selection identity mismatch")
    return manifest, admission, proof_set


def validate_manifest(manifest: dict, admission: dict, proof_set: dict) -> list[dict]:
    """Prove the warehouse manifest selects exactly the admitted 21 noarch payloads."""
    content = admission["contentManifest"]
    counts = manifest.get("counts")
    expect(
        counts == {"payloadCount": 21, "srsPayloadCount": 20, "ledgerPayloadCount": 1, "fileCount": content["fileCount"]},
        "warehouse manifest payload/file counts differ from the admitted generation",
    )
    expect(content["payloadCount"] == 21 and content["fileCount"] == 32, "admitted generation is not the 21-payload / 32-file Q8B set")
    expect(manifest.get("srsK") == list(ADMITTED_K), "warehouse manifest SRS scope must be exactly K0-K19")

    cache = manifest.get("cache")
    ledger = content["ledgerStatic"]
    expect(isinstance(cache, dict), "warehouse manifest is missing its cache contract")
    expect(cache.get("cacheNamespace") == ledger["cacheNamespace"] == "9", "cache namespace must be exactly 9")
    expect(cache.get("ledgerStaticSemver") == ledger["ledgerStaticSemver"] == "9.0.0", "Ledger-static semver must be exactly 9.0.0")
    expect(cache.get("githubAsMidnightParamSourceAllowed") is False, "GitHub must never be admitted as MIDNIGHT_PARAM_SOURCE")
    expect(proof_set["cacheContract"]["githubAsMidnightParamSourceAllowed"] is False, "Q8B contract must forbid GitHub as MIDNIGHT_PARAM_SOURCE")
    for field in ("defaultSourceUrl", "persistentParent", "generationTemplate", "currentPointer"):
        expect(cache.get(field) == proof_set["cacheContract"][field], f"cache contract drift: {field}")

    # rc.5 compatibility, bound to the exact two reviewed upstream image indexes.
    accepted = proof_set["proofServerCompatibility"]["accepted"]
    server = manifest.get("proofServer")
    expect(isinstance(server, dict), "warehouse manifest is missing its proof-server compatibility record")
    expect(server.get("version") == accepted["version"] == "9.0.0-rc.5", "proof-server compatibility must pin exactly 9.0.0-rc.5")
    expect(server.get("sourceCommit") == accepted["sourceCommit"], "proof-server source-commit drift")
    expect(server.get("images") == accepted["images"] and set(server["images"]) == {"plain", "experimental"}, "proof-server variant image identity drift")
    expect(server["images"]["plain"] != server["images"]["experimental"], "plain and experimental proof images must never share a digest")
    rejected = proof_set["proofServerCompatibility"]["rejectedStatic9"]
    expect(rejected["cacheNamespace"] == "10" and rejected["requiresLedgerStaticSemver"] == "10.0.0", "static-10 negative contract drift")

    warehouse = manifest.get("warehouse")
    expect(isinstance(warehouse, dict), "warehouse manifest is missing its release binding")
    expect(warehouse.get("repository") == "effectstream/binaries" and warehouse.get("releaseTag") == "0.3.120", "warehouse release binding drift")
    expect(warehouse.get("releaseMutability") == "mutable-warehouse" and warehouse.get("distributionTier") == "development-only", "warehouse mutability/tier must be stated truthfully")
    prefix = warehouse.get("downloadUrlPrefix")
    expect(isinstance(prefix, str) and prefix == "https://github.com/effectstream/binaries/releases/download/0.3.120/", "warehouse download prefix drift")

    # Outer identity the cache bootstrap will independently re-demand.
    outer: dict[str, dict] = {}
    for row in content["files"]:
        if row["kind"] == "srs":
            outer[row["outerPayload"]] = {"size": row["size"], "sha256": row["outerSha256"], "kind": "srs", "k": row["k"]}
    outer[ledger["outerPayload"]] = {"size": ledger["outerSize"], "sha256": ledger["outerSha256"], "kind": "ledger-static", "k": None}
    expect(len(outer) == 21, "admitted generation does not resolve to exactly 21 outer payloads")

    payloads = manifest.get("payloads")
    expect(isinstance(payloads, list) and len(payloads) == 21, "warehouse manifest must select exactly 21 payloads")
    names = [row.get("name") for row in payloads]
    expect(all(isinstance(name, str) for name in names), "payload names must be strings")
    expect(names == sorted(names) and len(set(names)) == 21, "payload rows must be uniquely sorted by name")
    # Name hygiene runs BEFORE the set comparison so an OS/architecture/variant-tagged
    # payload reports the reason it is inadmissible rather than the generic set mismatch.
    for name in names:
        safe_basename(name, "warehouse payload name")
        lowered = name.casefold()
        expect(not any(token in lowered for token in FORBIDDEN_NAME_TOKENS), f"proof-data payload duplicates an OS/architecture/variant: {name}")
    expect(set(names) == set(outer), f"warehouse selection differs from the admitted 21 objects: missing={sorted(set(outer)-set(names))}, extra={sorted(set(names)-set(outer))}")

    seen_ids: set[int] = set()
    for row in payloads:
        name = row["name"]
        expect(row.get("platform") == "noarch", f"proof data must be noarch: {name}")
        expect(row.get("legacyProvenance") == "known", f"proof-data row must carry known provenance: {name}")
        expect(row.get("sourceRepository") == "midnightntwrk/midnight-ledger" or row.get("kind") == "srs", f"unexpected source repository: {name}")
        expect(isinstance(row.get("sourceCommit"), str) and len(row["sourceCommit"]) == 40, f"payload source commit must be a full SHA: {name}")
        asset_id = row.get("assetId")
        expect(isinstance(asset_id, int) and asset_id > 0 and asset_id not in seen_ids, f"payload must bind one unique release asset id: {name}")
        seen_ids.add(asset_id)
        _check_url(row.get("downloadUrl", ""), prefix, name)
        reference = outer[name]
        expect(row.get("kind") == reference["kind"], f"payload kind differs from the admitted generation: {name}")
        expect(row.get("size") == reference["size"], f"payload size differs from the admitted generation: {name}")
        expect(parse_sha256(row.get("sha256", ""), f"payload SHA-256 for {name}") == reference["sha256"], f"payload SHA-256 differs from the admitted generation: {name}")
        expect(isinstance(row.get("semanticId"), str) and row["semanticId"], f"payload must carry a semantic identity: {name}")
        if row["kind"] == "srs":
            k = row.get("k")
            expect(isinstance(k, int) and not isinstance(k, bool), f"SRS payload must carry an integer K: {name}")
            expect(k in ADMITTED_K, f"SRS K{k} is outside the admitted K0-K19 scope: {name}")
            expect(name == f"bls_midnight_2p{k}", f"SRS payload name/K mismatch: {name}")
            expect(row["semanticId"].startswith(f"srs/{k}/"), f"SRS semantic identity/K mismatch: {name}")
            expect(row.get("srsGeneration"), f"SRS payload must name its generation: {name}")
        else:
            expect(row.get("k") is None, f"Ledger-static payload must not carry a K: {name}")
            expect(row.get("ledgerStaticSemver") == "9.0.0", f"Ledger-static payload semver must be 9.0.0: {name}")
            expect(row.get("cacheNamespace") == "9", f"Ledger-static payload namespace must be 9: {name}")
            expect(row.get("memberManifestSha256") == ledger["memberManifestSha256"], f"Ledger-static member-manifest identity drift: {name}")
            expect(name == "midnight-ledger-static-noarch-9.0.0.zip", f"Ledger-static payload name drift: {name}")

    srs_k = sorted(row["k"] for row in payloads if row["kind"] == "srs")
    expect(srs_k == list(ADMITTED_K), "warehouse SRS selection must be exactly K0-K19 with no gaps or extras")
    expect(sum(1 for row in payloads if row["kind"] == "ledger-static") == 1, "exactly one Ledger-static payload may be selected")
    forbidden = set(proof_set["scope"]["futureKRequiresReview"]) | set(proof_set["scope"]["directGithubAssetForbiddenK"])
    expect(not (set(srs_k) & forbidden), "warehouse selection contains an unreviewed future K")
    return payloads


def render_content_manifest(admission: dict, destination: Path) -> Path:
    """Materialize the admitted content manifest verbatim; the bootstrap re-verifies it."""
    data = canonical_bytes(admission["contentManifest"])
    temporary = destination.parent / f".{destination.name}.tmp-{os.getpid()}"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, destination)
    return destination


def download(url: str, path: Path, size: int, digest: str, timeout: int, retries: int) -> None:
    expect(not path.exists(), f"refusing to replace an existing payload: {path.name}")
    opener = urllib.request.build_opener(HttpsOnlyRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        temporary = path.parent / f".{path.name}.part-{os.getpid()}-{attempt}"
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
            hasher = hashlib.sha256()
            total = 0
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as output, opener.open(request, timeout=timeout) as response:
                expect(response.geturl().startswith("https://"), "final payload URL is not HTTPS")
                while True:
                    chunk = response.read(min(CHUNK, size - total + 1))
                    if not chunk:
                        break
                    total += len(chunk)
                    expect(total <= size, f"warehouse payload exceeds its pinned size: {path.name}")
                    output.write(chunk)
                    hasher.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            expect(total == size, f"warehouse drift: {path.name} size expected {size}, got {total}")
            actual = hasher.hexdigest()
            expect(actual == digest, f"warehouse drift: {path.name} SHA-256 expected {digest}, got {actual}")
            os.chmod(temporary, 0o644)
            os.link(temporary, path)
            temporary.unlink()
            return
        except (ForgeError, OSError, urllib.error.URLError) as exc:
            last = exc
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            # A pinned-hash mismatch is drift, never a transient fault: do not retry it.
            if isinstance(exc, ForgeError) and "warehouse drift" in str(exc):
                raise
            if attempt != retries:
                time.sleep(attempt)
    raise ForgeError(f"warehouse download failed after {retries} attempts: {url}: {last}")


def verify_payload_dir(payload_dir: Path, payloads: list[dict]) -> int:
    expect(payload_dir.is_dir() and not payload_dir.is_symlink(), "payload directory must be a real directory")
    expected = {row["name"]: row for row in payloads}
    actual = {path.name for path in payload_dir.iterdir()}
    expect(
        actual == set(expected),
        f"payload directory differs from the admitted 21 objects: missing={sorted(set(expected)-actual)}, extra={sorted(actual-set(expected))}",
    )
    total = 0
    for name, row in sorted(expected.items()):
        path = payload_dir / name
        validate_regular_file(path, "0644")
        actual_digest, actual_size = sha256_file(path)
        expect(actual_size == row["size"] and actual_digest == row["sha256"], f"staged payload identity mismatch: {name}")
        total += actual_size
    return total


def fetch(manifest_path: Path, expected_digest: str, payload_dir: Path, timeout: int, retries: int) -> int:
    manifest, admission, proof_set = load_contracts(manifest_path, expected_digest)
    payloads = validate_manifest(manifest, admission, proof_set)
    expect(payload_dir.is_dir() and not payload_dir.is_symlink(), "payload directory must be an existing real directory")
    admitted = {row["name"] for row in payloads}
    for path in payload_dir.iterdir():
        expect(path.name in admitted, f"payload directory already holds an object outside the admitted set: {path.name}")
    downloaded = 0
    for row in sorted(payloads, key=lambda item: item["name"]):
        path = payload_dir / row["name"]
        if path.exists():
            validate_regular_file(path, "0644")
            actual_digest, actual_size = sha256_file(path)
            if actual_size == row["size"] and actual_digest == row["sha256"]:
                print(f"HAVE {row['name']} {actual_size}", flush=True)
                continue
            raise ForgeError(f"pre-existing payload is not the admitted object: {row['name']}")
        download(row["downloadUrl"], path, row["size"], row["sha256"], timeout, retries)
        downloaded += row["size"]
        print(f"GOT {row['name']} {row['size']} {row['sha256']}", flush=True)
    total = verify_payload_dir(payload_dir, payloads)
    print(f"OK payloads=21 bytes={total} downloaded={downloaded} generation={expected_digest}")
    return downloaded


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve exactly the admitted Q8B proof-data payloads from the warehouse.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "fetch", "verify"):
        item = sub.add_parser(name)
        item.add_argument("--manifest", required=True, type=Path)
        item.add_argument("--expected-combined-manifest-sha256", required=True)
        if name != "validate":
            item.add_argument("--payload-dir", required=True, type=Path)
        if name == "fetch":
            item.add_argument("--timeout", type=int, default=180)
            item.add_argument("--retries", type=int, default=3)
    render = sub.add_parser("render-content-manifest")
    render.add_argument("--manifest", required=True, type=Path)
    render.add_argument("--expected-combined-manifest-sha256", required=True)
    render.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "validate":
            manifest, admission, proof_set = load_contracts(args.manifest, args.expected_combined_manifest_sha256)
            payloads = validate_manifest(manifest, admission, proof_set)
            print(f"OK warehouse selection payloads={len(payloads)} srs=20 ledger=1 namespace=9 generation={args.expected_combined_manifest_sha256}")
        elif args.command == "fetch":
            fetch(args.manifest, args.expected_combined_manifest_sha256, args.payload_dir, args.timeout, args.retries)
        elif args.command == "verify":
            manifest, admission, proof_set = load_contracts(args.manifest, args.expected_combined_manifest_sha256)
            payloads = validate_manifest(manifest, admission, proof_set)
            total = verify_payload_dir(args.payload_dir, payloads)
            print(f"OK staged payloads=21 bytes={total}")
        else:
            _, admission, _ = load_contracts(args.manifest, args.expected_combined_manifest_sha256)
            path = render_content_manifest(admission, args.output)
            print(f"OK content-manifest={path}")
        return 0
    except (ForgeError, OSError, KeyError, TypeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
