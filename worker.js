/*
 * ---------------------------------------------------------------
 * Configuration - FIRST COMMIT GH - 2
 * ---------------------------------------------------------------
 *
 * KRÄVER FÖRBEREDELSER I CLOUDFLARE DASHBOARD:
 *
 * 1. KV BINDINGS (NYTT!):
 * Gå till Settings > Variables > KV Namespace Bindings
 * - Binding 1:
 * - Variable name: ORG_DATA
 * - KV namespace: [Välj ditt ORG_DATA KV]
 * - Binding 2:
 * - Variable name: ORG_CACHE
 * - KV namespace: [Välj ditt ORG_CACHE KV]
 *
 * 2. KV-NYCKEL FÖR ORG-LISTA (SOM FÖRR):
 * I ditt "ORG_DATA" KV, se till att det finns en nyckel "org_list".
 *
 * ---------------------------------------------------------------
 */

// Hur länge datan ska cachas (i sekunder). 3600 = 1 timme.
const CACHE_TTL_SECONDS = 3600;

/*
 * ---------------------------------------------------------------
 * Worker Entrypoint & Router
 * ---------------------------------------------------------------
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  // Kontrollera att bindningarna finns (nu som globala variabler)
  if (typeof ORG_DATA === 'undefined' || typeof ORG_CACHE === 'undefined') {
    return new Response(
      'Konfigurationsfel: "ORG_DATA" eller "ORG_CACHE" KV-bindningen saknas. Gå till Settings > Variables för att lägga till dem.',
      { status: 500, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  const request = event.request;
  const url = new URL(request.url);

  // Enkel router
  if (url.pathname === '/') {
    return handleGui(event);
  }
  if (url.pathname === '/data.json') {
    return handleDataJson(event, url.searchParams.has('refresh'));
  }
  if (url.pathname === '/org-via-ombud.json') {
    return handleOrgJson(event, url.searchParams.has('refresh'));
  }
  if (url.pathname === '/export.csv') {
    return handleCsvExport(event, url.searchParams.has('refresh'));
  }

  return new Response('Not Found', { status: 404 });
}

/*
 * ---------------------------------------------------------------
 * Route Handlers
 * ---------------------------------------------------------------
 */

/**
 * Serverar huvudsidan (GUI).
 */
