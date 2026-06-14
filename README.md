# Pinterest Backup

Локальный append-only архив личных досок Pinterest. Сервис входит в аккаунт через обычную
веб-форму в Chromium, вызывает внутренние `resource` endpoints из browser context и сохраняет:

- доски: название, описание, privacy и исходный JSON;
- пины: название, описание, ссылки и исходный JSON;
- оригинальные изображения и лучшие доступные прямые версии видео;
- время первого/последнего обнаружения и `missing_since_at` для пропавших объектов.

Локальные файлы никогда не удаляются автоматически. Одинаковые файлы дедуплицируются по SHA-256.

> Внутренний API Pinterest не документирован и может измениться. Проект не обходит CAPTCHA или
> 2FA. Используйте его только со своим аккаунтом и учитывайте правила Pinterest.

## Запуск в Docker

1. Создайте конфигурацию и файл с паролем:

   ```bash
   cp .env.example .env
   mkdir -p secrets data
   printf '%s' 'YOUR_PASSWORD' > secrets/pinterest_password.txt
   chmod 600 secrets/pinterest_password.txt
   ```

2. Укажите `PINTEREST_EMAIL` в `.env`. `PINTEREST_USERNAME` обычно можно оставить пустым.
   Если UID/GID пользователя сервера отличаются от `1000`, укажите их в `.env`:

   ```bash
   id -u
   id -g
   ```

   Полученные значения запишите как `PUID` и `PGID`. Entry point контейнера исправляет права
   bind mount `./data`, после чего запускает Node.js без root-привилегий.

3. Соберите образ и проверьте вход:

   ```bash
   docker compose build
   docker compose run --rm pinterest-backup auth
   ```

   На headless-сервере удобнее импортировать cookies из уже авторизованного браузера. Экспортируйте
   cookies только для `pinterest.com` в JSON или Netscape-формате и передайте файл в stdin:

   ```bash
   cat pinterest-cookies.json | docker compose run --rm -T pinterest-backup import-cookies -
   ```

   Можно передать экспорт с локального компьютера сразу через SSH, не сохраняя его отдельным
   файлом на сервере:

   ```bash
   cat pinterest-cookies.json | ssh user@server \
     'cd /path/to/pinterest-backup && docker compose run --rm -T pinterest-backup import-cookies -'
   ```

   Поддерживаются JSON-экспорты расширений вроде Cookie-Editor, Netscape `cookies.txt` и строка
   `Cookie:` из запроса в DevTools. Импорт оставляет только Pinterest cookies и требует `_auth=1`
   вместе с `_pinterest_sess`.

4. Запустите сервис:

   ```bash
   docker compose up -d
   docker compose logs -f pinterest-backup
   ```

По умолчанию синхронизация выполняется при старте и затем раз в три часа. Интервал задаётся
`SYNC_INTERVAL_HOURS`. Ручной запуск:

```bash
docker compose run --rm pinterest-backup sync
```

## Данные

```text
data/
  backup.sqlite
  session.json
  assets/ab/abcdef....jpg
  tmp/
```

`session.json` содержит авторизованные cookies и имеет те же требования к защите, что и пароль.
Пароль после входа в SQLite или `session.json` не записывается.

## Локальная разработка

```bash
npm install
npx playwright install chromium
npm test
npm run typecheck
```

Для диагностики входа с видимым браузером установите `PINTEREST_HEADLESS=false` и запускайте
`npm run auth` в графической сессии. Если Pinterest требует CAPTCHA или 2FA, их нужно пройти вручную.

Например, первоначальную авторизацию можно выполнить на хосте, сохранив сессию сразу в volume
контейнера:

```bash
PINTEREST_HEADLESS=false \
AUTH_TIMEOUT_SECONDS=180 \
npm run auth
```

CLI автоматически загружает локальный `.env`, включая `PINTEREST_EMAIL` и путь
`PINTEREST_PASSWORD_FILE`. После входа `docker compose up -d` использует созданный
`data/session.json`, и credentials для каждой синхронизации уже не нужны. При неудачном входе
безопасная сводка ответа и screenshot сохраняются в `data/auth-debug/`; пароль и cookies в
диагностический JSON не записываются.
