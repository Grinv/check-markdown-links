# AGENDA — статистика подготовки репозитория

Расход ресурсов на: обсуждение задачи → план → генерацию `SPEC.md` → генерацию этого файла.

## Модель

| Параметр | Значение |
|---|---|
| Модель | Claude Opus 5 (`claude-opus-5`, окно контекста 1M) |
| Агент | Claude Code (CLI) |
| Дата | 2026-08-17 |
| Длительность сессии | ~11 минут (11:00:18 → 11:11:33 UTC) |
| Сообщений ассистента (с биллингом) | 36 |

## Токены

| Категория | Планирование | Генерация SPEC.md + AGENDA.md | Всего |
|---|---:|---:|---:|
| Input (без кэша) | 52 | 20 | 72 |
| Cache write (запись в кэш) | 69 442 | 729 986 | 799 428 |
| Cache read (чтение из кэша) | 1 238 483 | 662 952 | 1 901 435 |
| Output | 22 966 | 23 316 | 46 282 |
| Сообщений ассистента | 26 | 10 | 36 |

Границей этапов считается вызов `ExitPlanMode` (момент утверждения плана
пользователем).

Крупный `cache write` на втором этапе — разовая загрузка справочного skill'а
(`claude-api`, ~700K токенов контекста) для получения актуального прайса
модели.

## Ориентировочная стоимость (оценка)

Прайс Claude Opus 5: input $5 / 1M, output $25 / 1M, cache write (TTL 5 мин)
$6.25 / 1M (×1.25 от input), cache read $0.50 / 1M (×0.1 от input).

| Этап | Стоимость |
|---|---:|
| Планирование | ≈ $1.63 |
| Генерация SPEC.md + AGENDA.md | ≈ $5.48 |
| **Итого** | **≈ $7.10** |

Пометка: это оценка по публичному прайсу API, а не фактический счёт
(подписочные тарифы Claude Code считаются иначе).

## Методика замера

Цифры не оценочные — они посчитаны по транскрипту сессии, где Claude Code
сохраняет поле `usage` каждого ответа модели.

- Источник: `~/.claude/projects/-Users-konstantin-Documents-BackToFuture-check-markdown-links/31028e4d-08ed-4ee3-8428-055d0c0eb725.jsonl`
- Считались все записи с непустым `message.usage`: `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`.
- Разбивка по этапам — по индексу сообщения, содержащего `tool_use`
  с `name: "ExitPlanMode"`.

Воспроизвести (одна строка на суммирование всей сессии):

```sh
node -e '
const fs=require("fs");
const t={inp:0,cc:0,cr:0,out:0,n:0};
for (const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n")) {
  let j; try { j=JSON.parse(l) } catch { continue }
  const u=j.message&&j.message.usage; if(!u) continue;
  t.n++; t.inp+=u.input_tokens||0; t.cc+=u.cache_creation_input_tokens||0;
  t.cr+=u.cache_read_input_tokens||0; t.out+=u.output_tokens||0;
}
console.log(t, "cost=$"+((t.inp*5+t.cc*6.25+t.cr*0.5+t.out*25)/1e6).toFixed(4));
' <путь-к-транскрипту>.jsonl
```

Срез замера: 2026-08-17 11:11:33 UTC — момент непосредственно перед записью
этого файла. Токены самой записи `AGENDA.md` и последующего коммита в цифры
выше не входят (это ещё ~1–2 тысячи output-токенов).
