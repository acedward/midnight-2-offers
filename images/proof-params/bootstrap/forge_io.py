#!/usr/bin/env python3
"""Shared fail-closed file primitives for forge tools."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterable


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_BASENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$")
NESTED_ARCHIVE_SUFFIXES = (
    ".zip",
    ".tar",
    ".tar.gz",
    ".tgz",
    ".tar.bz2",
    ".tbz2",
    ".tar.xz",
    ".txz",
    ".7z",
    ".rar",
)


class ForgeError(ValueError):
    pass


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise ForgeError(message)


def sha256_stream(stream: BinaryIO, max_bytes: int | None = None) -> tuple[str, int]:
    hasher = hashlib.sha256()
    total = 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if max_bytes is not None and total > max_bytes:
            raise ForgeError(f"stream exceeds byte ceiling {max_bytes}")
        hasher.update(chunk)
    return hasher.hexdigest(), total


def sha256_file(path: Path, max_bytes: int | None = None) -> tuple[str, int]:
    with path.open("rb") as stream:
        return sha256_stream(stream, max_bytes)


def parse_sha256(value: str, label: str = "SHA-256") -> str:
    expect(bool(SHA256_RE.fullmatch(value)), f"invalid {label}: expected 64 lowercase hex characters")
    return value


def safe_basename(value: str, label: str = "name") -> str:
    expect(bool(SAFE_BASENAME_RE.fullmatch(value)), f"unsafe {label}: {value!r}")
    return value


def safe_member_name(value: str) -> str:
    expect("\\" not in value, f"backslash in member path: {value!r}")
    expect(not value.startswith("/"), f"absolute member path: {value!r}")
    path = PurePosixPath(value)
    expect(value not in {"", "."}, "empty member path")
    expect(all(part not in {"", ".", ".."} for part in path.parts), f"unsafe member path: {value!r}")
    expect(not value.startswith("__MACOSX/") and "/__MACOSX/" not in value, f"AppleDouble tree forbidden: {value!r}")
    expect(not any(part.startswith("._") for part in path.parts), f"AppleDouble member forbidden: {value!r}")
    lowered = value.casefold()
    expect(not lowered.endswith(NESTED_ARCHIVE_SUFFIXES), f"nested archive forbidden: {value!r}")
    return value


def collision_key(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def validate_unique_names(names: Iterable[str]) -> None:
    exact: set[str] = set()
    normalized: dict[str, str] = {}
    for name in names:
        safe_member_name(name)
        expect(name not in exact, f"duplicate member path: {name!r}")
        exact.add(name)
        key = collision_key(name)
        expect(key not in normalized, f"case/Unicode-colliding member paths: {normalized.get(key)!r}, {name!r}")
        normalized[key] = name


def load_json(path: Path) -> Any:
    def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            expect(key not in result, f"duplicate JSON key {key!r} in {path}")
            result[key] = value
        return result

    def reject_float(value: str) -> None:
        raise ForgeError(f"floating-point JSON value forbidden in {path}: {value}")

    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=no_duplicates,
            parse_float=reject_float,
            parse_constant=reject_float,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ForgeError(f"cannot load JSON {path}: {exc}") from exc


def canonical_bytes(value: Any) -> bytes:
    def check(item: Any) -> None:
        if isinstance(item, float):
            raise ForgeError("floating-point canonical JSON values are forbidden")
        if isinstance(item, dict):
            expect(all(isinstance(key, str) for key in item), "canonical JSON keys must be strings")
            for nested in item.values():
                check(nested)
        elif isinstance(item, list):
            for nested in item:
                check(nested)
        elif item is not None and not isinstance(item, (str, int, bool)):
            raise ForgeError(f"unsupported canonical JSON type: {type(item).__name__}")

    check(value)
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def create_file_atomic(path: Path, data: bytes, mode: int = 0o644) -> None:
    expect(path.name not in {"", ".", ".."}, "invalid output path")
    expect(path.parent.is_dir(), f"output parent does not exist: {path.parent}")
    expect(not path.exists(), f"refusing to replace existing output: {path}")
    temporary = path.parent / f".{path.name}.tmp-{os.getpid()}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(temporary, flags, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.close(fd)
        fd = -1
        os.chmod(temporary, mode)
        os.link(temporary, path)
        os.unlink(temporary)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def normalized_mode(st_mode: int) -> str:
    return f"{stat.S_IMODE(st_mode):04o}"


def validate_regular_file(path: Path, expected_mode: str | None = None) -> os.stat_result:
    info = path.lstat()
    expect(stat.S_ISREG(info.st_mode), f"not a regular file: {path}")
    expect(not path.is_symlink(), f"symbolic link forbidden: {path}")
    if expected_mode is not None:
        expect(normalized_mode(info.st_mode) == expected_mode, f"mode mismatch for {path}: expected {expected_mode}, got {normalized_mode(info.st_mode)}")
    return info
