# dsh-monitor

DeepSeek Harness pro monitorování informací na internetu.

Agenti jsou spouštěni denně pomocí GitHub Actions (cron). Každý agent je definován
v samostatném prompt souboru ve složce `prompts/`. Výsledky se ukládají do složky
`output/<datum>/` a jsou automaticky commitovány zpět do repozitáře. Při ručním
spuštění lze vstupem `suffix` zvolit jinou složku (např. `b` → `output/<datum>-b/`),
aby se nepřepsaly výsledky dřívějšího běhu ze stejného dne.

## Struktura

- `prompts/` – definice jednotlivých monitorovacích úkolů (jeden soubor = jeden monitor)
- `output/` – výsledky běhů, členěné podle data
- `.github/workflows/daily-agents.yml` – workflow, které agenty spouští

## Jak přidat nový monitor

Stačí do složky `prompts/` přidat nový `.md` soubor s popisem úkolu.
Workflow ho při dalším běhu automaticky zařadí a spustí.

## Běh v CI

Workflow běží v kontejneru `ghcr.io/smanx/deepseek-harness` a každý prompt spustí
zvlášť jako `dsh --profile headless "<prompt>"` (sekvenčně, nejvýše 30 minut na monitor).
Nenulový exit kód (úkol neskončil `completed`) shodí běh. Konfigurace DSH se generuje
do `$DSH_HOME/cordis.patch.yml` přímo ve workflow.

Artefakt `dsh-logs` se nahrává i při selhání a obsahuje logy DSH a session
jednotlivých monitorů (`$DSH_HOME/logs`, `$DSH_HOME/sessions`). Mohou obsahovat
citlivý obsah úkolů a souborů; před sdílením je zkontrolujte.

## LLM provider

Provider je Google Gemini přes vestavěnou routu `google` v `llm-pi-ai` (nativní
Gemini protokol; OpenAI-kompatibilní endpoint padal na chybějící `thought_signature`).
Konfigurace routy nesmí uvádět `api` ani `baseURL` (`api: google-generative-ai` shodí
celou skupinu providerů). Vyžaduje secret `GEMINI_API_KEY`.

Výchozí model je `gemini-3.5-flash-lite`; při ručním spuštění lze vstupem `model`
zvolit `gemini-3.1-flash-lite` nebo `gemini-3.8-flash`.

Free limity Gemini jsou nízké (cca 5 požadavků/min, 20/den), proto monitory běží
sekvenčně a `retryPolicy` opakuje i `RATE_LIMIT` s delším backoffem (20 s, 40 s, 60 s).

Starší varianta s providery Groq a Z.ai (vlastní CI runner s presetem `ptc-minimal`)
je zachována ve větvi `multi-provider` a spouští se jen ručně.