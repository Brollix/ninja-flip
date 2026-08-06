"""Conexión Postgres compartida (Neon) para los scripts server-side.

Reemplaza los caches locales en cache/*.json — ahora todo lo que antes vivía
en un archivo JSON de un solo usuario vive acá, compartido entre el Cloud Run
Job (flips.py) y el Cloud Run service de reportes (report_server.py).
"""

import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def get_conn() -> psycopg.Connection:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("Falta DATABASE_URL (.env local o Secret Manager en prod)")
    return psycopg.connect(url, autocommit=True)
