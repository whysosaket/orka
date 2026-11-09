import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("verify_blobs", Path(__file__).parents[1] / "deploy/ec2/verify-blobs.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class BackupTests(unittest.TestCase):
    def check(self, mode="w:gz", failure=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content = b"shared content\n" * 100000
            digest = hashlib.sha256(content).hexdigest()
            name = "blobs/project/" + digest
            (root / "manifest").write_text(f"project {digest} {len(content)}\n")
            with tarfile.open(root / "archive", mode) as archive:
                if failure != "missing":
                    body = b"x" + content[1:] if failure == "hash" else content
                    if failure == "size":
                        body = body[:-1]
                    entry = tarfile.TarInfo(name)
                    entry.size = len(body)
                    archive.addfile(entry, io.BytesIO(body))
                    if failure == "duplicate":
                        entry.name = name.replace("blobs/", "blobs/./")
                        archive.addfile(entry, io.BytesIO(body))
                if failure in ("traversal", "symlink"):
                    entry = tarfile.TarInfo("../escape" if failure == "traversal" else "blobs/link")
                    if failure == "symlink":
                        entry.type = tarfile.SYMTYPE
                        entry.linkname = "/etc/passwd"
                    archive.addfile(entry)
            before = set(root.iterdir())
            with contextlib.redirect_stdout(io.StringIO()):
                verifier.verify(root / "archive", root / "manifest")
            self.assertEqual(set(root.iterdir()), before, "Verification must not extract files")

    def test_compressed_and_legacy_archives(self):
        for mode in ("w:gz", "w"):
            with self.subTest(mode=mode):
                self.check(mode)

    def test_rejects_missing_corrupt_duplicate_and_unsafe_entries(self):
        for failure in ("missing", "hash", "size", "duplicate", "traversal", "symlink"):
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                self.check(failure=failure)


if __name__ == "__main__":
    unittest.main()
