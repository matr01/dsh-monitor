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

Kompakce má v presetu izolovanou službu. Runner před prvním úkolem nastaví
její konfiguraci na stejný rozpočet jako home-level patch. Při změně DSH
je třeba ověřit kompatibilitu tohoto konfiguračního rozhraní.

Artefakt `dsh-logs` se nahrává i při selhání. Obsahuje diagnostiku DSH
a JSONL session události jednotlivých monitorů, včetně promptů, definic nástrojů
a výsledků. Nejde o zachycení přesného HTTP payloadu Groq. Logy mohou obsahovat
citlivý obsah úkolů a souborů; před sdílením je zkontrolujte.

Lokální test runneru bez modelových volání: `node --test .github/dsh/ci-runner.test.mjs`.