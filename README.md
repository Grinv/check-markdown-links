# checkmdlinks

## Что это

`checkmdlinks` — CLI-утилита, которая проверяет ссылки во всех Markdown-файлах
указанной папки: локальные ссылки — на существование файла/каталога на диске,
внешние (`http`/`https`) — на доступность HTTP-запросом. Печатает цветной
отчёт в консоль и возвращает код выхода, удобный для CI.

## Требования

- Node.js **24.19.0 LTS** («Krypton») — версия зафиксирована в `.nvmrc`.
  Перед работой в проекте выполните `nvm use`.
- **Зависимостей нет.** `dependencies` и `devDependencies` в `package.json`
  пустые, `npm install` ничего не скачивает. Исходники — файлы `.ts`,
  исполняемые нативным type-stripping'ом Node (без `tsc` и без сборки).

## Установка

```sh
git clone <repo-url> checkmdlinks
cd checkmdlinks
nvm use
npm link            # регистрирует команду `checkmdlinks` глобально
```

Без `npm link` утилиту можно запускать напрямую:

```sh
node bin/checkmdlinks.ts <folder>
```

## Запуск

```sh
checkmdlinks <folder>
```

Примеры:

```sh
checkmdlinks .
checkmdlinks docs --timeout 3000
checkmdlinks . --json > report.json
```

## Флаги

| Флаг | Тип | Дефолт | Смысл |
|---|---|---|---|
| `--timeout <ms>` | number | `5000` | Таймаут одного HTTP-запроса |
| `--concurrency <n>` | number | `8` | Одновременных HTTP-запросов |
| `--no-external` | boolean | `false` | Не проверять `http(s)`, помечать `skipped` |
| `--only-external` | boolean | `false` | Не проверять локальные ссылки |
| `--ignore <name>` | string, многократно | — | Доп. каталог/имя для исключения при обходе |
| `--json` | boolean | `false` | Машинный вывод вместо таблицы |
| `--no-color` | boolean | `false` | Отключить ANSI |
| `-h`, `--help` | boolean | — | Usage в `stdout`, exit `0` |
| `-v`, `--version` | boolean | — | Версия из `package.json`, exit `0` |

## Что выводит

Текстовый режим (реальный запуск на демонстрационной папке из двух файлов;
в таблицу попадают только сломанные ссылки):

```
Scanned /tmp/demo: 2 file(s), 8 link(s)

README.md
  Позиция | Ссылка                 | Статус | Код
  --------+------------------------+--------+-----------------
  6:1     | ./docs/missing.md      | BROKEN | NOT_FOUND
  7:1     |                        | BROKEN | EMPTY_URL
  11:1    | #несуществующий-раздел | BROKEN | ANCHOR_NOT_FOUND

Files: 2  Links: 8  External links: 1 (0 unique)  ok: 3  broken: 3  warning: 0  skipped: 2  time: 4ms
3 broken link(s)
```

Файл без сломанных ссылок в таблице не появляется вовсе — статус видно только
по итоговой сводке. Строка `Статус` в таблице всегда красная (`BROKEN`);
цвета `ok`/`warning`/`skipped` (зелёный/жёлтый-оранжевый/серый) используются
в итоговой сводке ниже таблицы. При `--no-color`, `NO_COLOR` в окружении или
выводе не в TTY ANSI-коды отсутствуют полностью.

Режим `--json` (единственный вывод в `stdout`, без цветов):

```json
{
  "root": "/tmp/demo",
  "scannedFiles": 2,
  "totalLinks": 6,
  "uniqueExternalUrls": 1,
  "durationMs": 272,
  "summary": { "ok": 3, "broken": 2, "warning": 0, "skipped": 1 },
  "results": [
    {
      "file": "README.md",
      "line": 4,
      "column": 1,
      "kind": "inline",
      "text": "Пропавший файл",
      "rawUrl": "./docs/missing.md",
      "type": "local",
      "target": "/tmp/demo/docs/missing.md",
      "anchor": null,
      "status": "broken",
      "httpStatus": null,
      "reason": "NOT_FOUND"
    }
  ],
  "warnings": []
}
```

Коды выхода:

| Код | Значение |
|---|---|
| `0` | Сломанных ссылок нет (warning-и не влияют) |
| `1` | Есть хотя бы одна сломанная ссылка |
| `2` | Ошибка использования: нет аргумента, плохой флаг, папка не найдена |

## Тесты

```sh
npm test              # node --test
npm run coverage      # node --test --experimental-test-coverage
```

Тесты не требуют сети: HTTP-проверки гоняются против локального
`node:http`-сервера, поднятого на порту `0`.

## Ограничения

- Пути сравниваются через файловую систему ОС: на macOS/Windows она
  регистронезависима, поэтому ссылка на `./README.MD` будет признана
  рабочей, даже если реальное имя файла — `README.md`.
- Якоря (`#section`) проверяются по заголовкам целевого файла, но только
  ATX-стиля (`#`…`######`); заголовки в стиле Setext (`Текст` + `===`/`---`)
  не распознаются и не создают слаг.
- Слаг заголовка — приближение алгоритма GitHub (нижний регистр, пробелы →
  дефисы, повторы получают суффикс `-1`, `-2`, …); в редких случаях может не
  совпасть с реальным поведением GitHub для экзотических символов.
- Ссылки в HTML-тегах (`<a href>`, `<img src>`) не разбираются — только
  Markdown-синтаксис ссылок.
- Схемы `mailto:`, `tel:`, `data:`, `ftp:` и подобные пропускаются
  (`skipped`), а не проверяются.
- Ссылки внутри блоков кода (fenced и inline) игнорируются намеренно.
- Якоря на внешних (`http`/`https`) URL не проверяются — только доступность
  самой страницы.
