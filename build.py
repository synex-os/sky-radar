"""Собирает одну страницу index.html из исходников в src/."""
from pathlib import Path

root = Path(__file__).parent
src = root / "src"
html = (src / "template.html").read_text(encoding="utf-8")
for marker, name in [("/*@@ASTRO@@*/", "astro.js"), ("/*@@STARS@@*/", "stars.js"), ("/*@@GLOSSARY@@*/", "glossary.js"), ("/*@@SATLIB@@*/", "../vendor/satellite.min.js"), ("/*@@SATS@@*/", "sats.js"), ("/*@@PLANES@@*/", "planes.js"), ("/*@@APP@@*/", "app.js"), ("/*@@AR@@*/", "ar.js"), ("/*@@LEARN@@*/", "learn.js")]:
    html = html.replace(marker, (src / name).read_text(encoding="utf-8"))
(root / "index.html").write_text(html, encoding="utf-8")
print("index.html:", len(html.encode("utf-8")), "bytes")
