Шаги для деплоя на Fly.io (backend 24/7)

1. Установите `flyctl` (инструкция на https://fly.io/docs/)

2. Авторизуйтесь:

```
flyctl auth login
```

3. Инициализация приложения (в корне репозитория):

```
flyctl launch --name speeddash-pro --image "" --no-deploy --copy-config
```

Это создаст `fly.toml`. Замените содержимое на предоставленный `fly.toml` или используйте его как есть.

4. Установите секреты (Stripe, GMAIL, и т.д.):

```
flyctl secrets set STRIPE_SECRET_KEY="sk_..." GMAIL_USER="you@example.com" GMAIL_APP_PASSWORD="XXXXXXXXXXXX"
```

5. Задеплойте приложение:

```
flyctl deploy --remote-only
```

6. Проверка:

Откройте `https://<app>.fly.dev/health` — должен вернуть JSON `{ ok: true }`.

Примечания:
- Fly автоматически назначает публичный домен `*.fly.dev`. Для собственного домена настройте DNS и добавьте через `flyctl certs`.
- Fly поддерживает авто-масштаб и рестарт при падениях — подходит для 24/7.
