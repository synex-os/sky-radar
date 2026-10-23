"""Собирает орбиты Starlink из tle.ivanstanojevic.me, когда CelesTrak не отдаёт их серверам GitHub.

Сервис отдаёт по 100 спутников на страницу, поэтому идём страницами по очереди, не торопясь.
Пропускаем давно сгоревшие спутники: их орбиты не обновлялись больше двух недель.

    python3 tools/fetch_starlink.py _site/data/starlink.tle
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://tle.ivanstanojevic.me/api/tle/?search=STARLINK&page-size=100&page={}"
UA = "sky-radar (github.com/synex-os/sky-radar)"
FRESH = timedelta(days=14)


def get_page(n):
    for attempt in range(3):
        try:
            req = urllib.request.Request(API.format(n), headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # сервис иногда отвечает медленно — подождём и повторим
            err = e
            time.sleep(5 * (attempt + 1))
    raise err


def main(out_path):
    now = datetime.now(timezone.utc)
    first = get_page(1)
    pages = (first.get("totalItems", 0) + 99) // 100
    seen, lines, failed = set(), [], []
    for n in range(1, pages + 1):
        try:
            data = first if n == 1 else get_page(n)
        except Exception as e:  # одна упавшая страница — не повод выбрасывать остальные
            failed.append(f"{n}: {e}")
            continue
        for s in data.get("member", []):
            sid = s.get("satelliteId")
            epoch = datetime.fromisoformat(s["date"].replace("Z", "+00:00"))
            if sid in seen or now - epoch > FRESH:
                continue
            seen.add(sid)
            lines += [s["name"], s["line1"], s["line2"]]
        time.sleep(0.5)
    if failed:
        print(f"не скачались страницы ({len(failed)} из {pages}): {'; '.join(failed[:3])}")
    if len(failed) > pages // 5 or not seen:
        sys.exit("слишком много страниц не скачалось — не сохраняю неполный Starlink")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"{len(seen)} свежих орбит Starlink из {pages} страниц")


if __name__ == "__main__":
    main(sys.argv[1])
