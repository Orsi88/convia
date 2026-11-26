import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from convia import api


class WorldRailwaysTest(unittest.TestCase):
    def test_every_cited_source_exists(self):
        data = api.world_railways()
        cited = {item["fonte"] for railway in data["ferrovias"] for item in railway["numeros"]}
        for railway in data["ferrovias"]:
            for effects in railway["efeitos"].values():
                for effect in effects:
                    cited.update(effect["fontes"])
        for lesson in data["licoes"]:
            cited.update(lesson["fontes"])
        self.assertEqual(cited - data["fontes"].keys(), set())
        self.assertTrue(all(source["url"].startswith("https://") for source in data["fontes"].values()))


class NewsTest(unittest.TestCase):
    def test_rejects_quotes_and_uses_cache_without_network(self):
        with self.assertRaises(HTTPException):
            api.news('BR-158" OR x')
        with TemporaryDirectory() as folder, patch.dict(os.environ, {"CONVIA_DATA_DIR": folder}):
            with patch.object(api, "urlopen", side_effect=OSError("429")):
                self.assertTrue(api.news("BR-158", "seguranca")["unavailable"])
            with patch.object(api, "urlopen", return_value=FakeResponse({"articles": [{"title": "t", "url": "https://a"}]})):
                self.assertEqual(api.news("BR-158", "seguranca")["items"][0]["url"], "https://a")
            with patch.object(api, "urlopen", side_effect=AssertionError("não deveria consultar")):
                self.assertEqual(api.news("BR-158", "seguranca")["items"][0]["title"], "t")


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


if __name__ == "__main__":
    unittest.main()
