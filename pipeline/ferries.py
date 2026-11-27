"""Which ferries count for the bike: those that take bikes all year. Summer-only ferries are left out.

Both cycle networks use this rule: network.py imports it, and osrm.sh writes the ferries it leaves out to a file
the OSRM profile reads (summer-ferries.txt beside the graph).
Run: uv run python ferries.py <netherlands.osm.pbf> <summer-ferries.txt>
"""
import re
import sys

MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
MONTH = re.compile(r"\b(" + "|".join(MONTHS) + r")\b")
DAYS = re.compile(r"\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b")
NO_BIKES = {"no", "private", "use_sidepath"}


def takes_bikes(tags):
    bicycle = tags.get("bicycle")
    return bicycle not in NO_BIKES and (tags.get("access") not in {"no", "private"} or bicycle in {"yes", "designated"})


def months(rule):
    """The months a rule names, as a set of 0-11. 'Apr 27,May 01-Jun 15' gives Apr, May, Jun; 'Oct-Mar' wraps."""
    found = [(m.start(), m.end(), MONTHS.index(m.group())) for m in MONTH.finditer(rule)]
    out, i = set(), 0
    while i < len(found):
        start, end, first = found[i]
        between = rule[end:found[i + 1][0]] if i + 1 < len(found) else ""
        if between and "-" in between and "," not in between:
            last = found[i + 1][2]
            out.update((first + k) % 12 for k in range((last - first) % 12 + 1))
            i += 2
        else:
            out.add(first)
            i += 1
    return out


def whole_months(rule):
    """The months a closure such as 'Mar 15-Jun 30 off' covers completely (Apr, May, Jun)."""
    names = "|".join(MONTHS)
    m = re.search(rf"\b({names})(?: (\d+))?\s*-\s*({names})(?: (\d+))?", rule)
    if not m:
        return set() if re.search(r"\d", rule) else {MONTHS.index(x) for x in MONTH.findall(rule)}
    first, last = MONTHS.index(m.group(1)), MONTHS.index(m.group(3))
    span = [(first + k) % 12 for k in range((last - first) % 12 + 1)]
    starts_whole = not m.group(2) or int(m.group(2)) == 1
    ends_whole = not m.group(4) or int(m.group(4)) >= 28
    if len(span) == 1:
        return {first} if starts_whole and ends_whole else set()
    return set(span[1:-1]) | ({first} if starts_whole else set()) | ({last} if ends_whole else set())


def runs_all_year(tags):
    """True unless the ferry's opening hours leave a whole month without a sailing. A ferry tagged seasonal counts
    only if its hours name every month: some only change their hours in winter."""
    seasonal = tags.get("seasonal", "no") != "no"
    noted = tags.get("opening_hours", "")
    hours = re.sub(r'"[^"]*"', "", noted).strip(" ;,")
    if not hours:
        # A note alone, such as "see website", does not say it runs all year.
        return not noted and not seasonal
    open_months, closed = set(), set()
    # Rules are separated by ";" or "||". Within one, ", " (with a space) starts another rule, which mappers
    # usually mean for the same months: "May-Sep Mo-Fr 13:00-17:30, Sa-Su 10:30-18:30".
    for rule in re.split(r";|\|\|", hours):
        named = None
        for part in rule.split(", "):
            part = part.strip()
            if MONTH.search(part):
                named = months(part)
            if re.search(r"\b(off|closed)\b", part):
                if not DAYS.search(part):
                    closed |= whole_months(part)
            elif named is not None:
                open_months |= named
            elif part and "easter" not in part and not seasonal:
                open_months = set(range(12))
    return len(open_months - closed) == 12


def main(pbf, out):
    import osmium
    left_out = []
    for way in osmium.FileProcessor(pbf).with_filter(osmium.filter.TagFilter(("route", "ferry"))):
        if isinstance(way, osmium.osm.Way) and not runs_all_year(dict(way.tags)):
            left_out.append(way.id)
    with open(out, "w") as f:
        f.write("".join(f"{i}\n" for i in left_out))
    print(f"{len(left_out)} summer-only ferries left out", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
