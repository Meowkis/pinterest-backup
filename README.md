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

3. Соберите образ и проверьте вход:

   ```bash
   docker compose build
   docker compose run --rm pinterest-backup auth
   ```

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
