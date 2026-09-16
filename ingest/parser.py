"""Parse the FAA NAS Status XML feed into normalized records.

Source: https://nasstatus.faa.gov/api/airport-status-information
No API key required. Returns a *snapshot* of current conditions — there is
no historical endpoint, which is why this pipeline stores every observation.

Structural notes from the live feed (verified 2026-09-16):
  * The document contains multiple <Delay_type> blocks.
  * TWO separate blocks can both be named "Airport Closures", so blocks must
    be dispatched on their child list element, not on <Name>.
  * <Arrival_Departure> carries a Type attribute ("Arrival" / "Departure"),
    so a single airport may legitimately appear twice with different
    directions. That attribute is part of the natural key.
  * Durations are human strings: "15 minutes", "1 hour", "1 hour and 30
    minutes". They must be normalised to integer minutes.
"""
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

# "Wed Sep 16 01:57:58 2026 GMT"
_UPDATE_TIME_FORMAT = "%a %b %d %H:%M:%S %Y %Z"

_HOUR_RE = re.compile(r"(\d+)\s*hour", re.I)
_MIN_RE = re.compile(r"(\d+)\s*minute", re.I)


def parse_duration_minutes(text):
    """Normalise an FAA duration string to integer minutes.

    "15 minutes" -> 15 | "1 hour" -> 60 | "1 hour and 30 minutes" -> 90
    Returns None when the text carries no recognisable duration.
    """
    if not text:
        return None
    hours = _HOUR_RE.search(text)
    minutes = _MIN_RE.search(text)
    if not hours and not minutes:
        return None
    total = 0
    if hours:
        total += int(hours.group(1)) * 60
    if minutes:
        total += int(minutes.group(1))
    return total


def _parse_update_time(text):
    if not text:
        return None
    try:
        parsed = datetime.strptime(text.strip(), _UPDATE_TIME_FORMAT)
    except ValueError:
        # Fall back to stripping a trailing timezone token we don't know.
        try:
            parsed = datetime.strptime(
                " ".join(text.strip().split()[:-1]), "%a %b %d %H:%M:%S %Y"
            )
        except ValueError:
            return None
    # The feed publishes GMT; strptime's %Z does not attach a tzinfo.
    return parsed.replace(tzinfo=timezone.utc)


def _text(node, tag):
    value = node.findtext(tag)
    return value.strip() if value else None


def _raw(node):
    return ET.tostring(node, encoding="unicode").strip()


def _parse_delay(node):
    """<Delay> inside <Arrival_Departure_Delay_List>."""
    airport = _text(node, "ARPT")
    if not airport:
        return []

    reason = _text(node, "Reason")
    raw = _raw(node)
    out = []

    # One airport can carry both an Arrival and a Departure delay.
    for leg in node.findall("Arrival_Departure"):
        out.append({
            "airport": airport,
            "delay_type": "delay",
            "direction": leg.get("Type"),
            "reason": reason,
            "min_delay_minutes": parse_duration_minutes(_text(leg, "Min")),
            "max_delay_minutes": parse_duration_minutes(_text(leg, "Max")),
            "trend": _text(leg, "Trend"),
            "start_text": None,
            "reopen_text": None,
            "raw": raw,
        })

    if not out:  # delay entry with no leg detail — keep it rather than drop it
        out.append({
            "airport": airport,
            "delay_type": "delay",
            "direction": None,
            "reason": reason,
            "min_delay_minutes": None,
            "max_delay_minutes": None,
            "trend": None,
            "start_text": None,
            "reopen_text": None,
            "raw": raw,
        })
    return out


def _parse_closure(node):
    """<Airport> inside <Airport_Closure_List>."""
    airport = _text(node, "ARPT")
    if not airport:
        return []
    return [{
        "airport": airport,
        "delay_type": "closure",
        "direction": None,
        "reason": _text(node, "Reason"),
        "min_delay_minutes": None,
        "max_delay_minutes": None,
        "trend": None,
        "start_text": _text(node, "Start"),
        "reopen_text": _text(node, "Reopen"),
        "raw": _raw(node),
    }]


def _parse_ground_delay(node):
    """<Ground_Delay> inside <Ground_Delay_List>."""
    airport = _text(node, "ARPT")
    if not airport:
        return []
    return [{
        "airport": airport,
        "delay_type": "ground_delay",
        "direction": None,
        "reason": _text(node, "Reason"),
        "min_delay_minutes": parse_duration_minutes(_text(node, "Avg")),
        "max_delay_minutes": parse_duration_minutes(_text(node, "Max")),
        "trend": None,
        "start_text": None,
        "reopen_text": None,
        "raw": _raw(node),
    }]


def _parse_ground_stop(node):
    """<Program> inside <Ground_Stop_List>."""
    airport = _text(node, "ARPT")
    if not airport:
        return []
    return [{
        "airport": airport,
        "delay_type": "ground_stop",
        "direction": None,
        "reason": _text(node, "Reason"),
        "min_delay_minutes": None,
        "max_delay_minutes": None,
        "trend": None,
        "start_text": None,
        "reopen_text": _text(node, "End_Time"),
        "raw": _raw(node),
    }]


# Dispatch on the LIST element, not on <Name>: the feed legitimately repeats
# names (two distinct blocks are both called "Airport Closures").
_LIST_HANDLERS = {
    "Arrival_Departure_Delay_List": ("Delay", _parse_delay),
    "Airport_Closure_List": ("Airport", _parse_closure),
    "Ground_Delay_List": ("Ground_Delay", _parse_ground_delay),
    "Ground_Stop_List": ("Program", _parse_ground_stop),
}


def parse_nas_status(xml_text):
    """Parse the NAS status document.

    Returns {"update_time": datetime|None, "records": [record, ...]}.
    Unknown <Delay_type> blocks are ignored rather than raising, so an FAA
    schema addition degrades to missing data instead of a dead pipeline.
    """
    root = ET.fromstring(xml_text)
    update_time = _parse_update_time(root.findtext("Update_Time"))

    records = []
    for block in root.findall("Delay_type"):
        for child in block:
            handler = _LIST_HANDLERS.get(child.tag)
            if not handler:
                continue
            item_tag, parse_item = handler
            for item in child.findall(item_tag):
                records.extend(parse_item(item))

    return {"update_time": update_time, "records": records}
