"""Quay names and positions for the region, from the national stop register (CHB)."""
import gzip
import json
import xml.etree.ElementTree as ET

from common import DATA, in_bbox, rd_to_wgs84


def local(tag):
    return tag.rsplit("}", 1)[-1]


def main():
    source = sorted((DATA / "ref").glob("ExportCHB_*.xml.gz"))[-1]
    quays = {}
    with gzip.open(source, "rb") as f:
        for _, element in ET.iterparse(f, events=("end",)):
            if local(element.tag) != "stopplace":
                continue
            name = town = None
            for child in element.iter():
                tag = local(child.tag)
                if tag == "publicname" and name is None:
                    name = (child.text or "").strip()
                elif tag == "town" and town is None:
                    town = (child.text or "").strip()
            for quay in element.iter():
                if local(quay.tag) != "quay":
                    continue
                code = x = y = None
                for child in quay.iter():
                    tag = local(child.tag)
                    if tag == "quaycode":
                        code = child.text
                    elif tag == "rd-x" and child.text:
                        x = float(child.text)
                    elif tag == "rd-y" and child.text:
                        y = float(child.text)
                if code and x and y:
                    lat, lon = rd_to_wgs84(x, y)
                    if in_bbox(lat, lon):
                        quays[code] = {"name": name, "town": town, "lat": round(lat, 6), "lon": round(lon, 6)}
            element.clear()
    out = DATA / "ref" / "quays.json"
    out.write_text(json.dumps(quays, ensure_ascii=False))
    print(len(quays), "quays in region")


if __name__ == "__main__":
    main()
