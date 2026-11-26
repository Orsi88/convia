import unittest

from convia.corridor import corridor

PLACES = {
    "5218805": [-50.9281, -17.7923],  # Rio Verde (terminal)
    "5211909": [-51.7191, -17.8784],  # Jataí, ~85 km de Rio Verde
    "5201108": [-48.9530, -16.3281],  # Anápolis (terminal)
    "5220405": [-50.5465, -19.0185],  # São Simão (terminal)
    "3548500": [-46.3336, -23.9535],  # Santos
    "3515202": [-50.4049, -20.2875],  # Estrela d'Oeste
    "1718204": [-48.4174, -10.7027],  # Porto Nacional
    "2111300": [-44.3028, -2.5307],   # São Luís
    "3106200": [-43.9378, -19.9208],  # Belo Horizonte, fora do corredor
}


class CorridorTest(unittest.TestCase):
    def test_pairs_and_exports_are_grouped_by_terminal_and_arrival(self):
        domestic = [
            {"origin": "5211909", "destination": "3548500", "tonnes": 100.0, "product": "Milho"},
            {"origin": "5211909", "destination": "3106200", "tonnes": 50.0, "product": "Milho"},  # chegada fora
            {"origin": "5211909", "destination": "5201108", "tonnes": 70.0, "product": "Soja"},  # dentro da captação
        ]
        exports = [{"origin": "5211909", "product": "Soja", "tonnes": 1000.0}]
        result = corridor(domestic, exports, PLACES, {("Soja", "3548500"): 0.6, ("Soja", "2111300"): 0.1})
        groups = {(g["terminal"], g["node"], g["kind"]): g["tonnes"] for g in result["groups"]}
        self.assertEqual(groups, {
            ("Rio Verde", "Santos (SP)", "interno"): 100.0,
            ("Rio Verde", "Santos (SP)", "exportação"): 600.0,
            ("Rio Verde", "São Luís (MA)", "exportação"): 100.0,
        })
        self.assertEqual(result["exports_other_ports"], {"Rio Verde": 300.0})

    def test_without_port_shares_exports_stay_out(self):
        result = corridor([], [{"origin": "5211909", "product": "Soja", "tonnes": 1000.0}], PLACES, None)
        self.assertEqual(result["groups"], [])
        self.assertEqual(result["exports_other_ports"], {"Rio Verde": 1000.0})


if __name__ == "__main__":
    unittest.main()
