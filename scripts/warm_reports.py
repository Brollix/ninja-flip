"""Job programado: precalienta el cache de reportes (user_reports) para los
usuarios que ya conectaron AlecaFrame y cuyo cache está por vencer — así
nunca encuentran un cache frío al entrar, sin recalcular a TODO el mundo en
cada corrida (eso no escala: con 1000 usuarios, la mayoría ya está fresca
en cualquier corrida dada, reprocesarlos a todos igual sería tiempo tirado).

Corre como el Cloud Run Job "report-warmer" (ver infra/), cada 10 min,
reusando la MISMA imagen que el servicio "report" (scripts/Dockerfile.report)
con un command distinto — no hace falta un Dockerfile aparte.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed

from db import get_conn
from report_server import REPORT_TTL_SECONDS, generate_and_save_report

# Cada cuánto dispara Cloud Scheduler este Job (ver infra/scheduler.tf) — el
# umbral de "necesita refresco" se calcula contra esto, no contra el TTL
# entero, para garantizar al menos un ciclo de margen antes de que
# report_server.py encuentre el cache vencido on-demand.
JOB_INTERVAL_SECONDS = 10 * 60
SAFETY_MARGIN_SECONDS = 2 * 60  # una corrida lenta no debe dejar pasar el TTL

# AlecaFrame no documenta rate limit en ningún lado del repo (ni aleca.py ni
# relic_analysis.py tienen sleep/manejo de 429 para sus llamadas) — sin ese
# dato, mejor quedarse corto que tirarla abajo con muchos requests en paralelo.
MAX_WORKERS = 5

# Arbitrario pero fijo — no reusar para otro lock. Evita que dos ejecuciones
# de este Job se pisen si una corrida tarda más que el intervalo de 10 min.
REPORT_WARMER_LOCK_KEY = 727270001


def get_stale_users(conn) -> list:
    """Solo usuarios sin reporte cacheado o cuyo reporte se vencería antes de
    la PRÓXIMA ejecución programada — así siempre se refresca con margen,
    en vez de reprocesar a todo el mundo en cada corrida sin necesidad."""
    threshold = REPORT_TTL_SECONDS - JOB_INTERVAL_SECONDS - SAFETY_MARGIN_SECONDS
    with conn.cursor() as cur:
        cur.execute("""
            SELECT t.wfm_user_id, t.aleca_public_token
            FROM user_aleca_tokens t
            LEFT JOIN user_reports r ON r.wfm_user_id = t.wfm_user_id
            WHERE r.wfm_user_id IS NULL
               OR r.generated_at < now() - (%s || ' seconds')::interval
        """, (threshold,))
        return cur.fetchall()


def process_user(wfm_user_id: str, token: str):
    try:
        generate_and_save_report(wfm_user_id, token)
        return wfm_user_id, None
    except Exception as e:
        return wfm_user_id, e


def main():
    # DATABASE_URL apunta al connection pooler de Neon (PgBouncer en modo
    # transacción) — un lock de SESIÓN (pg_try_advisory_lock) no es confiable
    # ahí porque una "sesión" de psycopg no se mapea a una conexión física
    # estable entre statements. pg_try_advisory_xact_lock (de TRANSACCIÓN) sí
    # funciona bien con ese modo de pooling, siempre que se sostenga dentro de
    # una única transacción explícita que dure todo el trabajo del job — por
    # eso el "with lock_conn.transaction()" envuelve todo, no solo el chequeo.
    lock_conn = get_conn()
    with lock_conn.transaction():
        with lock_conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_xact_lock(%s)", (REPORT_WARMER_LOCK_KEY,))
            acquired = cur.fetchone()[0]
        if not acquired:
            # Otra ejecución de report-warmer todavía está corriendo (el
            # scheduler disparó de nuevo antes de que la anterior terminara)
            # — salir limpio, no es un error: get_stale_users() ya filtra
            # solo lo que falte la próxima vez.
            print("report-warmer ya está corriendo (lock ocupado), salgo.", flush=True)
            return

        with get_conn() as conn:
            users = get_stale_users(conn)

        print(f"Precalentando reporte de {len(users)} usuario(s) con cache "
              f"vencido o por vencer...", flush=True)
        ok, failed = 0, 0
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(process_user, uid, tok): uid for uid, tok in users}
            for future in as_completed(futures):
                uid, err = future.result()
                if err is None:
                    ok += 1
                    print(f"  OK: {uid}", flush=True)
                else:
                    failed += 1
                    print(f"  FALLÓ {uid}: {err}", flush=True)

        print(f"Listo: {ok} ok, {failed} fallidos", flush=True)
    lock_conn.close()  # cierra la transacción (commit) -> libera el xact lock


if __name__ == "__main__":
    main()
