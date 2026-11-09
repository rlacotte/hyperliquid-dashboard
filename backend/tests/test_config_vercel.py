"""Sur Vercel, la configuration ne vient que des variables du projet.

Incident : backend/.env (développement local, RUN_POLLER=1) partait avec le
déploiement et lançait une boucle de collecte dans chaque instance, en plus
du cron : deux cycles par minute et des notifications Telegram en double.
"""
from __future__ import annotations

import os
import subprocess
import sys

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _config_in_subprocess(env: dict, cwd: str) -> str:
    # load_dotenv remplacé par un compteur : le test ne dépend pas de la
    # présence d'un backend/.env sur la machine (absent en CI).
    code = (
        "import dotenv; calls = []; dotenv.load_dotenv = lambda *a, **k: calls.append(1); "
        "from app import config; print(config.RUN_POLLER, config.ON_VERCEL, len(calls))"
    )
    full_env = {k: v for k, v in os.environ.items() if k not in ("RUN_POLLER", "VERCEL")}
    full_env.update(env)
    full_env["PYTHONPATH"] = BACKEND
    return subprocess.run([sys.executable, "-c", code], cwd=cwd, env=full_env, capture_output=True, text=True, check=True).stdout.strip()


def test_sur_vercel_aucun_fichier_env_n_est_lu(tmp_path):
    assert _config_in_subprocess({"VERCEL": "1"}, str(tmp_path)) == "False True 0"


def test_sur_vercel_meme_une_variable_explicite_n_active_pas_le_poller(tmp_path):
    assert _config_in_subprocess({"VERCEL": "1", "RUN_POLLER": "1"}, str(tmp_path)) == "False True 0"


def test_en_local_le_env_et_le_poller_restent_disponibles(tmp_path):
    assert _config_in_subprocess({"RUN_POLLER": "1"}, str(tmp_path)) == "True False 1"


def test_le_env_local_n_est_jamais_deploye():
    root = os.path.dirname(BACKEND)
    ignored = open(os.path.join(root, ".vercelignore")).read().split()
    assert "**/.env" in ignored and ".env" in ignored
