import express from "express";
import { fetchProcessData, fetchBatchProcesses, exportToExcel } from "./services/processService.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 📁 Frontend agora está dentro do backend
const FRONTEND_DIR = path.join(__dirname, "frontend");
const indexPath = path.join(FRONTEND_DIR, "index.html");

console.log("🧩 Servindo frontend de:", FRONTEND_DIR);
console.log("📄 index.html encontrado?", fs.existsSync(indexPath));

app.use(express.json());

// 🌐 arquivos estáticos do frontend
app.use(express.static(FRONTEND_DIR));

// 📊 arquivos exportados (Excel)
app.use("/exports", express.static(path.join(__dirname, "exports")));

// ============================================================
// ✅ Busca única
// ============================================================
app.get("/api/process", async (req, res) => {
  try {
    const { numero, firstOnly } = req.query;
    if (!numero) return res.status(400).json({ error: "Número do processo é obrigatório." });

    console.log(`🔍 Buscando processo único: ${numero} (firstOnly=${firstOnly === "true"})`);
    const processData = await fetchProcessData(numero, firstOnly === "true");

    // ⚠️ Servidor da Prefeitura fora do ar
    if (processData && processData.__error === "CONNECTION_ERROR") {
      return res.status(503).json({ error: "Falha de conexão com o servidor da Prefeitura." });
    }

    if (!processData) return res.status(404).json({ error: "Nenhum dado encontrado." });

    const filePath = await exportToExcel(processData, numero);
    const relativePath = `/exports/${path.basename(filePath)}`;
    console.log(`✅ Exportado: ${filePath}`);

    res.json({ success: true, file: relativePath });
  } catch (err) {
    console.error("❌ Erro em /api/process:", err.message);
    res.status(500).json({ error: "Erro ao processar requisição." });
  }
});

// ============================================================
// ✅ Busca em lote com SSE + cancelamento
// ============================================================
const activeControllers = new Map();

app.get("/api/process/batch", async (req, res) => {
  const { prefix, start, end, year, setores, firstOnly } = req.query;
  if (!prefix || !year)
    return res.status(400).json({ error: "Prefixo e ano são obrigatórios." });

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
    console.log(`❌ Cliente desconectado do SSE /batch (${reqId})`);
  });

  try {
    console.log(`🚀 Iniciando busca em lote: ${prefix} (${start || 1}-${end || 1000})/${year}`);

    const processos = await fetchBatchProcesses(
      prefix,
      Number(start) || 1,
      Number(end) || 1000,
      year,
      (done, total, connectionError = false) => {
        if (connectionError) {
          // ⚠️ Envia aviso especial de falha de conexão ao front
          send("error", { warning: "Falha de conexão com o servidor da Prefeitura." });
        } else {
          send("progress", { percent: Math.round((done / total) * 100) });
        }
      },
      onlyFirst,
      controller.signal
    );

    const filtrados = setoresFiltro.length
      ? processos.filter(p => setoresFiltro.includes(p["Setor Origem"]?.toLowerCase()))
      : processos;

    if (!filtrados || filtrados.length === 0) {
      send("done", { error: "Nenhum processo encontrado." });
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
    if (err.name === "AbortError") {
      console.log(`🛑 Busca cancelada (${reqId})`);
      send("done", { error: "Busca cancelada pelo usuário." });
    } else {
      console.error("❌ Erro em /batch:", err.message);
      send("done", { error: err.message });
    }
    clearInterval(keepAlive);
    res.end();
  } finally {
    activeControllers.delete(reqId);
  }
});

// ============================================================
// ✅ Endpoint para cancelar busca manualmente
// ============================================================
app.post("/api/cancel", (req, res) => {
  try {
    for (const [id, controller] of activeControllers.entries()) {
      controller.abort();
      activeControllers.delete(id);
      console.log(`🛑 Busca abortada manualmente (${id})`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Falha ao cancelar buscas." });
  }
});

// ============================================================
// ✅ Busca por nome (também com cancelamento e detecção de falha de conexão)
// ============================================================
app.get("/api/process/searchByName", async (req, res) => {
  const { prefix, start, end, year, nome, setores, firstOnly } = req.query;
  if (!prefix || !year)
    return res.status(400).json({ error: "Prefixo e ano são obrigatórios." });

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
    console.log(`❌ Cliente desconectado do SSE /searchByName (${reqId})`);
  });

  console.log(`🔍 Buscando por nome "${nome || "todos"}" — ${prefix}/${year}`);

  try {
    const processos = await fetchBatchProcesses(
      prefix,
      Number(start) || 1,
      Number(end) || 1000,
      year,
      (done, total, connectionError = false) => {
        if (connectionError) {
          sendEvent("error", { warning: "Falha de conexão com o servidor da Prefeitura." });
        } else {
          sendEvent("progress", { percent: Math.round((done / total) * 100) });
        }
      },
      onlyFirst,
      controller.signal
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
      sendEvent("done", { error: "Nenhum processo encontrado com esses filtros." });
      clearInterval(keepAlive);
      return res.end();
    }

    const filePath = await exportToExcel(filtrados, `${prefix}_${year}_nome${onlyFirst ? "_firstOnly" : ""}`);
    const relativePath = `/exports/${path.basename(filePath)}`;
    console.log(`✅ Busca concluída: ${filtrados.length} correspondências.`);
    sendEvent("done", { success: true, file: relativePath });

    clearInterval(keepAlive);
    res.end();
  } catch (err) {
    if (err.name === "AbortError") {
      console.log(`🛑 Busca por nome cancelada (${reqId})`);
      sendEvent("done", { error: "Busca cancelada pelo usuário." });
    } else {
      console.error("❌ Erro em /searchByName:", err.message);
      sendEvent("done", { error: err.message });
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
app.get("/", (_req, res) => {res.sendFile(indexPath);});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));