# dsh-monitor

DeepSeek Harness pro monitorování informací na internetu.

Agenti jsou spouštěni denně pomocí GitHub Actions (cron). Každý agent je definován
v samostatném prompt souboru ve složce `prompts/`. Výsledky se ukládají do složky
`output/<datum>/` a jsou automaticky commitovány zpět do repozitáře.

## Struktura

- `prompts/` – definice jednotlivých monitorovacích úkolů (jeden soubor = jeden monitor)
- `output/` – výsledky běhů, členěné podle data
- `.github/workflows/daily-agents.yml` – workflow, které agenty spouští

## Jak přidat nový monitor

Stačí do složky `prompts/` přidat nový `.md` soubor s popisem úkolu.
Workflow ho při dalším běhu automaticky zařadí a spustí.

## Minimal PTC v CI

Workflow instaluje `dsh-minimal-ptc` do profilu `web` v kontejneru
`smanx/deepseek-harness:devtools-min-latest`. CI runner v `.github/dsh/ci-runner.mjs`
vytváří agenta s presetem `ptc-minimal` přes oficiální preset API; běžný
`headless` runner preset nevybírá. `DSH_AGENT_PRESET`, `DSH_CI_PROVIDER`,
`DSH_CI_MODEL` a `DSH_CI_PROMPT_FILE` jsou vstupy našeho CI runneru,
nikoli obecné přepínače DSH. Runner vyžaduje aktuální preset API DSH.

CI runner se instaluje jako lokální bundle `dsh-monitor-ci` do stejného profilu
jako Minimal PTC. Importy jádra probíhají uvnitř hlídaného startu: chyby se
vypíšou do stderr a uloží do `logs/ci-startup-*.log`. Aktivace presetu má limit
120 sekund; celý jeden monitor nejvýše 30 minut. Úspěšný start vypíše
`dsh CI: active preset=ptc-minimal, provider=google, model=gemini-3.5-flash-lite`.

Kompakce má v presetu izolovanou službu. Runner před prvním úkolem nastaví
její konfiguraci na stejný rozpočet jako home-level patch. Při změně DSH
je třeba ověřit kompatibilitu tohoto konfiguračního rozhraní.

Artefakt `dsh-logs` se nahrává i při selhání. Obsahuje diagnostiku DSH
a JSONL session události jednotlivých monitorů, včetně promptů, definic nástrojů
a výsledků. Nejde o zachycení přesného HTTP payloadu providera. Logy mohou obsahovat
citlivý obsah úkolů a souborů; před sdílením je zkontrolujte.

Lokální test runneru bez modelových volání: `node --test .github/dsh/ci-runner.test.mjs`.

## LLM provider

Výchozí provider je Google Gemini přes vestavěnou routu `google` v `llm-pi-ai`
(nativní Gemini protokol; OpenAI-kompatibilní endpoint padal na chybějící
`thought_signature`) s modelem
`gemini-3.5-flash-lite`; k dispozici jsou i `gemini-3.8-flash` a
`gemini-3.1-flash-lite`. Vyžaduje secret
`GEMINI_API_KEY`. Konfigurace routy nesmí uvádět `api` ani `baseURL`
(`api: google-generative-ai` shodí celou skupinu providerů). Groq (`qwen/qwen3.8-27b`, secret `GROQ_API_KEY`) lze zvolit
při ručním spuštění workflow vstupem `provider`; vstup `model` přepíše model.

Free limity Gemini jsou nízké (cca 5 požadavků/min, 20/den), proto monitory
běží sekvenčně. CI runner obaluje `fetch` pro `/chat/completions` a Gemini
`:generateContent`/`:streamGenerateContent`: odpovědi
429 a 503 opakuje s exponenciálním backoffem (15 s, 30 s), přednostně podle
`retry-after`/`retry-after-ms` nebo Gemini `retryDelay`, nejvýše 3 pokusy;
delší požadované čekání než 120 s se neopakuje. Adaptér `llm-pi-ai` hodnotu
`retry-after` do DSH `retryPolicy` nepředává, proto `retryPolicy` kódy
`RATE_LIMIT`, `QUOTA` a `SERVER` znovu neopakuje (pokusy by se násobily).
Každý monitor vypíše `dsh CI: LLM requests=N (retries=M)` a zapíše počet do
`$DSH_HOME/llm-requests.tsv`; krok `LLM request summary` vypíše součet
i do souhrnu běhu.