"""Biometrics helpers shared by the recognition API, settings, tasks and tests.

Match rule (ONE definition, shared with the POS — ``frontend/src/recognition/math.ts``)
-------------------------------------------------------------------------------------
face-api ``faceRecognitionNet`` descriptors are **not** unit vectors (‖d‖ ≈ 1.4–1.6), so cosine
similarity is compressed towards 1 and different people score 0.85–0.90. The published
operating point of that model is the **euclidean distance between the RAW descriptors**:
``distance < 0.6`` ⇒ same person. That is the rule used on both sides:

* templates are stored and returned **raw** (never unit-normalised);
* ``AWANZ POS Settings.match_threshold`` is the **maximum distance** (default ``0.6``);
  a device may only *tighten* it (lower distance);
* the API returns ``distance`` per candidate plus a display-only
  ``score = clamp(1 − distance / 1.2, 0, 1)`` and ``threshold_distance``.

Numpy is optional (it is not installed in the reference bench); pure-python math handles
128/512-d vectors across a few thousand templates in well under 100 ms.
"""

from __future__ import annotations

import json
import math
from typing import Any, Iterable, Sequence

try:  # pragma: no cover - optional accelerator
	import numpy as _np
except Exception:  # noqa: BLE001
	_np = None

DEFAULT_MODEL = "face-api/faceRecognitionNet@1"
DEFAULT_DISTANCE_THRESHOLD = 0.6
SCORE_SPAN = 1.2  # score = 1 - distance / SCORE_SPAN
MAX_DISTANCE_THRESHOLD = 1.5
DEFAULT_RETENTION_MONTHS = 36
CONSENT_TEXT_VERSION = "2026-08-1"
ALLOWED_DIMS = (128, 256, 512)
MAX_TEMPLATES_PER_CUSTOMER = 10
CONSENT_METHODS = ("Hold-to-agree", "Signature")

DEFAULT_CONSENT_TEXT_EN = (
	"I agree that AWANZ may create and store a mathematical template of my facial features "
	"(a \"face template\") so that this boutique can recognise me and offer personalised service "
	"when I visit. No photograph or video of my face is kept; only the template. AWANZ will not "
	"sell, lease or trade my face template, will not use it for any purpose other than identifying "
	"me as a client, and will permanently destroy it when I withdraw my consent, when I have not "
	"visited an AWANZ boutique for 36 months, or sooner if required by law — whichever comes first. "
	"I may withdraw this consent at any time by asking any boutique manager or by writing to "
	"privacy@maison.example. AWANZ's Biometric Data Retention and Destruction Policy is available "
	"at every boutique and on maison.example/privacy/biometrics."
)


def distance_to_score(distance: float) -> float:
	"""Display-only confidence for a euclidean distance: ``clamp(1 − d / 1.2, 0, 1)``."""
	distance = max(0.0, float(distance))
	return round(max(0.0, min(1.0, 1.0 - distance / SCORE_SPAN)), 6)


def score_to_distance(score: float) -> float:
	"""Inverse of :func:`distance_to_score` (for the 0–1 range)."""
	score = max(0.0, min(1.0, float(score)))
	return round((1.0 - score) * SCORE_SPAN, 6)


def parse_vector(value: Any) -> list[float]:
	"""Accept a JSON string or a list of numbers; return a list of floats. Raises ValueError."""
	if isinstance(value, str):
		value = json.loads(value)
	if not isinstance(value, (list, tuple)):
		raise ValueError("embedding must be a JSON list of numbers")
	out: list[float] = []
	for x in value:
		f = float(x)
		if math.isnan(f) or math.isinf(f):
			raise ValueError("embedding contains NaN/Inf")
		out.append(f)
	if not out:
		raise ValueError("embedding is empty")
	return out


def normalize(vec: Sequence[float]) -> list[float]:
	"""L2-normalise (diagnostics only — stored/matched vectors are raw). Zero vector unchanged."""
	norm = math.sqrt(sum(x * x for x in vec))
	if norm == 0.0:
		return [float(x) for x in vec]
	return [float(x) / norm for x in vec]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
	"""Cosine similarity of two raw vectors (diagnostics; dimension mismatch → 0)."""
	if len(a) != len(b) or not a:
		return 0.0
	dot = na = nb = 0.0
	for x, y in zip(a, b):
		dot += x * y
		na += x * x
		nb += y * y
	if na == 0.0 or nb == 0.0:
		return 0.0
	return dot / math.sqrt(na * nb)


def euclidean(a: Sequence[float], b: Sequence[float]) -> float:
	"""Euclidean distance between two RAW vectors; ``inf`` on dimension mismatch / empty."""
	if len(a) != len(b) or not a:
		return math.inf
	if _np is not None:  # pragma: no cover
		return float(_np.linalg.norm(_np.asarray(a, dtype=float) - _np.asarray(b, dtype=float)))
	acc = 0.0
	for x, y in zip(a, b):
		d = x - y
		acc += d * d
	return math.sqrt(acc)


def score(a: Sequence[float], b: Sequence[float]) -> float:
	"""Display score for the distance between two raw vectors."""
	return distance_to_score(euclidean(a, b))


def is_match(distance: float, threshold: float = DEFAULT_DISTANCE_THRESHOLD) -> bool:
	"""The rule: ``distance < threshold`` (face-api: 0.6)."""
	return math.isfinite(distance) and distance < float(threshold)


def best_distances(query: Sequence[float], rows: Iterable[dict[str, Any]]) -> dict[str, float]:
	"""Min distance per customer across cached rows ``{customer, vec: [..]}`` (all raw)."""
	best: dict[str, float] = {}
	for row in rows:
		d = euclidean(query, row["vec"])
		if d < best.get(row["customer"], math.inf):
			best[row["customer"]] = d
	return {k: round(v, 6) for k, v in best.items()}
