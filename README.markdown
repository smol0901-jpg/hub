# LLM Hub (Supabase + GitHub Pages)

Админка-хаб: ключи на проекты, провайдеры (GigaChat, Grok, DeepSeek…), история запросов и токены.

## Безопасность

1. **Срочно перевыпустите** `sb_secret_…` / service_role — ключ был в чате.
2. В админку на GitHub Pages кладите **только** URL + **publishable/anon**.
3. **Secret** — только в Supabase Edge Functions (автоматически) и Dashboard → Settings → API.

## 1. SQL

Supabase → SQL Editor → вставить `supabase/schema.sql` → Run.

## 2. Auth

Authentication → Providers → Email: включить.  
(Для теста можно отключить Confirm email.)

## 3. Edge Functions

```bash
supabase login
supabase link --project-ref dblnkmtkuzdbqkunjvkf
supabase functions deploy admin-api
supabase functions deploy llm-gateway
```

В Dashboard → Edge Functions убедитесь, что есть доступ к `SUPABASE_SERVICE_ROLE_KEY` (по умолчанию есть).

## 4. Админка на GitHub Pages

Папку `admin/` залить в репозиторий (корень Pages = `admin` или `admin/index.html` в docs/).

Открыть сайт → ввести:

- URL: `https://dblnkmtkuzdbqkunjvkf.supabase.co`
- Publishable key (новый, после ротации)

1. Создать аккаунт (email + пароль)  
2. **Стать первым админом**  
3. Провайдеры → сохранить GigaChat  
4. Ключи → создать `orbit` → скопировать `orb_live_…`

## 5. Подключение Орбиты (позже)

```
Gateway: https://dblnkmtkuzdbqkunjvkf.supabase.co/functions/v1/llm-gateway
Header:  X-Orbit-Key: orb_live_xxxx
Body:    { "provider":"giga", "messages":[…] }
```

## Аккаунт

Логин = **email + пароль** через Supabase Auth (не postgres user).  
Пользователь БД `postgres` — только для SQL/подключения с сервера, не для админки.
