"""Cloud Run service "report": relic_analysis.py por HTTP, por usuario.

No hace su propia verificación de identidad — solo lo llama internamente
server/src/routes/report.ts (Node), que ya resolvió el wfm_user_id contra
el JWT de warframe.market. Este servicio confía en lo que le manda ese
llamado interno (nunca queda expuesto directo a internet en el deploy real,
ver infra/cloud_run_report.tf: solo invocable por la cuenta de servicio del
service "web").

POST /report  {"wfm_user_id": "...", "aleca_token": "...", "refresh": bool}
  -> el report.json de siempre (Report, ver app/src/types.ts), cacheado por
     usuario en Postgres (user_reports) con TTL — no le pega a AlecaFrame en
     cada visita.
"""

import json
import os
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request

from db import get_conn
from relic_analysis import build_report

app = Flask(__name__)

# 50 min, no 25 — el warmer (scripts/warm_reports.py) ahora corre cada 20 min
# (antes 10), así que este TTL necesita margen de sobra por encima de ese
# intervalo para que get_stale_users() siga distinguiendo "recién
# refrescado" de "por vencer" en vez de creer que todos están por vencer en
# cada corrida (ver el comentario de JOB_INTERVAL_SECONDS ahí).
REPORT_TTL_SECONDS = int(os.environ.get("REPORT_TTL_SECONDS", 50 * 60))


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


def generate_and_save_report(wfm_user_id: str, aleca_token: str) -> dict:
    """Recalcula el reporte de un usuario y lo persiste (user_reports +
    user_detected_flips). Compartido por el endpoint HTTP (pedido on-demand
    de un usuario) y por warm_reports.py (precalentado proactivo por el
    Job programado) — misma lógica, dos disparadores distintos."""
    data = build_report(aleca_token, refresh=False)

    # separado del ledger de flips manuales (user_ledger_flips) — estos
    # salen del historial de trades de AlecaFrame, no de que confirmes
    # "🛒 bought" / "💰 sold" en la app.
    detected_flips = data.pop("_detected_flips", [])

    def to_epoch_ms(iso_ts):
        # AlecaFrame manda ISO ("2026-07-22T10:00:00Z") — el ledger usa
        # epoch ms (BIGINT), mismo formato que Date.now() del frontend
        dt = datetime.fromisoformat(str(iso_ts).replace("Z", "+00:00"))
        return int(dt.astimezone(timezone.utc).timestamp() * 1000)

    flip_rows = []
    for f in detected_flips:
        try:
            flip_rows.append((wfm_user_id, f["item"], f["buy"], f["sell"], to_epoch_ms(f["ts"]), f.get("market_now")))
        except (ValueError, TypeError, KeyError):
            # ts rara/ausente O falta item/buy/sell (drift de schema): no vale
            # la pena tirar TODO el reporte (incluido report_json, que recién
            # se guarda más abajo) por una sola fila de detected_flips mal
            # formada — antes un KeyError acá no lo atrapaba nada y abortaba
            # generate_and_save_report entero.
            continue

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO user_reports (wfm_user_id, report_json, generated_at)
            VALUES (%s, %s, now())
            ON CONFLICT (wfm_user_id) DO UPDATE SET
              report_json = EXCLUDED.report_json, generated_at = now()
        """, (wfm_user_id, json.dumps(data)))
        if flip_rows:
            # DO UPDATE (no DO NOTHING) en market_now a propósito: filas viejas
            # de antes de que existiera esta columna se van completando solas
            # en el próximo refresh, sin necesitar un backfill aparte.
            cur.executemany("""
                INSERT INTO user_detected_flips (wfm_user_id, item, buy, sell, ts, market_now)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (wfm_user_id, item, ts) DO UPDATE SET
                  market_now = EXCLUDED.market_now
            """, flip_rows)

    return data


@app.post("/report")
def report():
    body = request.get_json(force=True, silent=True) or {}
    wfm_user_id = body.get("wfm_user_id")
    aleca_token = body.get("aleca_token")
    refresh = bool(body.get("refresh"))
    if not wfm_user_id or not aleca_token:
        return jsonify({"error": "missing wfm_user_id/aleca_token"}), 400

    if not refresh:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT report_json FROM user_reports
                WHERE wfm_user_id = %s
                  AND generated_at > now() - (%s || ' seconds')::interval
            """, (wfm_user_id, REPORT_TTL_SECONDS))
            row = cur.fetchone()
            if row:
                return jsonify(row[0])

    try:
        data = generate_and_save_report(wfm_user_id, aleca_token)
    except Exception as e:
        # str(e) tal cual podía filtrar detalles internos al cliente (antes:
        # el token de AlecaFrame, si venía embebido en la URL de un error de
        # requests — ver relic_analysis.py). El detalle real queda en los
        # logs de Cloud Run, no en la respuesta.
        print(f"generate_and_save_report failed for wfm_user_id={wfm_user_id}: {e}", flush=True)
        return jsonify({"error": "report generation failed"}), 502

    return jsonify(data)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8081)))
