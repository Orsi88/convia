import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from convia.api import cargo_flow, filters
from convia.results import TABLES, snapshot


class SnapshotTest(unittest.TestCase):
    def test_incomplete_publication_preserves_previous_snapshot(self):
        with TemporaryDirectory() as folder, patch.dict(os.environ, {"CONVIA_DATA_DIR": folder}):
            root = Path(folder) / "processed"
            valid = root / "goias-20260101"
            valid.mkdir(parents=True)
            (valid / "manifest.json").write_text(json.dumps({"region": "GO"}))
            for table in TABLES:
                (valid / f"{table}.parquet").touch()
            incomplete = root / "goias-20260102"
            incomplete.mkdir()
            (incomplete / "manifest.json").write_text(json.dumps({"region": "GO"}))
            self.assertEqual(snapshot()[0], valid)

    def test_absent_publication_returns_unavailable(self):
        with TemporaryDirectory() as folder, patch.dict(os.environ, {"CONVIA_DATA_DIR": folder}):
            with self.assertRaises(HTTPException) as raised:
                snapshot()
            self.assertEqual(raised.exception.status_code, 503)


class CargoFlowTest(unittest.TestCase):
    def test_distinguishes_directions_zero_and_missing_data(self):
        with TemporaryDirectory() as folder, patch.dict(os.environ, {"CONVIA_DATA_DIR": folder}):
            self.assertEqual(cargo_flow("5208707", "5201108")["coverage"], "unavailable")
            processed = Path(folder) / "processed"
            processed.mkdir()
            (processed / "pnl-go-2023.csv").write_text(
                "origin,destination,tonnes,product\n"
                "5208707,5201108,10.5,Soja\n5201108,5208707,0,Soja\n", encoding="utf-8",
            )
            self.assertEqual(cargo_flow("5208707", "5201108")["tonnes"], 10.5)
            reverse = cargo_flow("5201108", "5208707")
            self.assertEqual((reverse["coverage"], reverse["tonnes"], reverse["product"]), ("present", 0, None))
            self.assertEqual(cargo_flow("5201108", "5218003")["coverage"], "absent")
            (processed / "pnl-go-2023.csv").write_text(
                "origin,destination,tonnes,product\n5211909,3537107,739238,Milho\n", encoding="utf-8")
            self.assertEqual(cargo_flow("5211909", "3537107")["tonnes"], 739238)


class FiltersTest(unittest.TestCase):
    def test_bbox_orders_bounds_for_the_query(self):
        where, values = filters(uf="GO", bbox="-51.5,-18.2,-48.1,-16.0")
        self.assertEqual(where, "WHERE uf = ? AND longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?")
        self.assertEqual(values, ["GO", -51.5, -48.1, -18.2, -16.0])


if __name__ == "__main__":
    unittest.main()
