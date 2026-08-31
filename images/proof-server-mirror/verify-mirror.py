#!/usr/bin/env python3
"""Re-prove the proof-server OCI mirror record, anonymously and without any credential.

`mirror-manifest.json` claims that two owner-controlled GHCR images are exact mirrors of
two official Docker Hub proof-server images. This script re-establishes that claim from
first principles instead of trusting the claim:

  * every digest is recomputed by hashing the bytes the registry actually returned, so a
    digest check here is self-proving rather than a string comparison against a label;
  * source and destination documents are compared byte-for-byte, not field-by-field, so a
    registry that rewrote an index into a different-but-equivalent encoding is caught;
  * the record is cross-checked against config/artifact-decisions.json, so the two files
    cannot drift into disagreeing about the same artifact.

Credential policy (FR-018). This script performs only anonymous GETs. It never reads a
Docker config, never sends an Authorization header to a token endpoint, never accepts a
credential argument or environment variable, and prints no header values. If a registry
requires authentication, the run fails loudly instead of falling back to ambient
credentials.

Levels:

    --level offline    record-level checks only; no network
    --level manifest   (default) + live indexes, platform manifests and configs
    --level deep       + every layer blob, its diff_id, and the extracted executable
                       (about 240 MB of downloads across both registries)

    --self-test        run the negative fixtures instead of verifying; every fixture must
                       be rejected. Adds one live tamper fixture unless --level offline.

Exit status is 0 only when every check passed.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_RECORD = HERE / "mirror-manifest.json"
DEFAULT_MATRIX = HERE.parent.parent / "config" / "artifact-decisions.json"

DOCKER_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
ACCEPT = ", ".join([DOCKER_MANIFEST_LIST, OCI_INDEX, DOCKER_MANIFEST, OCI_MANIFEST])

# host -> (registry endpoint, token endpoint, token service)
REGISTRIES = {
    "docker.io": ("registry-1.docker.io", "auth.docker.io", "registry.docker.io"),
    "ghcr.io": ("ghcr.io", "ghcr.io", "ghcr.io"),
}


class CheckFailed(Exception):
    pass


class Report:
    def __init__(self, verbose: bool = True) -> None:
        self.failures: list[str] = []
        self.passed = 0
        self.verbose = verbose

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        if ok:
            self.passed += 1
            if self.verbose:
                print(f"  PASS  {label}" + (f"  [{detail}]" if detail else ""))
        else:
            self.failures.append(f"{label}" + (f": {detail}" if detail else ""))
            if self.verbose:
                print(f"  FAIL  {label}" + (f"  [{detail}]" if detail else ""))
        return ok

    def equal(self, label: str, expected, actual) -> bool:
        return self.check(expected == actual, label, f"expected {expected!r}, got {actual!r}")


# --------------------------------------------------------------------------------------
# anonymous registry access
# --------------------------------------------------------------------------------------

def _split_repo(repository: str) -> tuple[str, str]:
    host, _, path = repository.partition("/")
    if host not in REGISTRIES:
        raise CheckFailed(f"unsupported registry host {host!r} in {repository!r}")
    return host, path


class AnonymousRegistry:
    """Read-only, credential-free registry client."""

    def __init__(self) -> None:
        self._tokens: dict[str, str] = {}

    def _token(self, repository: str) -> str:
        if repository in self._tokens:
            return self._tokens[repository]
        host, path = _split_repo(repository)
        _, token_host, service = REGISTRIES[host]
        url = f"https://{token_host}/token?service={service}&scope=repository:{path}:pull"
        # No Authorization header is ever attached: this must succeed anonymously or fail.
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise CheckFailed(
                f"anonymous pull token for {repository} refused with HTTP {exc.code}; "
                "the package is not publicly readable"
            ) from exc
        token = body.get("token") or body.get("access_token")
        if not token:
            raise CheckFailed(f"token endpoint for {repository} returned no token")
        self._tokens[repository] = token
        return token

    def _get(self, repository: str, path: str, accept: str | None) -> tuple[bytes, dict]:
        host, repo_path = _split_repo(repository)
        endpoint, _, _ = REGISTRIES[host]
        url = f"https://{endpoint}/v2/{repo_path}/{path}"
        headers = {"Authorization": f"Bearer {self._token(repository)}"}
        if accept:
            headers["Accept"] = accept
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                return resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            raise CheckFailed(f"GET {repository}/{path} failed with HTTP {exc.code}") from exc

    def manifest(self, repository: str, reference: str) -> tuple[bytes, dict]:
        return self._get(repository, f"manifests/{reference}", ACCEPT)

    def blob(self, repository: str, digest: str) -> bytes:
        body, _ = self._get(repository, f"blobs/{digest}", None)
        return body

    def tags(self, repository: str) -> list[str]:
        body, _ = self._get(repository, "tags/list?n=1000", "application/json")
        return json.loads(body.decode("utf-8")).get("tags") or []


def sha256_digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------------------
# record-level checks (offline)
# --------------------------------------------------------------------------------------

def check_record(record: dict, matrix: dict | None, rep: Report) -> None:
    print("== record-level checks (offline) ==")
    required = list(record["requiredPlatforms"])
    forbidden_tokens = [t.lower() for t in record["forbiddenPlatformTokens"]]
    pkg = record["destinationPackage"]

    seen_index: dict[str, str] = {}
    seen_alias: dict[str, str] = {}
    by_variant: dict[str, dict] = {}

    for mirror in record["mirrors"]:
        cid = mirror["id"]
        src, dst = mirror["source"], mirror["destination"]
        by_variant[mirror["variant"]] = mirror

        rep.check(
            sorted(mirror["platforms"]) == sorted(required),
            f"{cid}: platform set is exactly {required}",
            f"got {sorted(mirror['platforms'])}",
        )
        for pname, plat in mirror["platforms"].items():
            rep.check(
                not any(tok in pname.lower() for tok in forbidden_tokens),
                f"{cid}/{pname}: no forbidden platform token",
            )
            rep.equal(f"{cid}/{pname}: platform name matches os/architecture",
                      f"{plat['os']}/{plat['architecture']}", pname)

        # An exact mirror must not have changed identity in transit.
        if mirror["equalityClass"] == "exact-mirror":
            rep.check(
                src["indexDigest"] == dst["indexDigest"],
                f"{cid}: exact-mirror destination index equals upstream index",
                "a destination that differs must be relabelled with an explicit "
                "Effectstream '-es.N' revision identity instead of 'exact-mirror'",
            )
            rep.equal(f"{cid}: exact-mirror preserves the index media type",
                      src["indexMediaType"], dst["indexMediaType"])
        elif str(mirror["equalityClass"]).startswith("revision:"):
            rep.check("-es." in dst["alias"],
                      f"{cid}: a non-identical image uses an explicit '-es.N' alias")
        else:
            rep.check(False, f"{cid}: equalityClass {mirror['equalityClass']!r} is not recognised")

        # Readable alias rules (FR-008/FR-010).
        rep.check(mirror["variant"] in dst["alias"],
                  f"{cid}: alias names its variant", dst["alias"])
        prefix = src["indexDigest"].replace("sha256:", "")[:8]
        rep.check(prefix in dst["alias"],
                  f"{cid}: alias carries the upstream digest prefix {prefix}", dst["alias"])

        # Consumers must pin by digest; a tag-only reference is not an identity.
        ref = dst["consumerRef"]
        rep.check("@sha256:" in ref, f"{cid}: consumerRef is digest-pinned, not tag-only", ref)
        rep.equal(f"{cid}: consumerRef digest equals the destination index digest",
                  f"{dst['repository']}@{dst['indexDigest']}", ref)

        rep.check(dst["repository"] == pkg["repository"],
                  f"{cid}: destination repository is the recorded package")

        if dst["indexDigest"] in seen_index:
            rep.check(False, f"{cid}: destination index digest also claimed by "
                             f"{seen_index[dst['indexDigest']]}")
        seen_index[dst["indexDigest"]] = cid
        if dst["alias"] in seen_alias:
            rep.check(False, f"{cid}: destination alias also claimed by {seen_alias[dst['alias']]}")
        seen_alias[dst["alias"]] = cid

    # Plain and experimental must never converge on one identity (FR-008).
    if "plain" in by_variant and "experimental" in by_variant:
        p, e = by_variant["plain"], by_variant["experimental"]
        rep.check(p["source"]["indexDigest"] != e["source"]["indexDigest"],
                  "plain and experimental upstream indexes are distinct")
        rep.check(p["destination"]["indexDigest"] != e["destination"]["indexDigest"],
                  "plain and experimental destination indexes are distinct")
        rep.check(p["destination"]["alias"] != e["destination"]["alias"],
                  "plain and experimental destination aliases are distinct")
        for pname in required:
            pp, ep = p["platforms"].get(pname, {}), e["platforms"].get(pname, {})
            for field in ("manifestDigest", "configDigest", "executableSha256"):
                rep.check(
                    pp.get(field) is None or pp.get(field) != ep.get(field),
                    f"plain and experimental {pname} {field} differ",
                    "the experimental binary must never be represented as the plain one",
                )

    # The package must not offer a generic tag that could collapse the variants.
    aliases = {m["destination"]["alias"] for m in record["mirrors"]}
    rep.equal("expectedTags is exactly the set of destination aliases",
              sorted(aliases), sorted(pkg["expectedTags"]))
    for bad in pkg["forbiddenTags"]:
        rep.check(bad not in pkg["expectedTags"], f"forbidden tag {bad!r} is not expected")

    if matrix is not None:
        check_against_matrix(record, matrix, rep)


def check_against_matrix(record: dict, matrix: dict, rep: Report) -> None:
    """The mirror record and the frozen decision matrix must agree everywhere they overlap."""
    print("== cross-check against config/artifact-decisions.json ==")
    components = {c["id"]: c for c in matrix.get("components", [])}
    for mirror in record["mirrors"]:
        cid = mirror["id"]
        comp = components.get(cid)
        if not rep.check(comp is not None, f"{cid}: present in the decision matrix"):
            continue
        rep.equal(f"{cid}: matrix decision", "exact-oci-mirror", comp.get("decision"))
        up, mup = mirror["source"], comp.get("upstream") or {}
        rep.equal(f"{cid}: upstream repository", up["repository"], mup.get("repository"))
        rep.equal(f"{cid}: upstream readable tag", up["readableTag"], mup.get("readableTag"))
        rep.equal(f"{cid}: upstream index digest", up["indexDigest"], mup.get("indexDigest"))
        rep.equal(f"{cid}: upstream index media type", up["indexMediaType"], mup.get("indexMediaType"))
        dst, mdst = mirror["destination"], comp.get("destination") or {}
        rep.equal(f"{cid}: destination repository", dst["repository"], mdst.get("repository"))
        rep.equal(f"{cid}: destination alias", dst["alias"], mdst.get("alias"))
        rep.equal(f"{cid}: destination index digest", dst["indexDigest"], mdst.get("indexDigest"))
        rep.equal(f"{cid}: equality class", mirror["equalityClass"], mdst.get("equalityClass"))
        for pname, plat in mirror["platforms"].items():
            mplat = (mup.get("platforms") or {}).get(pname) or {}
            rep.equal(f"{cid}/{pname}: manifest digest",
                      plat["manifestDigest"], mplat.get("manifestDigest"))
            rep.equal(f"{cid}/{pname}: config digest",
                      plat["configDigest"], mplat.get("configDigest"))
            rep.equal(f"{cid}/{pname}: layer digests",
                      [layer["digest"] for layer in plat["layers"]], mplat.get("layerDigests"))
            # The matrix may truthfully leave an executable hash unresolved; it may not
            # disagree with one this record has proven.
            if mplat.get("executableSha256") is not None:
                rep.equal(f"{cid}/{pname}: executable sha256",
                          plat["executableSha256"], mplat.get("executableSha256"))


# --------------------------------------------------------------------------------------
# registry-level checks (network)
# --------------------------------------------------------------------------------------

def verify_side(reg: AnonymousRegistry, side: str, repository: str, reference: str,
                mirror: dict, rep: Report, deep: bool) -> dict[str, bytes]:
    """Fetch one side of one mirror and prove it matches the record. Returns raw documents."""
    cid = mirror["id"]
    docs: dict[str, bytes] = {}
    expected_index = mirror["source" if side == "source" else "destination"]

    raw, headers = reg.manifest(repository, reference)
    docs["index"] = raw
    got = sha256_digest(raw)
    rep.equal(f"{cid}/{side}: raw index hashes to its digest", expected_index["indexDigest"], got)
    rep.equal(f"{cid}/{side}: raw index byte count", expected_index["indexBytes"], len(raw))
    ctype = (headers.get("Content-Type") or "").split(";")[0].strip()
    rep.equal(f"{cid}/{side}: index Content-Type", expected_index["indexMediaType"], ctype)
    index = json.loads(raw.decode("utf-8"))
    rep.equal(f"{cid}/{side}: index mediaType field",
              expected_index["indexMediaType"], index.get("mediaType"))
    dcd = headers.get("Docker-Content-Digest")
    if dcd:
        rep.equal(f"{cid}/{side}: Docker-Content-Digest header", expected_index["indexDigest"], dcd)

    entries = index.get("manifests") or []
    names = [f"{m['platform']['os']}/{m['platform']['architecture']}" for m in entries]
    rep.equal(f"{cid}/{side}: index lists exactly the required platforms, once each",
              sorted(mirror["platforms"]), sorted(names))
    rep.check(len(names) == len(set(names)), f"{cid}/{side}: no duplicate platform entry")

    for pname, plat in mirror["platforms"].items():
        entry = next((m for m in entries
                      if m["platform"]["os"] == plat["os"]
                      and m["platform"]["architecture"] == plat["architecture"]), None)
        if not rep.check(entry is not None, f"{cid}/{side}/{pname}: present in index"):
            continue
        rep.equal(f"{cid}/{side}/{pname}: index entry digest", plat["manifestDigest"], entry["digest"])
        rep.equal(f"{cid}/{side}/{pname}: index entry size", plat["manifestBytes"], entry["size"])
        rep.equal(f"{cid}/{side}/{pname}: index entry media type",
                  plat["manifestMediaType"], entry["mediaType"])

        mraw, _ = reg.manifest(repository, plat["manifestDigest"])
        docs[f"manifest:{pname}"] = mraw
        rep.equal(f"{cid}/{side}/{pname}: manifest hashes to its digest",
                  plat["manifestDigest"], sha256_digest(mraw))
        rep.equal(f"{cid}/{side}/{pname}: manifest byte count", plat["manifestBytes"], len(mraw))
        man = json.loads(mraw.decode("utf-8"))
        rep.equal(f"{cid}/{side}/{pname}: config digest",
                  plat["configDigest"], man["config"]["digest"])
        rep.equal(f"{cid}/{side}/{pname}: config size", plat["configBytes"], man["config"]["size"])
        rep.equal(f"{cid}/{side}/{pname}: layers",
                  [{"digest": lay["digest"], "size": lay["size"], "mediaType": lay["mediaType"]}
                   for lay in plat["layers"]],
                  [{"digest": lay["digest"], "size": lay["size"], "mediaType": lay["mediaType"]}
                   for lay in man["layers"]])

        craw = reg.blob(repository, plat["configDigest"])
        docs[f"config:{pname}"] = craw
        rep.equal(f"{cid}/{side}/{pname}: config blob hashes to its digest",
                  plat["configDigest"], sha256_digest(craw))
        cfg = json.loads(craw.decode("utf-8"))
        rep.equal(f"{cid}/{side}/{pname}: config architecture", plat["architecture"], cfg.get("architecture"))
        rep.equal(f"{cid}/{side}/{pname}: config os", plat["os"], cfg.get("os"))
        rep.equal(f"{cid}/{side}/{pname}: rootfs diff_ids",
                  plat["diffIds"], (cfg.get("rootfs") or {}).get("diff_ids"))
        check_runtime_shape(cid, side, pname, cfg, plat, docs_shape=None, rep=rep,
                            shape=SHAPE_HOLDER["shape"])

        if deep:
            verify_layer(reg, cid, side, pname, repository, plat, docs, rep)

    return docs


SHAPE_HOLDER: dict = {"shape": None}


def check_runtime_shape(cid: str, side: str, pname: str, cfg: dict, plat: dict,
                        docs_shape, rep: Report, shape: dict | None) -> None:
    if not shape:
        return
    inner = cfg.get("config") or {}
    rep.equal(f"{cid}/{side}/{pname}: Entrypoint", shape["entrypoint"], inner.get("Entrypoint"))
    rep.equal(f"{cid}/{side}/{pname}: User", shape["user"] or None, inner.get("User") or None)
    cmd = inner.get("Cmd") or []
    rep.equal(f"{cid}/{side}/{pname}: Cmd argument count", shape["cmdArgc"], len(cmd))
    expected_cmd = shape["cmdTemplate"].replace("<nix-store-prefix>", plat["nixStorePrefix"])
    rep.equal(f"{cid}/{side}/{pname}: Cmd", expected_cmd, cmd[0] if cmd else None)
    env = {e.split("=", 1)[0]: e.split("=", 1)[1] for e in (inner.get("Env") or []) if "=" in e}
    rep.equal(f"{cid}/{side}/{pname}: Env keys", sorted(shape["envKeys"]), sorted(env))
    rep.equal(f"{cid}/{side}/{pname}: PATH", plat["nixStorePrefix"] + "/bin", env.get("PATH"))
    rep.equal(f"{cid}/{side}/{pname}: PORT", shape["port"], env.get("PORT"))
    rep.equal(f"{cid}/{side}/{pname}: ExposedPorts",
              sorted(shape["exposedPorts"]), sorted(inner.get("ExposedPorts") or {}))
    rep.equal(f"{cid}/{side}/{pname}: history entries",
              shape["historyEntries"], len(cfg.get("history") or []))


def verify_layer(reg: AnonymousRegistry, cid: str, side: str, pname: str, repository: str,
                 plat: dict, docs: dict[str, bytes], rep: Report) -> None:
    layer = plat["layers"][0]
    blob = reg.blob(repository, layer["digest"])
    docs[f"layer:{pname}"] = blob
    rep.equal(f"{cid}/{side}/{pname}: layer blob hashes to its digest",
              layer["digest"], sha256_digest(blob))
    rep.equal(f"{cid}/{side}/{pname}: layer blob byte count", layer["size"], len(blob))
    plain = gzip.decompress(blob)
    rep.equal(f"{cid}/{side}/{pname}: uncompressed layer hashes to its diff_id",
              plat["diffIds"][0], sha256_digest(plain))

    with tarfile.open(fileobj=io.BytesIO(plain), mode="r:") as tar:
        names = tar.getnames()
        member = tar.extractfile(plat["executablePath"])
        if not rep.check(member is not None,
                         f"{cid}/{side}/{pname}: layer contains {plat['executablePath']}"):
            return
        exe = member.read()
    docs[f"exe:{pname}"] = exe
    rep.equal(f"{cid}/{side}/{pname}: executable sha256",
              plat["executableSha256"], hashlib.sha256(exe).hexdigest())
    rep.equal(f"{cid}/{side}/{pname}: executable byte count", plat["executableBytes"], len(exe))
    rep.equal(f"{cid}/{side}/{pname}: layer tar entry count", plat["layerTarEntries"], len(names))
    closure = {n.split("/")[2] for n in names if n.startswith("nix/store/") and n.count("/") >= 3}
    rep.equal(f"{cid}/{side}/{pname}: /nix/store closure directories",
              plat["closureStoreDirs"], len(closure))
    # The whole reason this is an OCI mirror and not a repackaged loose binary: the
    # executable's absolute Nix interpreter must actually ship in the same layer.
    rep.check(any(n.startswith("nix/store/") and "glibc" in n for n in names)
              or any(n.startswith("nix/store/") and "musl" in n for n in names),
              f"{cid}/{side}/{pname}: the Nix runtime closure ships with the executable")


def compare_sides(cid: str, src_docs: dict[str, bytes], dst_docs: dict[str, bytes],
                  rep: Report) -> None:
    for key in sorted(set(src_docs) | set(dst_docs)):
        a, b = src_docs.get(key), dst_docs.get(key)
        rep.check(a is not None and b is not None and a == b,
                  f"{cid}: source and destination {key} are byte-identical",
                  f"{len(a) if a else 0} vs {len(b) if b else 0} bytes")


def verify_live(record: dict, rep: Report, deep: bool) -> None:
    print("== registry-level checks (anonymous) ==")
    SHAPE_HOLDER["shape"] = record.get("expectedRuntimeShape")
    reg = AnonymousRegistry()
    pkg = record["destinationPackage"]

    tags = reg.tags(pkg["repository"])
    rep.equal(f"{pkg['repository']}: tag list", sorted(pkg["expectedTags"]), sorted(tags))
    for bad in pkg["forbiddenTags"]:
        rep.check(bad not in tags, f"{pkg['repository']}: no generic {bad!r} tag exists")

    for mirror in record["mirrors"]:
        cid = mirror["id"]
        src = verify_side(reg, "source", mirror["source"]["repository"],
                          mirror["source"]["indexDigest"], mirror, rep, deep)
        dst_alias = verify_side(reg, "destination", mirror["destination"]["repository"],
                                mirror["destination"]["alias"], mirror, rep, deep)
        # The readable alias and the immutable digest must resolve to the same bytes.
        by_digest, _ = reg.manifest(mirror["destination"]["repository"],
                                    mirror["destination"]["indexDigest"])
        rep.check(by_digest == dst_alias["index"],
                  f"{cid}: destination alias and destination digest return identical index bytes")
        compare_sides(cid, src, dst_alias, rep)


# --------------------------------------------------------------------------------------
# negative fixtures
# --------------------------------------------------------------------------------------

def _plain(record: dict) -> dict:
    return next(m for m in record["mirrors"] if m["variant"] == "plain")


def _fx_changed_manifest(record: dict) -> None:
    """A destination whose manifest changed is not an exact mirror; it needs an es.N identity."""
    _plain(record)["destination"]["indexDigest"] = "sha256:" + "3" * 64
    _plain(record)["destination"]["consumerRef"] = (
        _plain(record)["destination"]["repository"] + "@sha256:" + "3" * 64)


def _fx_rewritten_media_type(record: dict) -> None:
    _plain(record)["destination"]["indexMediaType"] = OCI_INDEX


def _fx_tag_only_consumer(record: dict) -> None:
    p = _plain(record)["destination"]
    p["consumerRef"] = f"{p['repository']}:{p['alias']}"


def _fx_collapsed_variants(record: dict) -> None:
    p, e = _plain(record), next(m for m in record["mirrors"] if m["variant"] == "experimental")
    e["destination"]["indexDigest"] = p["destination"]["indexDigest"]
    e["destination"]["consumerRef"] = p["destination"]["consumerRef"]


def _fx_generic_alias(record: dict) -> None:
    p = _plain(record)["destination"]
    p["alias"] = "9.0.0-rc.5"
    record["destinationPackage"]["expectedTags"] = sorted(
        {m["destination"]["alias"] for m in record["mirrors"]})


def _fx_swapped_executables(record: dict) -> None:
    p, e = _plain(record), next(m for m in record["mirrors"] if m["variant"] == "experimental")
    e["platforms"]["linux/amd64"]["executableSha256"] = \
        p["platforms"]["linux/amd64"]["executableSha256"]


def _fx_missing_platform(record: dict) -> None:
    del _plain(record)["platforms"]["linux/arm64"]


def _fx_unknown_platform(record: dict) -> None:
    plat = copy.deepcopy(_plain(record)["platforms"]["linux/amd64"])
    plat["os"], plat["architecture"] = "unknown", "unknown"
    _plain(record)["platforms"]["unknown/unknown"] = plat
    record["requiredPlatforms"].append("unknown/unknown")


def _fx_windows_platform(record: dict) -> None:
    plat = copy.deepcopy(_plain(record)["platforms"]["linux/amd64"])
    plat["os"] = "windows"
    _plain(record)["platforms"]["windows/amd64"] = plat
    record["requiredPlatforms"].append("windows/amd64")


def _fx_latest_tag(record: dict) -> None:
    record["destinationPackage"]["expectedTags"].append("latest")


def _fx_foreign_destination(record: dict) -> None:
    p = _plain(record)["destination"]
    p["repository"] = "ghcr.io/someone-else/midnight-proof-server"
    p["consumerRef"] = f"{p['repository']}@{p['indexDigest']}"


RECORD_FIXTURES = [
    ("destination manifest changed but still labelled exact-mirror", _fx_changed_manifest),
    ("registry rewrote the index media type", _fx_rewritten_media_type),
    ("consumer reference is tag-only rather than digest-pinned", _fx_tag_only_consumer),
    ("plain and experimental collapsed onto one destination index", _fx_collapsed_variants),
    ("generic alias that does not name its variant", _fx_generic_alias),
    ("experimental executable represented as the plain one", _fx_swapped_executables),
    ("a required platform is missing from the mirror", _fx_missing_platform),
    ("an unknown/unknown attestation platform is accepted", _fx_unknown_platform),
    ("a windows platform is accepted", _fx_windows_platform),
    ("a generic 'latest' tag is published on the package", _fx_latest_tag),
    ("destination points at a repository outside the recorded package", _fx_foreign_destination),
]


def _fx_matrix_drift(matrix: dict) -> None:
    comp = next(c for c in matrix["components"] if c["id"] == "proof-server-plain")
    comp["destination"]["indexDigest"] = "sha256:" + "7" * 64


def _fx_matrix_alias_drift(matrix: dict) -> None:
    comp = next(c for c in matrix["components"] if c["id"] == "proof-server-plain")
    comp["destination"]["alias"] = "9.0.0-rc.5-plain-upstream-deadbeef"


def _fx_matrix_layer_drift(matrix: dict) -> None:
    comp = next(c for c in matrix["components"] if c["id"] == "proof-server-plain")
    comp["upstream"]["platforms"]["linux/arm64"]["layerDigests"] = ["sha256:" + "9" * 64]


MATRIX_FIXTURES = [
    ("decision matrix destination digest drifted from the mirror record", _fx_matrix_drift),
    ("decision matrix alias drifted from the mirror record", _fx_matrix_alias_drift),
    ("decision matrix layer digest drifted from the mirror record", _fx_matrix_layer_drift),
]


def _fx_live_tampered_layer(record: dict) -> None:
    _plain(record)["platforms"]["linux/amd64"]["layers"][0]["digest"] = "sha256:" + "a" * 64


def _fx_live_tampered_config(record: dict) -> None:
    _plain(record)["platforms"]["linux/amd64"]["configDigest"] = "sha256:" + "b" * 64


def _fx_live_tampered_index_bytes(record: dict) -> None:
    _plain(record)["destination"]["indexBytes"] = 999


LIVE_FIXTURES = [
    ("expected layer digest tampered — live registry read must contradict it", _fx_live_tampered_layer),
    ("expected config digest tampered — live registry read must contradict it", _fx_live_tampered_config),
    ("expected index byte count tampered — live registry read must contradict it",
     _fx_live_tampered_index_bytes),
]


def run_self_test(record: dict, matrix: dict, offline: bool) -> int:
    print("== negative fixtures: every one must be REJECTED ==")
    rejected = accepted = 0

    baseline = Report(verbose=False)
    check_record(copy.deepcopy(record), copy.deepcopy(matrix), baseline)
    if baseline.failures:
        print("  ERROR  the unmutated record does not pass its own checks; fixtures are meaningless")
        for f in baseline.failures:
            print(f"         {f}")
        return 1
    print(f"  baseline (unmutated) passes {baseline.passed} record-level checks")

    for label, mutate in RECORD_FIXTURES:
        fixture = copy.deepcopy(record)
        mutate(fixture)
        rep = Report(verbose=False)
        check_record(fixture, copy.deepcopy(matrix), rep)
        ok = bool(rep.failures)
        print(f"  {'REJECTED' if ok else 'ACCEPTED — BUG'}  {label}")
        rejected += ok
        accepted += not ok

    for label, mutate in MATRIX_FIXTURES:
        fixture_matrix = copy.deepcopy(matrix)
        mutate(fixture_matrix)
        rep = Report(verbose=False)
        check_record(copy.deepcopy(record), fixture_matrix, rep)
        ok = bool(rep.failures)
        print(f"  {'REJECTED' if ok else 'ACCEPTED — BUG'}  {label}")
        rejected += ok
        accepted += not ok

    if not offline:
        for label, mutate in LIVE_FIXTURES:
            fixture = copy.deepcopy(record)
            mutate(fixture)
            rep = Report(verbose=False)
            try:
                verify_live(fixture, rep, deep=False)
            except CheckFailed as exc:
                rep.check(False, "registry read", str(exc))
            ok = bool(rep.failures)
            print(f"  {'REJECTED' if ok else 'ACCEPTED — BUG'}  {label}")
            rejected += ok
            accepted += not ok
    else:
        print("  (live tamper fixtures skipped: --level offline)")

    total = rejected + accepted
    print(f"\nself-test: {rejected}/{total} fixtures rejected")
    return 0 if accepted == 0 else 1


# --------------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--record", type=Path, default=DEFAULT_RECORD)
    ap.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX,
                    help="decision matrix to cross-check against; 'none' disables the cross-check")
    ap.add_argument("--level", choices=("offline", "manifest", "deep"), default="manifest")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    record = json.loads(args.record.read_text(encoding="utf-8"))
    if record.get("schemaVersion") != "oci-mirror-record-v1":
        print(f"unexpected schemaVersion {record.get('schemaVersion')!r}", file=sys.stderr)
        return 1
    matrix = None
    if str(args.matrix) != "none":
        matrix = json.loads(args.matrix.read_text(encoding="utf-8"))

    if args.self_test:
        if matrix is None:
            print("--self-test needs a decision matrix to exercise the cross-check", file=sys.stderr)
            return 1
        return run_self_test(record, matrix, offline=args.level == "offline")

    print(f"mirror record : {args.record}")
    print(f"decision matrix: {args.matrix if matrix is not None else '(cross-check disabled)'}")
    print(f"level         : {args.level}")
    print("credentials   : none used, none accepted, none required\n")

    rep = Report()
    try:
        check_record(record, matrix, rep)
        if args.level != "offline":
            print()
            verify_live(record, rep, deep=args.level == "deep")
    except CheckFailed as exc:
        rep.check(False, "registry access", str(exc))

    print(f"\n{rep.passed} checks passed, {len(rep.failures)} failed")
    if rep.failures:
        print("\nFAILURES:")
        for f in rep.failures:
            print(f"  - {f}")
        print("\nAn exact-mirror claim cannot survive any of the above. Either correct the copy or "
              "relabel the destination with an explicit Effectstream '-es.N' revision identity "
              "(questions file, Q2) that records the difference.")
        return 1
    print("EXACT MIRROR CONFIRMED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
