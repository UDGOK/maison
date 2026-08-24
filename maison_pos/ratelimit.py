"""v0.7 S4 — a real rate limiter for the public (``allow_guest``) surface.

Two problems with what was there before:

* ``rewards.signup`` set ``frappe.rate_limit = None``. That attribute does not exist on the
  ``frappe`` module and nothing reads it, so the "limit" was a no-op: the QA audit rang up 12
  anonymous sign-ups in a row, all ``200``.
* the Salon endpoints keyed their counter on ``frappe.local.request_ip``, which the framework
  fills from the **first hop** of ``X-Forwarded-For``. Behind a reverse proxy that header is
  whatever the client sent plus what the proxy appended, so a client that sends its own
  ``X-Forwarded-For: <random>`` gets a fresh bucket on every request (16 ``salon.pair`` calls
  against a limit of 12 → 0 blocked), while an honest tenant behind a corporate NAT shares one.

This module fixes both:

* :func:`client_ip` walks ``X-Forwarded-For`` from the **right** (the hop nearest us, which the
  edge proxy appended and a client cannot forge), skipping the private/loopback addresses of our
  own infrastructure, and validates every candidate with :mod:`ipaddress`. IPv6 collapses to its
  ``/64`` so one allocation cannot cycle addresses.
* :func:`guard` keeps an atomic redis counter per (endpoint, identity) **and** a second one per
  endpoint with no identity at all — the *global ceiling*. A distributed flood that defeats the
  per-IP bucket still hits the ceiling, which is what protects the database.

Both raise ``frappe.RateLimitExceededError`` → HTTP **429** with a human message.

Off switch for load tests / e2e: ``bench set-config -g awanz_rate_limits 0``.
"""

from __future__ import annotations

import ipaddress
from typing import Optional

import frappe
from frappe import _
from frappe.utils import cint

#: how many ``X-Forwarded-For`` hops we are willing to look at (a client can prepend any number)
MAX_FORWARDED_HOPS = 12
#: bucket used when no usable client address can be determined (shared, deliberately)
UNKNOWN_IP = "unknown"


def _is_public(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
	"""True when *addr* is a routable client address rather than one of our own hops."""
	return not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_unspecified)


def _parse(value: Optional[str]) -> Optional[ipaddress.IPv4Address | ipaddress.IPv6Address]:
	"""Parse one hop, tolerating the ``1.2.3.4:443`` / ``[2001:db8::1]:443`` forms."""
	value = (value or "").strip()
	if not value:
		return None
	if value.startswith("["):
		value = value[1 : value.find("]")] if "]" in value else value[1:]
	elif value.count(":") == 1:
		value = value.split(":", 1)[0]
	try:
		return ipaddress.ip_address(value)
	except ValueError:
		return None


def _bucket(addr: Optional[ipaddress.IPv4Address | ipaddress.IPv6Address]) -> Optional[str]:
	"""Canonical bucket key for *addr*; an IPv6 client is bucketed by its whole ``/64``."""
	if addr is None:
		return None
	if isinstance(addr, ipaddress.IPv6Address):
		return str(ipaddress.ip_network(f"{addr}/64", strict=False).network_address) + "/64"
	return str(addr)


def _header(name: str) -> Optional[str]:
	if not getattr(frappe.local, "request", None):
		return None
	return frappe.get_request_header(name)


def client_ip() -> str:
	"""The best guess at the address the request really came from.

	``X-Forwarded-For`` reads ``client, proxy1, proxy2``: every proxy *appends* the peer it heard
	from, so the entries on the **left** are whatever the client chose to send and only the
	right-hand end was written by our own infrastructure. Trusting the first hop — which is what
	the framework's ``frappe.local.request_ip`` does — hands the attacker a fresh bucket per
	request; trusting the last hop lumps every customer behind the edge proxy together.

	Resolution order (all validated, all configurable per site):

	1. ``maison_client_ip_header`` — when the edge writes a single-value header it controls
	   (``CF-Connecting-IP``, ``X-Real-IP``, …) that header wins outright;
	2. ``maison_trusted_proxy_hops`` — *N* proxies append to ``X-Forwarded-For``, so the client
	   is the *N*-th entry from the right;
	3. otherwise the right-most **public** hop (our own load balancers are private), falling back
	   to the right-most parseable hop for single-host / docker deployments;
	4. finally the framework's own resolution, and a shared bucket when even that is missing.
	"""
	configured = frappe.conf.get("maison_client_ip_header")
	if configured:
		bucket = _bucket(_parse(_header(configured)))
		if bucket:
			return bucket

	header = _header("X-Forwarded-For")
	if header:
		hops = header.split(",")[-MAX_FORWARDED_HOPS:]
		trusted = cint(frappe.conf.get("maison_trusted_proxy_hops"))
		if trusted >= 1 and len(hops) >= trusted:
			bucket = _bucket(_parse(hops[-trusted]))
			if bucket:
				return bucket
		last_valid = None
		for hop in reversed(hops):
			addr = _parse(hop)
			if addr is None:
				continue
			last_valid = last_valid or addr
			if _is_public(addr):
				return _bucket(addr)
		if last_valid is not None:
			return _bucket(last_valid)

	for name in ("X-Real-IP", "CF-Connecting-IP", "True-Client-IP"):
		bucket = _bucket(_parse(_header(name)))
		if bucket:
			return bucket

	for candidate in (getattr(frappe.local, "request_ip", None), getattr(getattr(frappe.local, "request", None), "remote_addr", None)):
		bucket = _bucket(_parse(candidate))
		if bucket:
			return bucket
	return UNKNOWN_IP


