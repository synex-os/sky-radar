# Небесный радар

Что сейчас над головой: Луна, Солнце, планеты, яркие звёзды, МКС и другие спутники с прогнозом видимых пролётов, самолёты.
Режим камеры: наводишь телефон на небо — метки поверх картинки (компас подгоняется по Луне или планете).

Сайт: https://synex-os.github.io/sky-radar/ — на Android ставится как приложение (Chrome → «Установить приложение»), работает и без сети.

Сборка: `python3 build.py` → один файл `index.html` (его и отдаёт GitHub Pages).
Исходники в `src/`, план и заметки — в `CLAUDE.md`.

Орбиты спутников: [CelesTrak](https://celestrak.org). Расчёт орбит: [satellite.js](https://github.com/shashwatak/satellite-js) (MIT).
GitHub Actions раз в 6 часов собирает сайт и подкладывает свежие орбиты (`.github/workflows/pages.yml`).
Самолёты: [adsb.fi](https://adsb.fi), запасной [adsb.lol](https://adsb.lol) (ODbL) через посредника на Cloudflare — см. `worker/README.md`.
