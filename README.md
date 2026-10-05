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