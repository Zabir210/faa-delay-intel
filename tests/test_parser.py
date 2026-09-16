from datetime import timezone
from pathlib import Path

import pytest

from ingest.parser import parse_duration_minutes, parse_nas_status

FIXTURE = (Path(__file__).parent / "fixtures" / "nas_status_sample.xml").read_text()

EMPTY = (
    "<AIRPORT_STATUS_INFORMATION>"
    "<Update_Time>Wed Sep 16 01:57:58 2026 GMT</Update_Time>"
    "<Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File>"
    "</AIRPORT_STATUS_INFORMATION>"
)


# ---------- duration parsing ----------

@pytest.mark.parametrize("text,expected", [
    ("15 minutes", 15),
    ("1 minute", 1),
    ("46 minutes", 46),
    ("1 hour", 60),
    ("2 hours", 120),
    ("1 hour and 30 minutes", 90),
    ("1 hour 30 minutes", 90),
    ("", None),
    (None, None),
    ("garbage", None),
])
def test_parse_duration_minutes(text, expected):
    assert parse_duration_minutes(text) == expected


# ---------- document level ----------

def test_extracts_update_time_as_utc():
    result = parse_nas_status(FIXTURE)
    ts = result["update_time"]
    assert ts.year == 2026 and ts.month == 9 and ts.day == 16
    assert ts.tzinfo == timezone.utc


def test_empty_feed_returns_no_records_but_valid_time():
    """A calm NAS still returns a document. Must not crash or lose the timestamp."""
    result = parse_nas_status(EMPTY)
    assert result["records"] == []
    assert result["update_time"] is not None


# ---------- delays ----------

def test_extracts_arrival_departure_delays():
    records = parse_nas_status(FIXTURE)["records"]
    delays = [r for r in records if r["delay_type"] == "delay"]
    assert len(delays) == 2
    assert {d["airport"] for d in delays} == {"DFW", "ORD"}


def test_delay_fields_are_structured():
    records = parse_nas_status(FIXTURE)["records"]
    dfw = next(r for r in records if r["airport"] == "DFW")
    assert dfw["reason"] == "WX:Thunderstorms"
    assert dfw["min_delay_minutes"] == 15
    assert dfw["max_delay_minutes"] == 29
    assert dfw["trend"] == "Decreasing"
    assert dfw["direction"] == "Departure"


def test_hour_valued_max_is_normalised_to_minutes():
    """ORD's Max is '1 hour' — must become 60, not 1."""
    records = parse_nas_status(FIXTURE)["records"]
    ord_ = next(r for r in records if r["airport"] == "ORD")
    assert ord_["min_delay_minutes"] == 46
    assert ord_["max_delay_minutes"] == 60
    assert ord_["trend"] == "Increasing"


# ---------- closures ----------

def test_extracts_closures_from_all_blocks():
    """The feed contains TWO separate 'Airport Closures' Delay_type blocks.
    Both must be captured, not just the first."""
    records = parse_nas_status(FIXTURE)["records"]
    closures = [r for r in records if r["delay_type"] == "closure"]
    airports = {c["airport"] for c in closures}
    assert airports == {"ALO", "BGR", "LAX", "SAN", "DCA"}, (
        "expected closures from both blocks; got " + str(airports)
    )


def test_closure_retains_notam_and_times():
    records = parse_nas_status(FIXTURE)["records"]
    alo = next(r for r in records if r["airport"] == "ALO")
    assert alo["delay_type"] == "closure"
    assert "CLSD" in alo["reason"]
    assert alo["start_text"] == "Sep 08 at 09:00 UTC."
    assert alo["reopen_text"] == "Sep 23 at 03:00 UTC."


# ---------- invariants ----------

def test_every_record_keeps_raw_text():
    """raw is what lets history be reprocessed if the FAA changes format."""
    for r in parse_nas_status(FIXTURE)["records"]:
        assert r["raw"], f"missing raw for {r['airport']}"


def test_records_have_unique_natural_key():
    """(airport, delay_type, direction) must be unique within one snapshot,
    or the DB unique constraint will silently drop rows."""
    records = parse_nas_status(FIXTURE)["records"]
    keys = [(r["airport"], r["delay_type"], r["direction"]) for r in records]
    assert len(keys) == len(set(keys)), f"duplicate natural keys: {keys}"


def test_all_airports_are_valid_codes():
    for r in parse_nas_status(FIXTURE)["records"]:
        assert 3 <= len(r["airport"]) <= 4
        assert r["airport"].isupper()
