# dsh-monitor

DeepSeek Harness pro monitorování informací na internetu.

Agenti jsou spouštěni denně pomocí GitHub Actions (cron). Každý agent je definován
v samostatném prompt souboru ve složce `prompts/<sada>/`. Automatické běhy používají
sady a fáze podle rozvrhu níže; při ručním spuštění lze vstupem `prompt_set`
vybrat `default` nebo `experimental`. Výsledky sady `default` se ukládají do
složky `output/<datum>/`, ostatních sad do `output/<datum>-<sada>/`, a jsou
automaticky commitovány zpět do repozitáře. Při ručním spuštění lze vstupem
`suffix` přidat příponu (např. `b` →
`output/<datum>-b/` nebo `output/<datum>-experimental-b/`),
aby se nepřepsaly výsledky dřívějšího běhu stejné sady ze stejného dne.
Pokud už v cílové složce existuje neprázdný výstup promptu, workflow ho přeskočí
bez volání modelu. Pro nové vygenerování použijte jiný `suffix`.

## Plánované a ruční běhy

Každý běh používá jeden model. Společná logika je v reusable workflow
`run-agents.yml`; každý plánovaný profil má vlastní malý workflow, který ho volá
s pevnými parametry. Rozvrh používá časovou zónu `Europe/Prague`, včetně
automatického přechodu mezi zimním a letním časem:

| Workflow | Místní čas | Sada | Fáze | Model |
| --- | --- | --- | --- | --- |
| `daily-default.yml` | 04:00 | `default` | `all` | `gemini-3.5-flash-lite` |
| `experimental-research.yml` | 06:00 | `experimental` | `research` | `gemini-3.5-flash-lite` |
| `experimental-synthesis.yml` | 09:00 | `experimental` | `synthesis` | `gemini-4-hydrogen` |

Plánované workflow lze spustit i ručně bez vstupů se stejným profilem
(aktuální datum v UTC, bez suffixu).

GitHub může plánované spuštění zpozdit; samotný rozvrh nezaručuje dokončení
rešerše před syntézou. Syntéza při chybějících nebo prázdných podkladech ihned
selže ještě před voláním modelu, nečeká ani nespouští rešerši.

Libovolnou kombinaci parametrů lze spustit ručně přes workflow `Run Agents`
(`run-agents.yml`). Vstupy `prompt_set`, `phase` a `model` určují sadu,
fázi a model celého běhu. Fáze `all` spouští všechny prompty jako dosud,
`research` pouze rešeršní prompty a `synthesis` pouze prompty se sekcí
`# Vstupní podklady`. Pokud sada zvolenou fázi neobsahuje, běh selže.

Vstup `date` umožňuje zadat rozhodné datum v UTC ve formátu `YYYY-MM-DD`,
například pro pozdější syntézu dříve uložených podkladů. Prázdná hodnota
použije aktuální datum v UTC. Rešerše a syntéza musí používat stejnou sadu,
datum a `suffix`; plánované experimental běhy sdílejí složku
`output/<datum>-experimental/` bez suffixu. Syntetický běh načte podklady
commitované v aktuální větvi repozitáře.

Další plánovaný profil přidáte zkopírováním některého z plánovaných workflow
a úpravou názvu, cronu a hodnot ve `with:`. Volající workflow musí mít
`permissions: contents: write` a `secrets: inherit`.

## Struktura

- `prompts/default/` – monitory pro automatický běh (jeden soubor = jeden monitor)
- `prompts/experimental/` – vícekrokový monitoring spouštěný podle rozvrhu i ručně
- `output/` – výsledky běhů, členěné podle data, sady a případné přípony
- `.github/workflows/run-agents.yml` – společné workflow, které agenty spouští
  (reusable i ruční spuštění)
- `.github/workflows/daily-default.yml`, `experimental-research.yml`,
  `experimental-synthesis.yml` – plánované profily

## Vícekrokový monitoring levice

Sada `experimental` obsahuje čtyři samostatné kroky, spouštěné podle vybrané
fáze v pořadí názvů souborů:

1. `01-levice-cesko.md` – rešerše české scény.
2. `02-levice-evropa.md` – rešerše evropské scény.
3. `03-levice-svet.md` – rešerše mimoevropské scény.
4. `04-levice.md` – syntéza tří podkladů do původního formátu monitoringu,
   bez dalšího vyhledávání na internetu.

