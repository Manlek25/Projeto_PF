import axios from "axios";
import * as cheerio from "cheerio";
import ExcelJS from "exceljs";
import { fileURLToPath } from "url";
import path from "path";

axios.defaults.proxy = false;

const BASE_HOST = "consultapublica.duquedecaxias.rj.gov.br";
const BASE_URL = `http://${BASE_HOST}:8004/consultapublica`;

const DEFAULT_HEADERS = {
  Host: BASE_HOST,
  "Content-Type": "application/x-www-form-urlencoded",
  "X-Requested-With": "XMLHttpRequest",
  Origin: `http://${BASE_HOST}:8004`,
  Referer: `${BASE_URL}/index.php?class=ProcProcessoForm`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};

// ============================================================
// 🔍 Busca dados de um processo
// ============================================================
export async function fetchProcessData(numeroProcesso, firstOnly = false, signal = null) {
  try {
    if (!numeroProcesso.includes("/")) {
      numeroProcesso = `${numeroProcesso.substring(0, 3)}/${numeroProcesso.substring(3, 9)}/${numeroProcesso.substring(9)}`;
      console.log("🔢 Corrigido para formato com barras:", numeroProcesso);
    }

    console.log(`📄 Buscando processo: ${numeroProcesso} (firstOnly=${firstOnly})`);

    // Cria sessão
    const sessionResp = await axios.get(`${BASE_URL}/index.php?class=ProcProcessoForm`, {
      headers: DEFAULT_HEADERS,
      timeout: 15000,
      signal,
    });

    const rawCookies = sessionResp.headers["set-cookie"];
    const cookieHeader = rawCookies ? rawCookies.map(c => c.split(";")[0]).join("; ") : "";

    // Envia consulta principal
    const formData = new URLSearchParams();
    formData.append("NUM_PROCESSO", numeroProcesso);
    formData.append("class", "ProcProcessoFormConsultar");
    formData.append("method", "onEdit");

    const searchResp = await axios.post(
      `${BASE_URL}/engine.php?class=ProcProcessoFormConsultar&method=onEdit`,
      formData,
      { headers: { ...DEFAULT_HEADERS, Cookie: cookieHeader }, timeout: 25000, signal }
    );

    const html = searchResp.data || "";
    const $ = cheerio.load(html);

    if ($("table#proc_movimento_PROCESSO_list").length === 0) {
      console.warn(`⚠️ Nenhuma tabela encontrada em ${numeroProcesso}`);
      return null;
    }

    const infoBase = {
      "Número do Processo": numeroProcesso,
      "Data Abertura": $("input[name='DAT_PROCESSO']").val() || "",
      Interessado: $("input[name='NOM_INTERESSADO']").val() || "",
      Requerente: $("input[name='NOM_REQUERENTE']").val() || "",
      Assunto: $("input[name='fk_COD_ASSUNTO_DES_ASSUNTO']").val() || "",
      "Complemento do Assunto": $("input[name='compl_assunto']").val() || "",
      Situação: $("input[name='fk_COD_SITUACAO_DES_SITUACAO']").val() || "",
      Observação: $("textarea[name='OBS_PROCESSO']").text().trim() || "",
    };

    const rows = $("#proc_movimento_PROCESSO_list tbody tr");
    if (rows.length === 0) return [infoBase];

    const resultados = [];

    if (firstOnly) {
      const primeiroTr = rows.last();
      const cols = $(primeiroTr).find("td").map((_, td) => $(td).text().trim()).get();
      resultados.push(formatarMovimento(infoBase, cols));
    } else {
      rows.each((_, tr) => {
        try {
          const cols = $(tr).find("td").map((_, td) => $(td).text().trim()).get();
          resultados.push(formatarMovimento(infoBase, cols));
        } catch (e) {
          console.warn(`⚠️ Erro ao extrair linha em ${numeroProcesso}:`, e.message);
        }
      });
    }

    return resultados;
  } catch (err) {
    // 🟠 Cancelamento manual
    if (axios.isCancel(err) || err.name === "CanceledError" || err.name === "AbortError") {
      console.warn(`🛑 Requisição cancelada: ${numeroProcesso}`);
      return null;
    }

    // 🔴 Erros de conexão com o servidor (inclui timeout do axios)
    const msg = String(err.message || "").toLowerCase();
    const isTimeout =
      err.code === "ECONNABORTED" ||
      msg.includes("timeout") ||
      msg.includes("timed out");

    const isConnection =
      err.code === "ECONNREFUSED" ||
      err.code === "ETIMEDOUT" ||
      err.code === "ENOTFOUND" ||
      msg.includes("connect econnrefused");

    if (isTimeout || isConnection) {
      console.error(`❌ Falha de conexão no processo ${numeroProcesso}:`, err.message);
      return { __error: "CONNECTION_ERROR", numeroProcesso };
    }

    console.error(`❌ Erro no processo ${numeroProcesso}:`, err.message);
    return null;
  }
}

