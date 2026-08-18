"""Gera a base compacta consumida pelo painel de TV."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCE_CANDIDATES = (
    ROOT / "data" / "dashboard-data.js",
    ROOT / "painel_testev1_repo" / "data" / "dashboard-data.js",
)
SOURCE = next((path for path in SOURCE_CANDIDATES if path.exists()), SOURCE_CANDIDATES[0])
OUTPUT = Path(__file__).resolve().parent / "base-resumo.js"


def read_window_object(source: str, name: str) -> dict:
    match = re.search(rf"window\.{re.escape(name)}\s*=\s*", source)
    if not match:
        raise RuntimeError(f"Objeto {name} não encontrado em {SOURCE}")
    value, _ = json.JSONDecoder().raw_decode(source, match.end())
    return value


def select(rows: list[dict], fields: tuple[str, ...]) -> list[dict]:
    return [{field: row.get(field) for field in fields} for row in rows]


def main() -> None:
    source = SOURCE.read_text(encoding="utf-8-sig")
    dashboard = read_window_object(source, "DASHBOARD_DATA")
    crime = read_window_object(source, "CRIME_DATA")
    movement_counts = {}
    for row in dashboard.get("movimentacoesEstudo", {}).get("records", []):
        if row.get("sourceSheet") != "Planilha1":
            continue
        label = row.get("grupo") or row.get("tipo") or "OUTRAS"
        movement_counts[label] = movement_counts.get(label, 0) + (row.get("total") or 1)
    # Extrai dados de exoneração e demissão
    dashboard_summary = dashboard.get("summary", {})
    movement_summary = dashboard.get("movimentacoesEstudo", {}).get("summary", {})
    movement_summary.update({
        "exoneracoes": dashboard_summary.get("exoneracoes", 0),
        "demissoes": dashboard_summary.get("demissoes", 0),
        "desligamentos": dashboard_summary.get("exon_dem", 0),
    })
    
    compact = {
        "generatedAt": dashboard.get("generatedAt"),
        "summary": dashboard.get("summary", {}),
        "movementSummary": movement_summary,
        "movementModalities": [
            {"modalidade": label, "total": total}
            for label, total in sorted(movement_counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "municipalityGeo": dashboard.get("municipalityGeo", []),
        "effectiveByMunicipio": select(dashboard.get("byMunicipio", []), ("municipio", "total", "disponivel")),
        "vehiclesByMunicipio": select(dashboard.get("byVehicleMunicipio", []), ("municipio", "total", "operando")),
        "vehicleSituations": select(dashboard.get("byVehicleSituation", []), ("situacao_viatura", "total")),
        "vehicleTypes": select(dashboard.get("byVehicleType", []), ("tipo_veiculo", "total", "operando")),
        "regionTotals": dashboard.get("territorialTotalsValidation", {}).get("byMacroregion", []),
        "validation": {
            "territorialChecks": dashboard.get("territorialTotalsValidation", {}).get("checks", {}),
            "macroregions": dashboard.get("macroregionValidation", {}),
        },
        "sources": {
            "effective": dashboard.get("sourceValidation", {}).get("fonteEfetivo"),
            "territorialDistribution": dashboard.get("sourceValidation", {}).get("fonteDistribuicaoTerritorial"),
            "vehicles": dashboard.get("sourceValidation", {}).get("fonteVeiculos"),
            "vehiclesUpdatedAt": dashboard.get("sourceValidation", {}).get("veiculosAtualizados", {}).get("dataAtualizacao"),
            "movements": dashboard.get("movimentacoesEstudo", {}).get("sourceFile"),
            "crimes": crime.get("sourceFile"),
            "macroregions": dashboard.get("macroregionValidation", {}).get("fonteReferencia"),
        },
        "crime": {
            "periodo": crime.get("periodo"),
            "summary": crime.get("summary", {}),
            "byMonth": select(crime.get("byMonth", []), ("periodo", "mesLabel", "total")),
            "byMunicipio": select(crime.get("byMunicipio", []), ("municipio", "total", "macrorregiao", "principalCrime")),
        },
    }
    payload = json.dumps(compact, ensure_ascii=False, separators=(",", ":"))
    OUTPUT.write_text(f"window.TV_BASE_DATA = {payload};\n", encoding="utf-8")
    print(f"Base gerada: {OUTPUT.name} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
