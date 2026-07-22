"""Point d'entrée de la fonction serverless Vercel.

Le runtime Python de Vercel monte l'objet ASGI nommé `app`. On se contente
d'exposer l'application FastAPI existante : `backend/` est embarqué dans le
bundle via `includeFiles` (cf. vercel.json), on l'ajoute donc au sys.path.
"""
from __future__ import annotations

import os
import sys

_BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from app.main import app  # noqa: E402

__all__ = ["app"]
