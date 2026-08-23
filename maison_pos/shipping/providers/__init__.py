"""Rate-shopping providers: ``simulated`` (default), ``shippo`` (real), ``easypost`` (stub)."""

from .base import BaseProvider, Label, Rate, ShippingError, Tracking, pick_rate
from .easypost import EasyPostProvider
from .shippo import ShippoProvider
from .simulated import SimulatedProvider

PROVIDERS = {"simulated": SimulatedProvider, "shippo": ShippoProvider, "easypost": EasyPostProvider}

__all__ = ["BaseProvider", "Label", "Rate", "ShippingError", "Tracking", "pick_rate", "PROVIDERS", "SimulatedProvider", "ShippoProvider", "EasyPostProvider"]