Každý krok má vlastní session DSH. Workflow předává promptům cestu k výstupní
složce aktuálního běhu a rozhodné datum v UTC odvozené z jejího názvu.
Všechny tři rešerše tak používají stejné čtyřdenní období včetně tohoto data.
Podklady se ukládají stejně jako výsledný dokument; při selhání pozdějšího kroku
zůstávají zachované a opakovaný běh je při stejné cílové složce přeskočí.
Syntéza čte pouze podklady ze společné výstupní složky zvolené sady, data
a suffixu, nikoli z jiných složek. Workflow před jejím spuštěním vyžaduje
neprázdné výstupy všech rešeršních
promptů vybrané sady. Časový soulad podkladů ověřuje syntetický prompt
a nesoulad má hlásit jako chybu.

## Jak přidat nový monitor

Stačí do složky `prompts/<sada>/` přidat nový `.md` soubor s popisem úkolu.
Workflow ho při dalším běhu odpovídající sady a fáze automaticky zařadí
a spustí. Spouští pouze `.md` soubory přímo ve vybrané složce, nikoli v jejích
podsložkách. Neexistující nebo prázdná sada způsobí chybu běhu.
Prompt musí uložit výstup do kořene repozitáře jako neprázdný soubor se stejným
názvem, jaký má soubor promptu (např. `01-test-pocasi.md`).

Novou sadu vytvořte jako složku pod `prompts/` a přidejte její název do
`workflow_dispatch.inputs.prompt_set.options` v `run-agents.yml`. Název může obsahovat
pouze písmena A-Z a-z, číslice, podtržítko a pomlčku.

## Běh v CI

Workflow běží v kontejneru `ghcr.io/smanx/deepseek-harness` a každý prompt spustí
zvlášť jako `dsh --profile headless "<prompt>"` (sekvenčně, nejvýše 30 minut na monitor).
Nenulový exit kód (úkol neskončil `completed`) shodí běh. Konfigurace DSH se generuje
do `$DSH_HOME/cordis.patch.yml` přímo ve workflow.
Timeout nečinnosti streamu poskytovatele je nastaven pomocí
`llm-pi-ai.providers.google.streamIdleTimeoutMs` na 600 000 ms (10 minut)
místo výchozích 300 000 ms. Jde o čekání na další data streamu, nikoli o celkovou
dobu kroku. Workflow nepřidává nový pokus celého procesu DSH při timeoutu;
pokud proces skončí chybou, běh selže a zachová již dokončené kroky.

Po každém úspěšném promptu se ověří neprázdný výstup a ihned se přesune do cílové
složky. Chybějící nebo prázdný výstup způsobí chybu. Dokončené výsledky se commitují
a pushují i při selhání dalšího promptu; výstup chybujícího promptu se neukládá.
Opakovaný běh načte aktuální stav větve, takže při stejném `OUTPUT_DIR` dokončené
prompty neopakuje. Datum složky se počítá v UTC při spuštění, proto běh v jiný den
použije jinou složku, pokud vstupem `date` není výslovně zadáno původní datum.

Artefakt `dsh-logs` se nahrává i při selhání a obsahuje logy DSH a session
jednotlivých monitorů (`$DSH_HOME/logs`, `$DSH_HOME/sessions`). Mohou obsahovat
citlivý obsah úkolů a souborů; před sdílením je zkontrolujte.

## LLM provider

Provider je Google Gemini přes vestavěnou routu `google` v `llm-pi-ai` (nativní
Gemini protokol; OpenAI-kompatibilní endpoint padal na chybějící `thought_signature`).
Konfigurace routy nesmí uvádět `api` ani `baseURL` (`api: google-generative-ai` shodí
celou skupinu providerů). Vyžaduje secret `GEMINI_API_KEY`.

Výchozí model ručního běhu je `gemini-3.5-flash-lite`; vstupem `model` lze
zvolit také `gemini-3.1-flash-lite`, `gemini-3.8-flash`, `gemini-3-flash-preview`,
`gemini-3.6-flash` nebo `gemini-4-hydrogen`.

Modely `gemini-3-flash-preview`, `gemini-3.6-flash` a `gemini-4-hydrogen` mají
free limity 5 požadavků/min (RPM), 250 000 vstupních tokenů/min (TPM) a 20
požadavků/den (RPD). Limity vynucuje poskytovatel, workflow je samo nehlídá;
`contextWindow` není limit spotřeby za minutu.

Free limity Gemini jsou nízké (např. 15 požadavků/min pro `gemini-3.5-flash-lite`),
proto monitory běží sekvenčně a `retryPolicy` opakuje i `RATE_LIMIT` a `QUOTA`
(DSH tak hlásí Gemini 429 `RESOURCE_EXHAUSTED`) a `SERVER` (503 při přetížení modelu),
nejvýše 8× s backoffem 30, 60, 120, 180, 180, 180, 180, 180 s (~18,5 min).

Starší varianta s providery Groq a Z.ai (vlastní CI runner s presetem `ptc-minimal`)
je zachována ve větvi `multi-provider` a spouští se jen ručně.