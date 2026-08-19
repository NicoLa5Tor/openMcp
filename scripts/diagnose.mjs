#!/usr/bin/env node
// Script de diagnóstico: prueba cada endpoint de OpenProject contra tu
// instancia real y muestra la respuesta CRUDA + lo que el cliente parsea.
//
// Uso (PowerShell):
//   $env:OPENPROJECT_URL="https://tu-openproject"; $env:OPENPROJECT_API_KEY="tu_key"; node scripts/diagnose.mjs
//
// Uso (bash):
//   OPENPROJECT_URL=... OPENPROJECT_API_KEY=... node scripts/diagnose.mjs
//
// No imprime tu API key. Puedes pegar toda la salida sin problema.

const URL = (process.env.OPENPROJECT_URL || "").replace(/\/+$/, "");
const KEY = process.env.OPENPROJECT_API_KEY || "";

if (!URL || !KEY) {
  console.error("Falta OPENPROJECT_URL o OPENPROJECT_API_KEY en el entorno.");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`apikey:${KEY}`).toString("base64");

function trunc(s, n = 1500) {
  if (typeof s !== "string") s = JSON.stringify(s, null, 2);
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} chars más]` : s;
}

async function probe(label, path) {
  const full = `${URL}${path}`;
  console.log("\n" + "=".repeat(70));
  console.log(`▶ ${label}`);
  console.log(`  GET ${path}`);
  try {
    const res = await fetch(full, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    console.log(`  HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log("  (respuesta no-JSON)");
      console.log(trunc(text, 500));
      return null;
    }
    // Resumen útil según el shape
    if (parsed?._embedded?.elements) {
      const els = parsed._embedded.elements;
      console.log(`  Colección: total=${parsed.total}, count=${parsed.count}, en esta página=${els.length}`);
      console.log("  Primeros 3 elementos (campos clave):");
      for (const el of els.slice(0, 3)) {
        console.log(
          "   -",
          JSON.stringify({
            id: el.id,
            name: el.name,
            subject: el.subject,
            _type: el._type,
          }),
        );
      }
    }
    console.log("  --- JSON crudo (truncado) ---");
    console.log(trunc(parsed));
    return parsed;
  } catch (err) {
    console.log(`  ERROR de red: ${err.message}`);
    return null;
  }
}

console.log(`OpenProject: ${URL}`);
console.log("Probando endpoints uno por uno…");

// 1. Proyectos
await probe("get_projects", "/api/v3/projects?pageSize=5");

// 2. Work packages (global)
await probe("get_work_packages (global)", "/api/v3/work_packages?pageSize=3");

// 3. Actividades — probamos VARIAS rutas candidatas para ver cuál sirve
await probe("actividades vía colección (esperado 404)", "/api/v3/time_entries/activities");
const schema = await probe("actividades vía schema de time_entries", "/api/v3/time_entries/schema");

// Si el schema respondió, mostramos exactamente dónde están las actividades
if (schema) {
  console.log("\n" + "-".repeat(70));
  console.log("🔎 Inspección del campo 'activity' en el schema:");
  const activity = schema.activity;
  console.log("  activity presente:", !!activity);
  if (activity) {
    console.log("  activity._links.allowedValues presente:", !!activity?._links?.allowedValues);
    console.log("  activity._embedded.allowedValues presente:", !!activity?._embedded?.allowedValues);
    const av = activity?._links?.allowedValues || activity?._embedded?.allowedValues;
    if (Array.isArray(av)) {
      console.log(`  allowedValues tiene ${av.length} entradas. Primeras 5:`);
      for (const v of av.slice(0, 5)) {
        console.log("   -", JSON.stringify({ href: v.href, title: v.title, id: v.id, name: v.name }));
      }
    } else {
      console.log("  ⚠ allowedValues no es un array. Volcado del campo activity:");
      console.log(trunc(activity, 1200));
    }
  }
}

// 4. Time entries existentes
await probe("get_time_entries", "/api/v3/time_entries?pageSize=3");

console.log("\n" + "=".repeat(70));
console.log("Diagnóstico terminado. Pega TODA esta salida.");
