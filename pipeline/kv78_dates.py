"""Which archive days to use.

kv78_days.txt lists the archive path of every day in the 365 days up to the archive's last day (30 Aug 2026);
the archive is missing 7 of them. HISTORY adds one weekday a year for the historical timetables view.
"""
import datetime as dt
from pathlib import Path

DAYS_FILE = Path(__file__).with_name("kv78_days.txt")

# One weekday a year for the history view: the second Tuesday of October (2025 is in the year above).
HISTORY = {"2019-10-08": "FR-Sw-archive", "2020-10-13": "DE-Co-archive", "2021-10-12": "DE-Co-archive",
           "2022-10-11": "DE-Co-archive", "2023-10-10": "DE-Co-archive", "2024-10-08": "DE-Co-archive"}


def year_paths():
    return [p for p in DAYS_FILE.read_text().split() if p]


def days():
    """Every day of recorded times used for buses, trams and metros."""
    return [dt.date.fromisoformat(p.rsplit("_", 1)[1][:10]) for p in year_paths()]


def archive_paths():
    return year_paths() + [f"{folder}/{day[:7]}/KV78_{day}.csv.xz" for day, folder in sorted(HISTORY.items())]


if __name__ == "__main__":
    for path in archive_paths():
        print(path)
