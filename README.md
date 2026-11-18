# dsh-monitor

DeepSeek Harness pro monitorování informací na internetu.

Agenti jsou spouštěni denně pomocí GitHub Actions (cron). Každý agent je definován
v samostatném prompt souboru ve složce `prompts/<sada>/`. Automatický běh používá
sadu `default`, při ručním spuštění lze vstupem `prompt_set` vybrat `default`
nebo `experimental`. Výsledky sady `default` se ukládají do složky `output/<datum>/`,
ostatních sad do `output/<datum>-<sada>/`, a jsou automaticky commitovány zpět do
repozitáře. Při ručním spuštění lze vstupem `suffix` přidat příponu (např. `b` →
`output/<datum>-b/` nebo `output/<datum>-experimental-b/`),
aby se nepřepsaly výsledky dřívějšího běhu stejné sady ze stejného dne.
Pokud už v cílové složce existuje neprázdný výstup promptu, workflow ho přeskočí
bez volání modelu. Pro nové vygenerování použijte jiný `suffix`.

## Struktura

- `prompts/default/` – monitory pro automatický běh (jeden soubor = jeden monitor)
- `prompts/experimental/` – další monitory volitelné při ručním spuštění
- `output/` – výsledky běhů, členěné podle data, sady a případné přípony
- `.github/workflows/daily-agents.yml` – workflow, které agenty spouští

## Jak přidat nový monitor

Stačí do složky `prompts/<sada>/` přidat nový `.md` soubor s popisem úkolu.
Workflow ho při dalším běhu dané sady automaticky zařadí a spustí. Spouští pouze
`.md` soubory přímo ve vybrané složce, nikoli v jejích podsložkách. Neexistující
nebo prázdná sada způsobí chybu běhu.
Prompt musí uložit výstup do kořene repozitáře jako neprázdný soubor se stejným
názvem, jaký má soubor promptu (např. `01-test-pocasi.md`).

Novou sadu vytvořte jako složku pod `prompts/` a přidejte její název do
`workflow_dispatch.inputs.prompt_set.options` ve workflow. Název může obsahovat
pouze písmena A-Z a-z, číslice, podtržítko a pomlčku.

## Běh v CI

Workflow běží v kontejneru `ghcr.io/smanx/deepseek-harness` a každý prompt spustí
zvlášť jako `dsh --profile headless "<prompt>"` (sekvenčně, nejvýše 30 minut na monitor).
Nenulový exit kód (úkol neskončil `completed`) shodí běh. Konfigurace DSH se generuje
do `$DSH_HOME/cordis.patch.yml` přímo ve workflow.

Po každém úspěšném promptu se ověří neprázdný výstup a ihned se přesune do cílové
složky. Chybějící nebo prázdný výstup způsobí chybu. Dokončené výsledky se commitují
a pushují i při selhání dalšího promptu; výstup chybujícího promptu se neukládá.
Opakovaný běh načte aktuální stav větve, takže při stejném `OUTPUT_DIR` dokončené
prompty neopakuje. Datum složky se počítá v UTC při spuštění, proto běh v jiný den
použije jinou složku.

Artefakt `dsh-logs` se nahrává i při selhání a obsahuje logy DSH a session
jednotlivých monitorů (`$DSH_HOME/logs`, `$DSH_HOME/sessions`). Mohou obsahovat
citlivý obsah úkolů a souborů; před sdílením je zkontrolujte.

## LLM provider

Provider je Google Gemini přes vestavěnou routu `google` v `llm-pi-ai` (nativní
Gemini protokol; OpenAI-kompatibilní endpoint padal na chybějící `thought_signature`).
Konfigurace routy nesmí uvádět `api` ani `baseURL` (`api: google-generative-ai` shodí
celou skupinu providerů). Vyžaduje secret `GEMINI_API_KEY`.

Výchozí model je `gemini-3.5-flash-lite`; při ručním spuštění lze vstupem `model`
zvolit také `gemini-3.1-flash-lite`, `gemini-3.8-flash`, `gemini-3-flash-preview`,
`gemini-3.6-flash` nebo `gemini-4-hydrogen`.

Modely `gemini-3-flash-preview`, `gemini-3.6-flash` a `gemini-4-hydrogen` mají
free limity 5 požadavků/min (RPM), 250 000 vstupních tokenů/min (TPM) a 20
požadavků/den (RPD). Limity vynucuje poskytovatel, workflow je samo nehlídá;
`contextWindow` není limit spotřeby za minutu.

Free limity Gemini jsou nízké (např. 15 požadavků/min pro `gemini-3.5-flash-lite`),
proto monitory běží sekvenčně a `retryPolicy` opakuje i `RATE_LIMIT` a `QUOTA`
(DSH tak hlásí Gemini 429 `RESOURCE_EXHAUSTED`) a `SERVER` (503 při přetížení modelu),
nejvýše 5× s backoffem 30 s, 60 s, 120 s, 120 s, 120 s (celkem ~7,5 min).

Starší varianta s providery Groq a Z.ai (vlastní CI runner s presetem `ptc-minimal`)
je zachována ve větvi `multi-provider` a spouští se jen ručně.