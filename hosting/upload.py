"""Upload a completed Sites data build."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from getpass import getpass
from http.client import HTTPSConnection
import json
from pathlib import Path
import re
import sys
import threading
import time
from urllib.parse import quote, urlsplit


def publish(args, site_token, publish_token):
    site = urlsplit(args.origin)
    if site.scheme != "https" or not site.hostname or site.path not in ("", "/") or site.username or site.query or site.fragment:
        raise ValueError("Supply the HTTPS Site origin")
    folder = args.directory.resolve(strict=True)
    if not (folder / "public/index.json.gz").is_file() or not (folder / "grid/index.json.gz").is_file():
        raise ValueError("Pack the complete data before uploading")
    directories = [folder]
    if args.add_derived:
        directories = [folder / "public" / name for name in ("planner", "bike-comparison")]
    files = sorted(f for directory in directories for f in directory.rglob("*") if f.is_file())
    if not files:
        raise ValueError("There are no files to upload")
    total = sum(p.stat().st_size for p in files)
    print(f"{len(files)} objects, {total:,} bytes", flush=True)
    if total > args.max_bytes:
        raise ValueError(f"This data exceeds the approved {args.max_bytes:,}-byte limit")
    if any(not 0 < p.stat().st_size <= 32 * 1024**2 for p in files):
        raise ValueError("Data contains empty objects or objects larger than 32 MiB")

    local = threading.local()
    connections = []
    headers = {"OAI-Sites-Authorization": f"Bearer {site_token}", "Authorization": f"Bearer {publish_token}"}

    def send(key, body):
        url = f"/__data/{args.release}/{quote(key, safe='/')}"
        for attempt in range(5):
            try:
                if not getattr(local, "connection", None):
                    local.connection = HTTPSConnection(site.hostname, site.port, timeout=40)
                    connections.append(local.connection)
                local.connection.request("PUT", url, body, headers)
                with closing(local.connection.getresponse()) as response:
                    response.read()
                    status = response.status
                if status == 201:
                    return
                if status < 500 and status != 429:
                    raise ValueError(f"{key}: HTTP {status}")
                error = f"HTTP {status}"
            except OSError as exc:
                error = exc.__class__.__name__
            local.connection.close()
            if attempt < 4:
                time.sleep(2**attempt)
        raise OSError(f"{key}: {error}")

    def put(file):
        send(file.relative_to(folder).as_posix(), file.read_bytes())

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            for n, _ in enumerate(executor.map(put, files), 1):
                if n % 250 == 0 or n == len(files):
                    print(f"Uploaded {n}/{len(files)}", flush=True)
        if not args.add_derived:
            send("activate", b"1")
            print(f"Activated {args.release}", flush=True)
    finally:
        for conn in connections:
            conn.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("origin")
    p.add_argument("directory", type=Path)
    p.add_argument("release", help="A new release identifier. Reuse only to retry the same immutable input.")
    p.add_argument("--max-bytes", type=int, required=True)
    p.add_argument("--add-derived", action="store_true", help="Upload planner and comparison files to an existing release")
    p.add_argument("--workers", type=int, default=12, choices=range(1, 25), metavar="1..24")
    p.add_argument("--credentials-stdin", action="store_true", help="Read a JSON list of the Sites access and publish tokens")
    args = p.parse_args()
    if not re.fullmatch("[a-z0-9][a-z0-9-]{0,63}", args.release):
        p.error("Invalid release identifier")
    if args.credentials_stdin:
        site, upload = json.loads(sys.stdin.readline())
    else:
        site = getpass("Sites access token: ")
        upload = getpass("R2 publish token: ")
    if not site or not upload:
        p.error("Both tokens are required")
    publish(args, site, upload)


if __name__ == "__main__":
    main()
