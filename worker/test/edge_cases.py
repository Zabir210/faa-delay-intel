"""Generate adversarial XML documents for parser parity (Python vs TS)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UT = "<Update_Time>Wed Sep 16 01:57:58 2026 GMT</Update_Time>"


def doc(body, ut=UT, pre=""):
    return f"{pre}<AIRPORT_STATUS_INFORMATION>{ut}{body}</AIRPORT_STATUS_INFORMATION>"


def delay(arpt="DFW", legs="", reason="WX:Thunderstorms"):
    return (f"<Delay_type><Name>General Arrival/Departure Delay Info</Name>"
            f"<Arrival_Departure_Delay_List><Delay><ARPT>{arpt}</ARPT><Reason>{reason}</Reason>"
            f"{legs}</Delay></Arrival_Departure_Delay_List></Delay_type>")


LEG = '<Arrival_Departure Type="{t}"><Min>{mn}</Min><Max>{mx}</Max><Trend>Increasing</Trend></Arrival_Departure>'

cases = {
    "fixture": (ROOT / "tests/fixtures/nas_status_sample.xml").read_text(),
    "live": Path(sys.argv[2]).read_text(),
    "empty": doc(""),
    "xml_decl_crlf": doc(delay(legs=LEG.format(t="Arrival", mn="15 minutes", mx="1 hour"))
                         .replace("><", ">\r\n  <"), pre='<?xml version="1.0" encoding="UTF-8"?>\r\n'),
    "both_legs": doc(delay(legs=LEG.format(t="Arrival", mn="1 hour and 30 minutes", mx="2 hours")
                                + LEG.format(t="Departure", mn="45 minutes", mx="1 hour 5 minutes"))),
    "no_legs": doc(delay()),
    "missing_arpt": doc(delay(arpt="")),
    "ws_arpt": doc(delay(arpt="   ")),
    "entities": doc(delay(reason="A &amp; B &lt;x&gt; &quot;q&quot; &apos;s&apos; &#233;&#x1F6EB;")),
    "cdata": doc(delay(reason="<![CDATA[raw <stuff> & more]]>")),
    "comment_pi": doc(delay(reason="before<!-- note -->after<?pi x?>end")),
    "attr_entities": doc(delay(legs=LEG.format(t="Arr&amp;val &#10;x\ty", mn="5 minutes", mx="9 minutes"))),
    "single_quote_attr": doc(delay(legs=LEG.format(t="Departure", mn="5 minutes", mx="9 minutes")
                                   .replace('"Departure"', "'Departure'"))),
    "unicode_ws": doc(delay(arpt="\u00a0ORD\u2003", legs=LEG.format(t="Arrival", mn="15\u00a0minutes", mx="1\u2009hour"))),
    "weird_durations": doc(delay(legs=LEG.format(t="Arrival", mn="garbage", mx="") +
                                 LEG.format(t="Departure", mn="2 HOURS AND 3 MINUTES", mx="90minutes"))),
    "self_closing": doc(delay(legs='<Arrival_Departure Type="Arrival"><Min/><Max></Max><Trend /></Arrival_Departure>')),
    "unknown_block": doc("<Delay_type><Name>New Thing</Name><Brand_New_List><X><ARPT>ZZZ</ARPT></X></Brand_New_List></Delay_type>"),
    "dup_closure_blocks": doc(
        "<Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>A1</ARPT><Reason>r</Reason>"
        "<Start>s</Start><Reopen>o</Reopen></Airport></Airport_Closure_List></Delay_type>"
        "<Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>A2</ARPT>"
        "</Airport></Airport_Closure_List></Delay_type>"),
    "ground": doc(
        "<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>BOS</ARPT>"
        "<Reason>runway construction</Reason><Avg>1 hour and 6 minutes</Avg><Max>2 hours and 44 minutes</Max>"
        "</Ground_Delay></Ground_Delay_List></Delay_type>"
        "<Delay_type><Name>Ground Stop Programs</Name><Ground_Stop_List><Program><ARPT>SFO</ARPT>"
        "<Reason>WX</Reason><End_Time>1:45 pm EDT</End_Time></Program></Ground_Stop_List></Delay_type>"),
    "tail_text": doc(delay(legs=LEG.format(t="Arrival", mn="5 minutes", mx="9 minutes") + "stray tail & text")),
    "mixed_text_children": doc(delay(reason="x") .replace("<Reason>x</Reason>", "<Reason>a<b>c</b>d</Reason>")),
    "ut_unpadded_day": doc("", ut="<Update_Time>Wed Oct 7 23:54:54 2026 GMT</Update_Time>"),
    "ut_lowercase": doc("", ut="<Update_Time>wed oct 07 23:54:54 2026 gmt</Update_Time>"),
    "ut_utc": doc("", ut="<Update_Time>Wed Oct 07 23:54:54 2026 UTC</Update_Time>"),
    "ut_est": doc("", ut="<Update_Time>Wed Oct 07 23:54:54 2026 EST</Update_Time>"),
    "ut_full_names": doc("", ut="<Update_Time>Wednesday October 07 23:54:54 2026 GMT</Update_Time>"),
    "ut_padded_ws": doc("", ut="<Update_Time>\n  Wed  Oct  07 23:54:54  2026 GMT \n</Update_Time>"),
    "ut_feb30": doc("", ut="<Update_Time>Mon Feb 30 23:54:54 2026 GMT</Update_Time>"),
    "ut_leap": doc("", ut="<Update_Time>Thu Feb 29 12:00:00 2024 GMT</Update_Time>"),
    "ut_bad_hour": doc("", ut="<Update_Time>Wed Oct 07 24:00:00 2026 GMT</Update_Time>"),
    "ut_no_tz": doc("", ut="<Update_Time>Wed Oct 07 23:54:54 2026</Update_Time>"),
    "ut_extra_token": doc("", ut="<Update_Time>Wed Oct 07 23:54:54 2026 GMT extra</Update_Time>"),
    "ut_missing": doc("", ut=""),
    "ut_empty": doc("", ut="<Update_Time></Update_Time>"),
    "ut_bad_dayname": doc("", ut="<Update_Time>Xyz Oct 07 23:54:54 2026 GMT</Update_Time>"),
    "ut_single_digit_time": doc("", ut="<Update_Time>Wed Oct 7 3:4:5 2026 GMT</Update_Time>"),
    # Malformed inputs: both sides must raise (the run is then logged as an error).
    "bad_mismatched": "<A><B></A>",
    "bad_undefined_entity": doc(delay(reason="&nbsp;")),
    "bad_unclosed": "<AIRPORT_STATUS_INFORMATION><Delay_type>",
    "bad_two_roots": "<A/><B/>",
    "bad_text_outside": "junk<A/>",
    "bad_html": "<html><body>Service Unavailable</body>",
    "bad_empty_string": "   ",
}

with open(sys.argv[1], "w") as f:
    for k, v in cases.items():
        f.write(json.dumps({"id": "edge:" + k, "xml": v}) + "\n")
