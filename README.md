# Reinhard Discord Bot

MVP-бот для заявок в семью:

- панель подачи заявки;
- модальное окно анкеты;
- канал логов для рекрутеров;
- кнопки `Принять`, `Взять на рассмотрение`, `Вызвать на обзвон`, `Отклонить`;
- история прошлых заявок по Discord ID;
- HTTP API для связки с сайтом.

## Команды

```txt
/recruit-panel
/recruit-open status:true
/recruit-stats
/recruit-find user:@user
```

## Railway

В Railway добавь переменные:

```txt
DISCORD_TOKEN
DISCORD_CLIENT_ID
DISCORD_GUILD_ID
APPLICATION_LOG_CHANNEL_ID
APPLICATION_RESULT_CHANNEL_ID
CALL_CHANNEL_ID
TICKET_CATEGORY_ID
RECRUITER_ROLE_IDS
ADMIN_ROLE_IDS
FAMILY_NAME
TICKET_NAME_PREFIX
PANEL_IMAGE_URL
BRAND_ICON_URL
```

Start command:

```txt
npm run bot
```

Health URL:

```txt
/health
```

API для сайта:

```txt
/api/applications
```

## Тикеты

После отправки формы бот создает приватный канал:

```txt
тикет-username
```

Доступ получают только:

```txt
кандидат
роли из RECRUITER_ROLE_IDS
роли из ADMIN_ROLE_IDS
```

`@everyone` не видит канал.

## Права бота в Discord

Боту нужны права:

```txt
Send Messages
Embed Links
Use Slash Commands
Read Message History
Manage Messages не обязателен
```

При добавлении бота на сервер включи scope:

```txt
bot
applications.commands
```
