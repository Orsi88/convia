import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from convia.prepare import latest, volumes


class RawIntegrityTest(unittest.TestCase):
    def test_modified_input_is_rejected(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            collected = root / "prf" / "collection"
            collected.mkdir(parents=True)
            path = collected / "data.zip"
            path.write_bytes(b"original")
            (collected / "manifest.json").write_text(json.dumps({
                "filename": "data.zip",
                "collected_at": "2026-11-25T00:00:00Z",
                "sha256": hashlib.sha256(b"original").hexdigest(),
            }))
            self.assertEqual(latest(root, "prf", "data.zip")[0], path)
            path.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Arquivo bruto alterado"):
                latest(root, "prf", "data.zip")


class VolumesTest(unittest.TestCase):
    def test_commercial_volume_is_weighted_by_length(self):
        def segment(length, a, i, br="158"):
            row = {f"{c}_{d}": 0 for c in "ABCDEFGHIJ" for d in "CD"}
            row.update({"sg_uf": "MS", "vl_br": br, "vl_extensa": length, "VMDa_C": 1, "A_C": a, "F_D": a, "I_C": i})
            return row
        [item] = volumes([segment(10, 100, 999), segment(30, 300, 5)])
        self.assertEqual((item["uf"], item["br"], item["km"]), ("MS", "158", 40))
        self.assertEqual(item["commercial"], 500)  # (200·10 + 600·30) / 40, sem passeio (I)
        self.assertEqual(item["heavy"], 250)  # só a classe F conta como pesado


if __name__ == "__main__":
    unittest.main()
