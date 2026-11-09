#!/usr/bin/env python3
"""Verify every cataloged blob without extracting files or holding blobs in memory."""
import hashlib
from pathlib import Path, PurePosixPath
import sys
import tarfile


def verify(archive, manifest):
    expected = {}
    for line in Path(manifest).read_text().splitlines():
        project, digest, size = line.split()
        expected[f"blobs/{project}/{digest}"] = (digest, int(size))
    seen = set()
    with tarfile.open(archive, mode="r|*") as stream:
        for entry in stream:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or ".." in path.parts or not (entry.isfile() or entry.isdir()):
                raise ValueError("Unsafe blob archive entry")
            name = str(path)
            if name not in expected:
                continue
            if name in seen or not entry.isfile():
                raise ValueError("Duplicate or invalid cataloged blob")
            digest, size = expected[name]
            if entry.size != size:
                raise ValueError("Blob size mismatch")
            checksum = hashlib.sha256()
            with stream.extractfile(entry) as content:
                for chunk in iter(lambda: content.read(1024 * 1024), b""):
                    checksum.update(chunk)
            if checksum.hexdigest() != digest:
                raise ValueError("Blob hash mismatch")
            seen.add(name)
    if seen != expected.keys():
        raise ValueError("Cataloged blobs are missing")
    print(f"Verified {len(seen)} blob hashes and sizes without extraction.")


if __name__ == "__main__":
    verify(*sys.argv[1:])
