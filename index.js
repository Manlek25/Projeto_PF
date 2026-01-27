import express from "express";
import { fetchProcessData, fetchBatchProcesses, exportToExcel } from "./services/processService.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import axios from "axios";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 📁 Frontend dentro do backend
const FRONTEND_DIR = path.join(__dirname, "frontend");
const indexPath = path.join(FRONTEND_DIR, "index.html");

console.log("🧩 Servindo frontend de:", FRONTEND_DIR);
console.log("📄 index.html encontrado?", fs.existsSync(indexPath));

app.use(express.json({ limit: "200kb" }));
app.use(express.static(FRONTEND_DIR));
app.use("/exports", express.static(path.join(__dirname, "exports")));

app.get("/api/health/prefeitura", async (_req, res) => {
  const BASE_HOST = "consultapublica.duquedecaxias.rj.gov.br";
  const BASE_URL = `http://${BASE_HOST}:8004/consultapublica`;

  try {
    // teste rápido e leve (não consulta processo nenhum)
    await axios.get(`${BASE_URL}/index.php?class=ProcProcessoForm`, {
      timeout: 6000,
      proxy: false,
      headers: {
        Host: BASE_HOST,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      },
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.json({
      ok: false,
      reason: e.code || "OFFLINE",
    });
  }
});

// ============================================================
// ✅ Busca única
// ============================================================
app.get("/api/process", async (req, res) => {
  try {
    const { numero, firstOnly } = req.query;
    if (!numero) return res.status(400).json({ error: "Informe o número do processo." });

    console.log(`🔍 Buscando processo único: ${numero} (firstOnly=${firstOnly === "true"})`);
    const processData = await fetchProcessData(numero, firstOnly === "true");

    if (processData && processData.__error === "CONNECTION_ERROR") {
      return res.status(503).json({
        error: "Não foi possível conectar ao site da Prefeitura agora. Tente novamente em alguns minutos.",
      });
    }

    if (!processData) return res.status(404).json({ error: "Não encontrei dados para esse processo." });

    const filePath = await exportToExcel(processData, numero);
    const relativePath = `/exports/${path.basename(filePath)}`;
    console.log(`✅ Exportado: ${filePath}`);

    res.json({ success: true, file: relativePath });
  } catch (err) {
    console.error("❌ Erro em /api/process:", err.message);
    res.status(500).json({ error: "Ocorreu um erro ao processar a consulta." });
  }
});

// ============================================================
// ✅ Busca em lote com progresso + cancelamento
// Estratégia B: 3 falhas seguidas => finaliza
// ============================================================
const activeControllers = new Map();

app.get("/api/process/batch", async (req, res) => {
  const { prefix, start, end, year, setores, firstOnly } = req.query;
  if (!prefix || !year) {
    return res.status(400).json({ error: "Informe prefixo e ano." });
  }

  const setoresFiltro = setores ? setores.split(",").map(s => s.trim().toLowerCase()) : [];
  const onlyFirst = firstOnly === "true";

  const reqId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const controller = new AbortController();
  activeControllers.set(reqId, controller);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  req.on("close", () => {
    controller.abort();
    activeControllers.delete(reqId);
    clearInterval(keepAlive);
    console.log(`❌ Cliente desconectado /batch (${reqId})`);
  });

  try {
    console.log(`🚀 Iniciando lote: ${prefix} (${start || 1}-${end || 1000})/${year}`);

    const processos = await fetchBatchProcesses(
      prefix,
      Number(start) || 1,
      Number(end) || 1000,
      year,
      (done, total, connectionError = false) => {
        if (connectionError) {
          send("warn", {
            warning: "O site da Prefeitura está demorando para responder. Tentando novamente…",
          });
        } else {
          send("progress", { percent: Math.round((done / total) * 100) });
        }
      },
      onlyFirst,
      controller
    );

    const filtrados = setoresFiltro.length
      ? processos.filter(p => setoresFiltro.includes(p["Setor Origem"]?.toLowerCase()))
      : processos;

    if (!filtrados || filtrados.length === 0) {
      send("done", { error: "Não encontrei resultados nessa faixa." });
      clearInterval(keepAlive);
      return res.end();
    }

    const filePath = await exportToExcel(filtrados, `${prefix}_${year}${onlyFirst ? "_firstOnly" : ""}`);
    const relativePath = `/exports/${path.basename(filePath)}`;
    console.log(`✅ Lote concluído com ${filtrados.length} registros.`);
    send("done", { success: true, file: relativePath });

    clearInterval(keepAlive);
    res.end();
  } catch (err) {
    if (err?.message === "PREFEITURA_OFFLINE") {
      send("done", {
        error: "Não foi possível conectar ao site da Prefeitura no momento. Tente novamente em alguns minutos.",
      });
    } else if (err.name === "AbortError") {
      send("done", { error: "Busca cancelada." });
    } else {
      console.error("❌ Erro em /batch:", err.message);
      send("done", { error: "Ocorreu um erro durante a busca. Tente novamente." });
    }
    clearInterval(keepAlive);
    res.end();
  } finally {
    activeControllers.delete(reqId);
  }
});

// ============================================================
// ✅ Cancelar busca manualmente
// ============================================================
app.post("/api/cancel", (_req, res) => {
  try {
    for (const [id, controller] of activeControllers.entries()) {
      controller.abort();
      activeControllers.delete(id);
      console.log(`🛑 Busca abortada manualmente (${id})`);
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Falha ao cancelar buscas." });
  }
});

// ============================================================
// ✅ Busca por nome (com cancelamento e regra de 3 falhas)
// ============================================================
app.get("/api/process/searchByName", async (req, res) => {
  const { prefix, start, end, year, nome, setores, firstOnly } = req.query;
  if (!prefix || !year) {
    return res.status(400).json({ error: "Informe prefixo e ano." });
  }

  const setoresFiltro = setores ? setores.split(",").map(s => s.trim().toLowerCase()) : [];
  const onlyFirst = firstOnly === "true";

  const reqId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const controller = new AbortController();
  activeControllers.set(reqId, controller);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  req.on("close", () => {
    controller.abort();
    activeControllers.delete(reqId);
    clearInterval(keepAlive);
    console.log(`❌ Cliente desconectado /searchByName (${reqId})`);
  });

  console.log(`🔍 Busca por nome: "${nome || "—"}" — ${prefix}/${year}`);

  try {
    const processos = await fetchBatchProcesses(
      prefix,
      Number(start) || 1,
      Number(end) || 1000,
      year,
      (done, total, connectionError = false) => {
        if (connectionError) {
          sendEvent("warn", {
            warning: "O site da Prefeitura está demorando para responder. Tentando novamente…",
          });
        } else {
          sendEvent("progress", { percent: Math.round((done / total) * 100) });
        }
      },
      onlyFirst,
      controller
    );

    let filtrados = processos;

    if (nome) {
      filtrados = filtrados.filter(
        (p) =>
          p.Interessado?.toLowerCase().includes(nome.toLowerCase()) ||
          p.Requerente?.toLowerCase().includes(nome.toLowerCase())
      );
    }

    if (setoresFiltro.length > 0) {
      filtrados = filtrados.filter((p) =>
        setoresFiltro.includes(p["Setor Origem"]?.toLowerCase())
      );
    }

    if (filtrados.length === 0) {
      sendEvent("done", { error: "Não encontrei resultados com esses filtros." });
      clearInterval(keepAlive);
      return res.end();
    }

    const filePath = await exportToExcel(filtrados, `${prefix}_${year}_nome${onlyFirst ? "_firstOnly" : ""}`);
    const relativePath = `/exports/${path.basename(filePath)}`;
    console.log(`✅ Busca por nome concluída: ${filtrados.length} correspondências.`);
    sendEvent("done", { success: true, file: relativePath });

    clearInterval(keepAlive);
    res.end();
  } catch (err) {
    if (err?.message === "PREFEITURA_OFFLINE") {
      sendEvent("done", {
        error: "Não foi possível conectar ao site da Prefeitura no momento. Tente novamente em alguns minutos.",
      });
    } else if (err.name === "AbortError") {
      sendEvent("done", { error: "Busca cancelada." });
    } else {
      console.error("❌ Erro em /searchByName:", err.message);
      sendEvent("done", { error: "Ocorreu um erro durante a busca. Tente novamente." });
    }
    clearInterval(keepAlive);
    res.end();
  } finally {
    activeControllers.delete(reqId);
  }
});

// ============================================================
// ✅ Rota raiz
// ============================================================
app.get("/", (_req, res) => {
  res.sendFile(indexPath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