def enabled() -> bool:
	"""Limits apply to real HTTP requests only (in-process unit tests are not throttled)."""
	if not getattr(frappe.local, "request", None):
		return False
	return cint(frappe.conf.get("awanz_rate_limits", 1)) != 0


def _hit(key: str, limit: int, seconds: int) -> bool:
	"""Atomically count one request; True when *limit* is already exhausted."""
	cache = frappe.cache()
	cache_key = cache.make_key(key)
	try:
		count = cint(cache.incrby(cache_key, 1))
		if count == 1:
			cache.expire(cache_key, seconds)
	except Exception:  # pragma: no cover — a broken cache must not take the endpoint down
		frappe.log_error(frappe.get_traceback(), "awanz rate limit")
		return False
	return count > limit


def _reject(seconds: int) -> None:
	frappe.local.response["http_status_code"] = 429
	# a public 429 carries a human sentence, not our source tree (the audit found tracebacks in
	# `exc` on other refusals; there is nothing to debug in "you went too fast")
	frappe.flags.disable_traceback = True
	frappe.throw(
		_("Too many requests from this connection. Please wait about {0} and try again.").format(
			_("a minute") if seconds <= 90 else _("{0} minutes").format(max(1, seconds // 60))
		),
		frappe.RateLimitExceededError,
	)


def guard(
	endpoint: str,
	limit: int,
	seconds: int = 60,
	*,
	global_limit: Optional[int] = None,
	global_seconds: Optional[int] = None,
	identity: Optional[str] = None,
) -> None:
	"""Throttle *endpoint*: ``limit`` requests per client per *seconds*, plus a global ceiling.

	*identity* narrows the bucket further (e.g. the salon session token), so one shared NAT
	cannot lock out the whole store while a single device is still limited on its own.
	"""
	if not enabled():
		return
	who = client_ip()
	if identity:
		who = f"{who}|{identity}"
	if _hit(f"awanz_rl:{endpoint}:{who}", limit, seconds):
		_reject(seconds)
	ceiling = global_limit if global_limit is not None else limit * 20
	window = global_seconds or seconds
	if _hit(f"awanz_rl_all:{endpoint}", ceiling, window):
		# the endpoint as a whole is over its ceiling — shed load rather than fall over
		_reject(window)


def clear(endpoint: Optional[str] = None) -> int:
	"""Drop the counters for *endpoint* (or every endpoint). **Tests only.**

	The limiter buckets by client address, and every test in a suite comes from 127.0.0.1 — so the
	sixth guest sign-up in a ten-minute run is throttled by design, and a test that reads the body
	of that 429 sees ``None``. That is the limiter working, not a hole, but it made
	``test_v0_7_security`` non-deterministic depending on how many sign-ups ran before it. Reset in
	``setUp`` rather than weakening the limit.
	"""
	cache = frappe.cache()
	patterns = [f"awanz_rl:{endpoint}:*", f"awanz_rl_all:{endpoint}"] if endpoint else ["awanz_rl:*", "awanz_rl_all:*"]
	dropped = 0
	for pattern in patterns:
		try:
			keys = cache.get_keys(pattern)
		except Exception:  # pragma: no cover — cache backends differ
			continue
		for key in keys or []:
			name = key.decode() if isinstance(key, bytes) else str(key)
			# `get_keys` returns fully-qualified keys; `delete_value` re-qualifies, so strip first
			prefix = cache.make_key("").decode() if isinstance(cache.make_key(""), bytes) else cache.make_key("")
			cache.delete_value(name[len(prefix):] if prefix and name.startswith(prefix) else name)
			dropped += 1
	return dropped


def rate_limited(endpoint: str, limit: int, seconds: int = 60, *, global_limit: Optional[int] = None, global_seconds: Optional[int] = None):
	"""Decorator form of :func:`guard` for whitelisted endpoints."""

	def decorator(fn):
		import functools

		@functools.wraps(fn)
		def wrapper(*args, **kwargs):
			guard(endpoint, limit, seconds, global_limit=global_limit, global_seconds=global_seconds)
			return fn(*args, **kwargs)

		return wrapper

	return decorator