async function handleGui(event) {
  const html = generateHtmlPage();
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Serverar den aggregerade datan som JSON.
 * Används av frontend-JS för att bygga tabellen.
 */
async function handleDataJson(event, forceRefresh) {
  try {
    const data = await getAggregatedData(event, forceRefresh);
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get aggregated data:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

/**
 * Serverar den enkla listan med organisationsnamn.
 */
async function handleOrgJson(event, forceRefresh) {
  try {
    const aggregatedData = await getAggregatedData(event, forceRefresh);
    // Extrahera bara namnen
    const orgNames = aggregatedData
      .map(item => item.namn)
      .filter(name => name && name !== 'N/A'); // Filtrera bort eventuella tomma

    return new Response(JSON.stringify(orgNames), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get org names json:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

/**
 * Genererar och serverar en CSV-export.
 */
async function handleCsvExport(event, forceRefresh) {
  try {
    const aggregatedData = await getAggregatedData(event, forceRefresh);
    const csv = jsonToCsv(aggregatedData);
    
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="export.csv"',
      },
    });
  } catch (error) {
    console.error('Failed to generate CSV:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

/*
 * ---------------------------------------------------------------
 * Core Data Fetching & Caching Logic
 * ---------------------------------------------------------------
 */

/**
 * Hämtar den kombinerade datan.
 * Använder Cloudflares Cache API för att undvika att bygga om datan vid varje anrop.
 */
async function getAggregatedData(event, forceRefresh = false) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(event.request.url).origin + '/data.json');

  let response;

  if (!forceRefresh) {
    response = await cache.match(cacheKey);
  }

  if (response) {
    console.log('Cache HIT');
    return response.json();
  }

  console.log('Cache MISS or refresh forced. Rebuilding data...');
  
  // Bygg datan från grunden
  const data = await buildAggregatedData();

  // Skapa ett nytt Response-objekt för att lagra i cachen
  response = new Response(JSON.stringify(data), {
    headers: { 
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`
    },
  });

  // Använd event.waitUntil för att cacha i bakgrunden utan att blockera svaret
  event.waitUntil(cache.put(cacheKey, response.clone()));

  return data;
}


/**
 * ------------------------------------------
 * KORRIGERING (v13): Använder direkta KV-anrop.
 * Ingen batching behövs, kv.get() räknas inte som subrequests.
 * ------------------------------------------
 */
async function buildAggregatedData() {
  // Steg 1: Hämta listan över alla nycklar (organisationsnummer)
  let keysList;
  try {
    // Anropar ORG_DATA-bindningen direkt
    const keysText = await ORG_DATA.get("org_list");
    
    if (keysText === null) {
      throw new Error(`Kunde inte hitta nyckeln 'org_list' i ORG_DATA.`);
    }
    
    try {
        keysList = JSON.parse(keysText); 
    } catch (e) {
        console.error(`!!! FAILED TO PARSE org_list. Text was: ${keysText.substring(0, 150)}...`);
        throw new Error(`Failed to parse org_list: ${e.message}`);
    }

    if (!Array.isArray(keysList)) {
        throw new Error("Datan från 'org_list' är inte en JSON-array.");
    }

  } catch (err) {
    console.error(err);
    throw new Error(`Kunde inte hämta eller tolka 'org_list'. Detaljer: ${err.message}`);
  }

  if (!keysList || keysList.length === 0) {
    console.warn("Inga nycklar hittades från 'org_list'.");
    return [];
  }

  // Steg 2: Kör alla 77+ anrop parallellt.
  // Detta är nu OK eftersom kv.get() inte har 50-gränsen.
  console.log(`Processing ${keysList.length} keys in parallel...`);
  
  const allPromises = keysList.map(key => fetchDataForKey(key));
  const allResults = await Promise.allSettled(allPromises);

  const aggregatedData = [];
  allResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
        if (result.value) {
            aggregatedData.push(result.value);
        }
    } else if (result.status === 'rejected') {
      console.error(`Unhandled rejection for key ${keysList[index]}:`, result.reason);
    }
  });

  console.log(`Finished processing. Total aggregated rows: ${aggregatedData.length}`);
  return aggregatedData;
}


/**
 * ------------------------------------------
 * KORRIGERING (v13): Använder direkta KV-anrop (env.KV_BINDING.get)
 * ------------------------------------------
 */
async function fetchDataForKey(orgNr) {
  
  // Sätt standardvärden
  let ombud = 'N/A';
  let tillagd = 'N/A';
  let namn = 'N/A';
  let form = 'N/A';
  let postort = 'N/A';
  
  try {
    // --- Steg 1: Hämta data från ORG_DATA (Ombud) ---
    try {
      // Anropar ORG_DATA-bindningen direkt
      const data1Text = await ORG_DATA.get(orgNr); 
      
      if (data1Text !== null) {
        try {
          const data1 = JSON.parse(data1Text); // Försök konvertera
          ombud = data1?.organizationDisplayName || 'N/A';
          if (data1?.firstSeen) {
            tillagd = new Date(data1.firstSeen).toISOString().split('T')[0];
          }
        } catch (e) {
          console.error(`!!! FAILED TO PARSE ORG_DATA for ${orgNr}: ${e.message}. Text was: ${data1Text.substring(0, 150)}...`);
        }
      } else {
         console.warn(`Key ${orgNr} not found in ORG_DATA.`);
      }
    } catch (err) {
      console.error(`CRITICAL: KV.get failed for ORG_DATA ${orgNr}:`, err);
    }

    // --- Steg 2: Hämta data från ORG_CACHE (Bolagsverket) ---
    try {
      // Anropar ORG_CACHE-bindningen direkt
      const data2Text = await ORG_CACHE.get(orgNr);
      
      if (data2Text !== null) {
        try {
          const data2 = JSON.parse(data2Text); // Försök konvertera
          const orgInfo = data2?.data?.organisationer?.[0]; // Hämta första organisationen

          if (orgInfo) {
            namn = orgInfo.organisationsnamn?.organisationsnamnLista?.[0]?.namn || data2?.name || 'N/A';
            form = orgInfo.juridiskForm?.klartext || data2?.form || 'N/S';
            postort = orgInfo.postadressOrganisation?.postadress?.postort || data2?.postort || 'N/A';
          } else {
              namn = data2?.name || 'N/A';
              form = data2?.form || 'N/A';
              postort = data2?.postort || 'N/A';
          }
        } catch (e) {
          console.error(`!!! FAILED TO PARSE ORG_CACHE for ${orgNr}: ${e.message}. Text was: ${data2Text.substring(0, 150)}...`);
        }
      } else {
        console.warn(`Key ${orgNr} not found in ORG_CACHE.`);
      }
    } catch (err) {
      console.error(`CRITICAL: KV.get failed for ORG_CACHE ${orgNr}:`, err);
    }

    // --- Steg 3: Returnera det sammanslagna objektet ---
    return {
      orgNr,
      namn,
      form,
      postort,
      ombud,
      tillagd,
    };
    
  } catch (error) {
    // Denna yttre try/catch är ett skyddsnät för helt oväntade fel.
    console.error(`FATAL Error in fetchDataForKey for ${orgNr}:`, error);
    return null; // Returnera null så att Promise.allSettled kan filtrera bort den
  }
}


/*
 * ---------------------------------------------------------------
 * CSV Export Utility
 * ---------------------------------------------------------------
 */

function jsonToCsv(jsonData) {
  if (!jsonData || jsonData.length === 0) {
    return '';
  }
  const headers = Object.keys(jsonData[0]);
  const delimiter = ';';
  const headerRow = headers.join(delimiter);
  const rows = jsonData.map(row => {
    return headers.map(header => {
      let cell = row[header] === null || row[header] === undefined ? '' : String(row[header]);
      if (cell.includes(delimiter) || cell.includes('"') || cell.includes('\n')) {
        cell = cell.replace(/"/g, '""');
        cell = '"' + cell + '"';
      }
      return cell;
    }).join(delimiter);
  });
  const BOM = '\uFEFF';
  return BOM + headerRow + '\n' + rows.join('\n');
}

/*
 * ---------------------------------------------------------------
 * HTML, CSS & Client-side JS Template
 * ---------------------------------------------------------------
 */

/*
 * ---------------------------------------------------------------
 * HTML, CSS & Client-side JS Template
 * ---------------------------------------------------------------
 */

function generateHtmlPage() {
  return `
<!DOCTYPE html>
<html lang="sv">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Organisationsöversikt</title>
    
    <script>
        // Omedelbar skript för att förhindra "flash" av fel tema
        (function() {
            try {
                const theme = localStorage.getItem('theme');
                if (theme) {
                    document.documentElement.setAttribute('data-theme', theme);
                } else {
                    const mql = window.matchMedia('(prefers-color-scheme: dark)');
                    if (mql.matches) {
                        document.documentElement.setAttribute('data-theme', 'dark');
                    }
                }
            } catch (e) {
                // localStorage kan misslyckas i t.ex. privat läge
            }
        })();
    </script>

    <style>
        :root {
            --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
            --font-color: #222;
            --font-color-muted: #555;
            --bg-color: #f8f9fa;
            --bg-color-container: #ffffff;
            --bg-color-header: #f1f3f5;
            --bg-color-hover: #f1f3f5;
            --primary-color: #007aff;
            --primary-color-hover: #0056b3;
            --border-color: #dee2e6;
            --shadow-color: rgba(0, 0, 0, 0.05);
            --border-radius: 8px;
            --transition: all 0.2s ease-in-out;
        }

        [data-theme="dark"] {
            --font-color: #e9ecef;
            --font-color-muted: #adb5bd;
            --bg-color: #121212;
            --bg-color-container: #1e1e1e;
            --bg-color-header: #2c2c2c;
            --bg-color-hover: #343a40;
            --primary-color: #0d6efd;
            --primary-color-hover: #3b8bff;
            --border-color: #495057;
            --shadow-color: rgba(0, 0, 0, 0.2);
        }

        body {
            font-family: var(--font-family);
            margin: 0;
            padding: 24px;
            background-color: var(--bg-color);
            color: var(--font-color);
            line-height: 1.6;
            transition: var(--transition);
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: var(--bg-color-container);
            padding: 24px;
            border-radius: var(--border-radius);
            box-shadow: 0 4px 12px var(--shadow-color);
            position: relative;
        }
        
        /* Tema-knapp */
        #theme-toggle {
            position: absolute;
            top: 24px;
            right: 24px;
            background: none;
            border: 1px solid var(--border-color);
            color: var(--font-color-muted);
            width: 40px;
            height: 40px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 1.2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: var(--transition);
        }
        #theme-toggle:hover {
            background: var(--bg-color-hover);
            color: var(--font-color);
        }
        
        /* Huvudrubrik */
        h1 {
            margin-top: 0;
            padding-right: 40px; /* Utrymme för tema-knappen */
        }

        /* Ny Statistik-header */
        .stats-header {
            background: var(--bg-color-header);
            border: 1px solid var(--border-color);
            border-radius: var(--border-radius);
            padding: 24px;
            margin-bottom: 24px;
        }
        .stats-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
        }
        .stat-box {
            background: var(--bg-color-container);
            padding: 20px;
            border-radius: var(--border-radius);
            text-align: center;
            box-shadow: 0 2px 4px var(--shadow-color);
        }
        .stat-box h3 {
            margin: 0 0 8px 0;
            font-size: 1.8rem;
            color: var(--primary-color);
        }
        .stat-box p {
            margin: 0;
            font-size: 0.9rem;
            color: var(--font-color-muted);
        }
        
        /* Ombud-sektion (flyttad) */
        .ombud-toggle {
            display: block;
            width: 100%;
            text-align: left;
            padding: 16px 0 8px 0;
            margin-top: 24px;
            border-top: 1px solid var(--border-color);
            font-size: 1rem;
            font-weight: 600;
            color: var(--font-color);
            background: none;
            border-bottom: none;
            border-left: none;
            border-right: none;
            cursor: pointer;
        }
        .ombud-toggle:hover {
            color: var(--primary-color);
        }
        .ombud-toggle .arrow {
            display: inline-block;
            margin-right: 8px;
            transition: transform 0.2s;
        }
        .ombud-toggle.open .arrow {
            transform: rotate(90deg);
        }
        #stats-per-ombud-wrapper {
            display: none;
            padding-top: 16px;
        }
        #stats-per-ombud-wrapper h2 { display: none; } /* Dölj onödig rubrik */

        /* Knappar & Actions */
        .actions-bar {
            display: flex;
            gap: 12px;
            margin-bottom: 24px;
            flex-wrap: wrap;
        }
        .btn, button {
            font-family: var(--font-family);
            background-color: var(--primary-color);
            color: white;
            padding: 10px 16px;
            border: none;
            border-radius: var(--border-radius);
            cursor: pointer;
            text-decoration: none;
            font-size: 0.9rem;
            font-weight: 500;
            transition: var(--transition);
            display: inline-block;
        }
        .btn:hover, button:hover {
            background-color: var(--primary-color-hover);
            transform: translateY(-1px);
        }
        .btn.secondary {
            background-color: #6c757d;
            color: white;
        }
        .btn.secondary:hover {
            background-color: #5a6268;
        }
        .btn.outline {
            background-color: transparent;
            color: var(--primary-color);
            border: 1px solid var(--primary-color);
        }
        .btn.outline:hover {
            background-color: var(--primary-color);
            color: var(--bg-color-container);
        }
        
        #loader {
            font-size: 1.2rem;
            text-align: center;
            padding: 40px;
            color: var(--font-color-muted);
        }
        
        /* Tabell-styling */
        .table-wrapper {
            overflow-x: auto;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 16px;
        }
        th, td {
            padding: 14px 16px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }
        th {
            background-color: var(--bg-color-header);
            font-weight: 600;
            cursor: pointer;
            position: relative;
        }
        th .sort-icon {
            display: inline-block;
            margin-left: 8px;
            opacity: 0.5;
            font-size: 0.8em;
            transition: var(--transition);
        }
        th.sorted .sort-icon {
            opacity: 1;
            color: var(--primary-color);
        }
        tbody tr:hover {
            background-color: var(--bg-color-hover);
        }
        td a {
            color: var(--primary-color);
            text-decoration: none;
            font-weight: 500;
        }
        td a:hover {
            text-decoration: underline;
        }
        
        /* Paginering */
        #pagination-controls {
            display: flex;
            justify-content: center;
            align-items: center;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 24px;
        }
        #pagination-controls button {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--font-color-muted);
            min-width: 40px;
            height: 40px;
            padding: 0 10px;
            border-radius: var(--border-radius);
            cursor: pointer;
            transition: var(--transition);
        }
        #pagination-controls button:hover {
            background: var(--bg-color-hover);
            color: var(--font-color);
            transform: none;
        }
        #pagination-controls button.active {
            background: var(--primary-color);
            color: white;
            border-color: var(--primary-color);
        }
        #pagination-controls button.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #pagination-controls .ellipsis {
            padding: 0 10px;
            color: var(--font-color-muted);
        }
        
        /* Sidfot */
        footer {
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid var(--border-color);
            text-align: center;
            font-size: 0.85rem;
            color: var(--font-color-muted);
        }
    </style>