// ============================================================
// 🧩 Função auxiliar para formatação segura
// ============================================================
function formatarMovimento(infoBase, cols) {
  return {
    ...infoBase,
    "Data Envio": cols[1] || "",
    "Secretaria Origem": cols[2] || "",
    "Setor Origem": cols[3] || "",
    "Data Recebimento": cols[4] || "",
    "Secretaria Destino": cols[5] || "",
    "Setor Destino": cols[6] || "",
  };
}

// ============================================================
// ⚙️ Busca em lote otimizada, contínua e com cancelamento
// Estratégia B: 3 falhas seguidas => aborta tudo
// ============================================================
export async function fetchBatchProcesses(
  prefix,
  start = 1,
  end = 1000,
  year,
  onProgress = null,
  firstOnly = false,
  controller = null
) {
  const results = [];
  const CONCURRENCY = 20;
  const active = new Set();

  const signal = controller?.signal || null;

  let doneCount = 0;
  let consecutiveConnErrors = 0;
  const MAX_CONSECUTIVE_CONN_ERRORS = 3;

  const total = end - start + 1;

  const launch = async (i) => {
    if (signal?.aborted) return;

    const numero = `${prefix.padStart(3, "0")}/${i.toString().padStart(6, "0")}/${year}`;

    const p = (async () => {
      const data = await fetchProcessData(numero, firstOnly, signal);

      // Se foi cancelado, só sai
      if (signal?.aborted) return;

      if (data && data.__error === "CONNECTION_ERROR") {
        consecutiveConnErrors++;

        // conta como "tentativa concluída" também
        doneCount++;
        if (onProgress) onProgress(doneCount, total, true);

        // 3 falhas seguidas => consideramos o site fora/instável de verdade
        if (consecutiveConnErrors >= MAX_CONSECUTIVE_CONN_ERRORS) {
          // aborta tudo o que estiver em andamento
          controller?.abort();
          throw new Error("PREFEITURA_OFFLINE");
        }
        return;
      }

      // sucesso/resultado vazio => zera contador de falhas seguidas
      consecutiveConnErrors = 0;

      if (data && data.length > 0) results.push(...data);

      doneCount++;
      if (onProgress) onProgress(doneCount, total, false);
    })();

    active.add(p);
    p.finally(() => active.delete(p));
  };

  for (let i = start; i <= end; i++) {
    if (signal?.aborted) break;

    await launch(i);

    while (active.size >= CONCURRENCY) {
      if (signal?.aborted) break;
      try {
        await Promise.race(active);
      } catch (e) {
        if (e?.message === "PREFEITURA_OFFLINE") {
          throw e;
        }
        // qualquer outro erro, ignora e segue
      }
    }
  }

  // espera o que sobrou (se não abortou)
  try {
    await Promise.allSettled(Array.from(active));
  } catch {
    // ignore
  }

  return results;
}

// ============================================================
// 📊 Exporta resultados para Excel (seguro e sem corrupção)
// ============================================================
export async function exportToExcel(processes, nomeArquivo = "resultados") {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Processos");

  if (!processes || processes.length === 0) {
    sheet.addRow(["Nenhum resultado encontrado"]);
  } else {
    const headers = Object.keys(processes[0]);
    sheet.addRow(headers);

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2E75B6" } };

    processes.forEach(proc => {
      const row = headers.map(h => {
        const val = proc[h];
        if (val === undefined || val === null) return "";
        return typeof val === "string" ? val.trim() : String(val);
      });
      sheet.addRow(row);
    });

    sheet.columns.forEach(col => {
      col.width = Math.min(40, Math.max(12, col.header?.length || 15));
    });
  }

  const fs = await import("fs");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dir = path.join(__dirname, "../exports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const safeName = nomeArquivo.replace(/[\\/]/g, "_");
  const filePath = path.join(dir, `${safeName}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}