</head>
<body>

    <div class="container">
        <button id="theme-toggle" title="Växla tema">🌓</button>
        <h1>Organisationsöversikt</h1>

        <header class="stats-header">
            <div class="stats-container">
                <div class="stat-box">
                    <h3 id="stat-total-orgs">-</h3>
                    <p>Antal organisationer</p>
                </div>
                <div class="stat-box">
                    <h3 id="stat-total-ombud">-</h3>
                    <p>Antal ombud</p>
                </div>
            </div>
            
            <button class="ombud-toggle" id="btn-toggle-ombud-stats">
                <span class="arrow">►</span>
                Visa organisationer per ombud
            </button>
            <div id="stats-per-ombud-wrapper">
                <h2>Organisationer per ombud</h2>
                <div class="table-wrapper">
                    <table id="ombud-stats-table">
                        <thead>
                            <tr>
                                <th data-sort="ombudName">Ombud</th>
                                <th data-sort="count">Antal organisationer</th>
                            </tr>
                        </thead>
                        <tbody id="ombud-stats-body">
                            </tbody>
                    </table>
                </div>
            </div>
        </header>

        <div class="actions-bar">
            <a href="/export.csv" class="btn secondary" id="btn-export-csv">Exportera CSV</a>
            <a href="/org-via-ombud.json" target="_blank" class="btn outline">Visa JSON (Endast namn)</a>
            <a href="/?refresh=true" class="btn outline">Uppdatera data (rensa cache)</a>
        </div>

        <div id="loader">Laddar data...</div>

        <div class="table-wrapper" id="main-table-wrapper" style="display: none;">
            <table id="main-table">
                <thead>
                    <tr>
                        <th data-sort="orgNr">Organisationsnummer <span class="sort-icon"></span></th>
                        <th data-sort="namn">Namn <span class="sort-icon"></span></th>
                        <th data-sort="form">Form <span class="sort-icon"></span></th>
                        <th data-sort="postort">Postort <span class="sort-icon"></span></th>
                        <th data-sort="ombud">Ombud <span class="sort-icon"></span></th>
                        <th data-sort="tillagd">Tillagd <span class="sort-icon"></span></th>
                    </tr>
                </thead>
                <tbody id="main-table-body">
                    </tbody>
            </table>
        </div>
        
        <div id="pagination-controls"></div>
        
        <footer>
            <p>Organisationsuppgifter från bolagsverkets API Värdefulla datamängder</p>
        </footer>

    </div>

    <script>
        // Globalt state
        let allData = [];
        let mainTableSort = { column: 'namn', order: 'asc' };
        
        // Paginering state
        let currentPage = 1;
        const rowsPerPage = 100;

        // Körs när sidan laddats
        document.addEventListener('DOMContentLoaded', () => {
            initApp();
            addEventListeners();
            setupThemeToggle(); // Sätt upp tema-knappen
        });

        /**
         * Hämta data och initiera appen
         */
        async function initApp() {
            try {
                const response = await fetch('/data.json');
                if (!response.ok) {
                    throw new Error('Kunde inte hämta data: ' + response.statusText);
                }
                allData = await response.json();

                if (allData.error) {
                  throw new Error(allData.error);
                }

                // Dölj laddare och visa tabell
                document.getElementById('loader').style.display = 'none';
                document.getElementById('main-table-wrapper').style.display = 'block';

                // Sortera datan från start
                sortData();
                
                // Uppdatera GUI
                updateStats();
                buildStatsTable();
                
                // Initiera paginering och visa första sidan
                setupPagination();
                displayPage(currentPage);

            } catch (error) {
                console.error('Fel vid initiering:', error);
                document.getElementById('loader').innerHTML =
                    '<p style="color: red;"><strong>Fel:</strong> Kunde inte ladda data.</p>' +
                    '<p>Orsak: ' + error.message + '</p>' +
                    '<p>Kontrollera att dina KV-bindningar "ORG_DATA" och "ORG_CACHE" är korrekt inställda.</p>' +
                    '<p>Testa att <a href="/?refresh=true">tvinga en uppdatering</a>.</p>';
            }
        }
        
        /**
         * Sätt upp alla klick-lyssnare
         */
        function addEventListeners() {
            // Sortering för huvudtabellen
            document.querySelectorAll('#main-table th[data-sort]').forEach(th => {
                th.addEventListener('click', () => {
                    const column = th.dataset.sort;
                    if (mainTableSort.column === column) {
                        mainTableSort.order = mainTableSort.order === 'asc' ? 'desc' : 'asc';
                    } else {
                        mainTableSort.column = column;
                        mainTableSort.order = 'asc';
                    }
                    
                    // Sortera om all data
                    sortData();
                    
                    // Visa om den nuvarande sidan
                    displayPage(currentPage);
                });
            });
            
            // Knapp för att visa/dölja ombudsstatistik
            document.getElementById('btn-toggle-ombud-stats').addEventListener('click', (e) => {
                const wrapper = document.getElementById('stats-per-ombud-wrapper');
                const btn = e.currentTarget; // Använd currentTarget
                
                if (wrapper.style.display === 'none' || wrapper.style.display === '') {
                    wrapper.style.display = 'block';
                    btn.classList.add('open');
                    btn.innerHTML = '<span class="arrow">▼</span> Dölj organisationer per ombud';
                } else {
                    wrapper.style.display = 'none';
                    btn.classList.remove('open');
                    btn.innerHTML = '<span class="arrow">►</span> Visa organisationer per ombud';
                }
            });
        }
        
        /**
         * Sorterar den globala 'allData'-arrayen baserat på 'mainTableSort'
         */
        function sortData() {
            const { column, order } = mainTableSort;
            
            allData.sort((a, b) => {
                let valA = a[column];
                let valB = b[column];
                
                // Smart sortering (hanterar siffror/text)
                return valA.localeCompare(valB, 'sv', { numeric: true, sensitivity: 'base' });
            });

            if (order === 'desc') {
                allData.reverse();
            }
            
            // Uppdatera ikoner för sorteringshuvuden
            document.querySelectorAll('#main-table th[data-sort]').forEach(th => {
                th.classList.remove('sorted', 'asc', 'desc');
                th.querySelector('.sort-icon').textContent = '';
                if (th.dataset.sort === column) {
                    th.classList.add('sorted', order);
                    th.querySelector('.sort-icon').textContent = order === 'asc' ? '▲' : '▼';
                }
            });
        }
        
        /**
         * Visar en specifik sida från den (redan sorterade) 'allData'
         */
        function displayPage(page) {
            currentPage = page;
            const startIndex = (page - 1) * rowsPerPage;
            const endIndex = startIndex + rowsPerPage;
            
            const pageData = allData.slice(startIndex, endIndex);
            renderMainTable(pageData);
            
            // Uppdatera pagineringsknapparnas "active" state
            const paginationControls = document.getElementById('pagination-controls');
            paginationControls.querySelectorAll('button').forEach(btn => {
                btn.classList.remove('active');
                if (parseInt(btn.dataset.page) === currentPage) {
                    btn.classList.add('active');
                }
            });
            
            // Uppdatera "Prev" och "Next" knapparnas disabled-status
            const totalPages = Math.ceil(allData.length / rowsPerPage);
            paginationControls.querySelector('button[data-page="prev"]').disabled = (currentPage === 1);
            paginationControls.querySelector('button[data-page="next"]').disabled = (currentPage === totalPages);
        }
        
        /**
         * Bygger pagineringskontrollerna
         */
        function setupPagination() {
            const paginationControls = document.getElementById('pagination-controls');
            paginationControls.innerHTML = ''; // Rensa
            const totalPages = Math.ceil(allData.length / rowsPerPage);
            
            if (totalPages <= 1) return; // Behövs inte om det bara är en sida
            
            // "Prev"-knapp
            const prevBtn = document.createElement('button');
            prevBtn.dataset.page = "prev";
            prevBtn.innerHTML = "&laquo; Föregående";
            prevBtn.addEventListener('click', () => {
                if (currentPage > 1) displayPage(currentPage - 1);
            });
            paginationControls.appendChild(prevBtn);
            
            // Sidknappar (smart logik)
            buildPaginationButtons(paginationControls, totalPages, currentPage);

            // "Next"-knapp
            const nextBtn = document.createElement('button');
            nextBtn.dataset.page = "next";
            nextBtn.innerHTML = "Nästa &raquo;";
            nextBtn.addEventListener('click', () => {
                if (currentPage < totalPages) displayPage(currentPage + 1);
            });
            paginationControls.appendChild(nextBtn);
        }
        
        /**
         * Hjälpfunktion för att bygga de klickbara sidnumren (1, 2, ... 5, 6, 7, ... 99, 100)
         */
        function buildPaginationButtons(container, totalPages, currentPage) {
            const createButton = (page) => {
                const btn = document.createElement('button');
                btn.dataset.page = page;
                btn.textContent = page;
                btn.addEventListener('click', () => displayPage(page));
                return btn;
            };
            
            const createEllipsis = () => {
                const span = document.createElement('span');
                span.className = 'ellipsis';
                span.textContent = '...';
                return span;
            };

            const maxButtons = 7; // Max antal knappar att visa
            
            if (totalPages <= maxButtons) {
                // Visa alla sidor
                for (let i = 1; i <= totalPages; i++) {
                    container.appendChild(createButton(i));
                }
            } else {
                // Visa smart paginering
                let start = Math.max(1, currentPage - 2);
                let end = Math.min(totalPages, currentPage + 2);

                if (currentPage < 4) {
                    end = 5;
                }
                if (currentPage > totalPages - 3) {
                    start = totalPages - 4;
                }
                
                // Första sidan + ellipsis
                if (start > 1) {
                    container.appendChild(createButton(1));
                    if (start > 2) {
                        container.appendChild(createEllipsis());
                    }
                }
                
                // Mitten-sidor
                for (let i = start; i <= end; i++) {
                    container.appendChild(createButton(i));
                }
                
                // Sista sidan + ellipsis
                if (end < totalPages) {
                    if (end < totalPages - 1) {
                        container.appendChild(createEllipsis());
                    }
                    container.appendChild(createButton(totalPages));
                }
            }
        }

        /**
         * Uppdatera de övergripande statistikkortena
         */
        function updateStats() {
            const ombudSet = new Set(allData.map(item => item.ombud).filter(o => o !== 'N/A'));
            
            document.getElementById('stat-total-orgs').textContent = allData.length;
            document.getElementById('stat-total-ombud').textContent = ombudSet.size;
        }

        /**
         * Rendera raderna i huvudtabellen
         */
        function renderMainTable(data) {
            const tableBody = document.getElementById('main-table-body');
            tableBody.innerHTML = ''; // Rensa
            
            if (data.length === 0) {
                 tableBody.innerHTML = '<tr><td colspan="6">Inga data hittades för denna sida.</td></tr>';
                 return;
            }

            const rows = data.map(item => {
                const allabolagUrl = 'https://www.allabolag.se/bransch-s%C3%B6k?q=' + encodeURIComponent(item.orgNr);
                return '<tr>' +
                        '<td><a href="' + allabolagUrl + '" target="_blank">' + item.orgNr + '</a></td>' +
                        '<td>' + escapeHTML(item.namn) + '</td>' +
                        '<td>' + escapeHTML(item.form) + '</td>' +
                        '<td>' + escapeHTML(item.postort) + '</td>' +
                        '<td>' + escapeHTML(item.ombud) + '</td>' +
                        '<td>' + escapeHTML(item.tillagd) + '</td>' +
                       '</tr>';
            });
            
            tableBody.innerHTML = rows.join('');
        }

        /**
         * Bygg och rendera den dolda statistatabellen för ombud
         */
        function buildStatsTable() {
            const stats = {};
            allData.forEach(item => {
                if (item.ombud && item.ombud !== 'N/A') {
                    stats[item.ombud] = (stats[item.ombud] || 0) + 1;
                }
            });
            
            // Konvertera till array för sortering
            const statsArray = Object.entries(stats).map(([ombudName, count]) => ({ ombudName, count }));
            
            // Sortera (efter namn som standard)
            statsArray.sort((a, b) => a.ombudName.localeCompare(b.ombudName, 'sv'));

            const tableBody = document.getElementById('ombud-stats-body');
            tableBody.innerHTML = ''; // Rensa
            
            const rows = statsArray.map(item => {
                return \` 
                    <tr>
                        <td>\${escapeHTML(item.ombudName)}</td>
                        <td>\${item.count}</td>
                    </tr>
                \`;
            });
            
            tableBody.innerHTML = rows.join('');
        }
        
        /**
         * Tema-växlare
         */
        function setupThemeToggle() {
            const toggleButton = document.getElementById('theme-toggle');
            toggleButton.addEventListener('click', () => {
                const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
                const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
            });
        }
        
        /**
         * Enkel HTML-escap
         */
        function escapeHTML(str) {
            if (typeof str !== 'string') return str;
            return str.replace(/[&<>"']/g, (match) => {
                return {
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;'
                }[match];
            });
        }

    </script>
</body>
</html>
  `; 
}
