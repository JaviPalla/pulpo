"use strict";

function summaryKey(title) {
  // ponytail: prefijo "pulpo:" conservado a propósito tras el rename — renombrarlo borraría los resúmenes/filtros ya guardados en localStorage.
  return `pulpo:ms-summary:${title}`;
}

function loadSummary(title) {
  try {
    const raw = localStorage.getItem(summaryKey(title));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSummary(title, data) {
  try {
    localStorage.setItem(summaryKey(title), JSON.stringify(data));
  } catch {
    /* cuota llena o modo restringido: el resumen sigue en memoria hasta recargar. */
  }
}

function relevanceMeta(relevance) {
  if (relevance === "high") return { cls: "high", label: t("Alta") };
  if (relevance === "low") return { cls: "low", label: t("Baja") };
  return { cls: "medium", label: t("Media") };
}

/* ----- filtro por proyecto/repo del resumen (pre y post generación) ----- */

// Path del proyecto a partir de la URL del issue/work_item ("…/grupo/proyecto/-/issues/123" → "grupo/proyecto").
function urlToProjectPath(url) {
  try {
    return new URL(url).pathname.replace(/^\/+/, "").replace(/\/-\/(issues|work_items)\/.*$/, "");
  } catch {
    return "";
  }
}

function projFilterKey(title) {
  return `pulpo:ms-projfilter:${title}`;
}

// Proyectos EXCLUIDOS del resumen (persistido aparte para que valga antes y después de generar).
function loadExcludedProjects(title) {
  try {
    return new Set(JSON.parse(localStorage.getItem(projFilterKey(title)) || "[]"));
  } catch {
    return new Set();
  }
}

function saveExcludedProjects(title, set) {
  try {
    localStorage.setItem(projFilterKey(title), JSON.stringify([...set]));
  } catch {
    /* no-op */
  }
}

// Carga (una vez) los proyectos del grupo con su icono; el board no la necesita, así que es lazy.
async function ensureProjects() {
  const m = state.milestones;
  if (m.projects) return;
  const arr = await window.monstro.groupProjects().catch(() => []);
  m.projects = new Map(arr.map((p) => [p.path, p]));
}

function projectMeta(path) {
  const meta = state.milestones.projects?.get(path);
  return { name: meta?.name || path.split("/").pop() || path, icon: meta?.icon || null };
}

// Color estable a partir del nombre, para el icono-letra de los proyectos sin avatar.
function letterColor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

function projectIconHtml(path) {
  const { name, icon } = projectMeta(path);
  if (icon) return `<img class="ms-proj-ic" src="${esc(icon)}" alt="" />`;
  const letter = (name[0] || "?").toUpperCase();
  return `<span class="ms-proj-ic letter" style="background:${letterColor(name)}">${esc(letter)}</span>`;
}

// Barra de chips de proyecto (icono + nombre); los excluidos quedan tachados. `paths` = los
// proyectos presentes en el conjunto actual (issues asignadas antes de generar, items después).
function projectFilterHtml(paths, excluded) {
  if (paths.length < 2) return ""; // con un solo proyecto no hay nada que filtrar
  const chips = paths
    .map((path) => {
      const { name } = projectMeta(path);
      const off = excluded.has(path);
      return `<button class="ms-proj-chip ${off ? "off" : ""}" data-path="${esc(path)}" title="${off ? t("Excluido del resumen · clic para incluir") : t("Incluido · clic para excluir")}">
        ${projectIconHtml(path)}<span class="ms-proj-name">${esc(name)}</span>
      </button>`;
    })
    .join("");
  return `<div class="ms-proj-filter"><span class="muted">${t("Proyectos:")}</span>${chips}</div>`;
}

// HTML autocontenido (sin clases del tema) para pegar en el correo, + texto plano de fallback.
function summaryEmailContent(title, included) {
  const heading = `${t("Novedades —")} ${title}`;
  const itemHtml = (h) => `<li>${h.kind === "epic" ? "📦 " : ""}<a href="${esc(h.url)}">${esc(h.headline)}</a></li>`;
  const richHtml = `<h3>${esc(heading)}</h3>\n<ul>\n${included.map((h) => "  " + itemHtml(h)).join("\n")}\n</ul>`;
  const plain = `${heading}\n\n${included.map((h) => `• ${h.headline}\n  ${h.url}`).join("\n")}`;
  return { heading, itemHtml, richHtml, plain };
}

// Cuerpo Markdown del resumen para publicarlo como snippet de GitLab (lo renderiza:
// enlaces vivos, refs auto-expandidas). El correo pasa a ser solo el enlace al snippet.
function summaryEmailMarkdown(title, included) {
  const heading = `${t("Novedades —")} ${title}`;
  const lines = included.map((h) => `- ${h.kind === "epic" ? "📦 " : ""}[${h.headline}](${h.url})`);
  return `# ${heading}\n\n${lines.join("\n")}\n`;
}

// Vista (HTML) de la sub-pestaña Resumen. Estado: cargando IA / sin generar / generado.
function milestoneSummaryHtml() {
  const m = state.milestones;
  const title = m.selectedTitle || "";
  const stored = loadSummary(title);
  const excluded = loadExcludedProjects(title);
  const pathOf = (it) => it.projectPath || urlToProjectPath(it.url);

  if (m.summaryLoading) {
    return `<div class="ms-summary">
      <div class="ms-sum-head"><h3 class="ms-sum-title">${t("Resumen de novedades")}</h3> <span class="muted">· ${esc(title)}</span></div>
      <div class="loading">${t("Analizando tareas con IA…")}</div>
    </div>`;
  }

  if (!stored) {
    // Pre-generación: el filtro opera sobre los proyectos de las tareas asignadas (lo excluido no
    // se manda a la IA). El contador refleja lo que SÍ se analizará.
    const assigned = m.issues.filter((iss) => iss.assignees.length);
    const preProjects = [...new Set(assigned.map((iss) => iss.projectPath).filter(Boolean))].sort();
    const toAnalyze = assigned.filter((iss) => !excluded.has(iss.projectPath)).length;
    const filterBar = projectFilterHtml(preProjects, excluded);
    const empty = assigned.length
      ? `<div class="empty ms-sum-empty">
           <p>${t(toAnalyze === 1 ? "Genera con IA un resumen de novedades para el correo del equipo: analiza la {n} tarea asignada (de los proyectos incluidos) y las ordena por relevancia." : "Genera con IA un resumen de novedades para el correo del equipo: analiza las {n} tareas asignadas (de los proyectos incluidos) y las ordena por relevancia.", { n: toAnalyze })} <span class="muted">${t("Gasta tokens.")}</span></p>
           <button class="btn btn-primary" id="ms-sum-generate" ${toAnalyze ? "" : "disabled"}>${t("Generar resumen")}</button>
         </div>`
      : `<div class="empty ms-sum-empty"><p>${t("No hay tareas asignadas en este milestone que resumir.")}</p></div>`;
    return `<div class="ms-summary">
      <div class="ms-sum-head"><h3 class="ms-sum-title">${t("Resumen de novedades")}</h3> <span class="muted">· ${esc(title)}</span></div>
      ${filterBar}
      ${empty}
    </div>`;
  }

  const items = stored.items || [];
  const postProjects = [...new Set(items.map(pathOf).filter(Boolean))].sort();
  const filterBar = projectFilterHtml(postProjects, excluded);
  const visible = items.filter((it) => !excluded.has(pathOf(it)));
  const includedCount = visible.filter((it) => it.included).length;
  const when = stored.generatedAt ? new Date(stored.generatedAt).toLocaleString("es-ES") : "";
  const meta = `${t("Generado el {when}", { when: esc(when) })}${stored.model ? ` · ${esc(stored.model)}` : ""}`;

  // Conserva el índice original (data-idx → stored.items) aunque se oculten filas por proyecto.
  const rowsHtml = items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => !excluded.has(pathOf(it)))
    .map(({ it, idx }) => {
      const rel = relevanceMeta(it.relevance);
      return `<div class="ms-sum-row ${it.included ? "" : "excluded"}" data-idx="${idx}" draggable="true">
        <span class="ms-sum-grip" title="${t("Arrastra para reordenar")}">⠿</span>
        <input type="checkbox" class="ms-task-check ms-sum-check" ${it.included ? "checked" : ""} title="${t("Incluir en el correo")}" />
        <span class="ms-sum-rel ${rel.cls}">${rel.label}</span>
        <div class="ms-sum-texts">
          <div class="ms-sum-headline">${it.kind === "epic" ? "📦 " : ""}${esc(it.headline)}</div>
          <div class="ms-sum-orig muted">${esc(it.title)}</div>
        </div>
        <button class="icon-btn ms-sum-edit" title="${t("Editar título")}">✎</button>
        <button class="icon-btn ms-sum-open" data-url="${esc(it.url)}" title="${t("Abrir en GitLab")}">↗</button>
      </div>`;
    })
    .join("");

  const included = visible.filter((it) => it.included);
  const { heading, itemHtml } = summaryEmailContent(title, included);
  const previewBody = included.length
    ? `<h4>${esc(heading)}</h4><ul>${included.map(itemHtml).join("")}</ul>`
    : `<p class="muted">${t("No hay novedades incluidas. Marca alguna tarea arriba.")}</p>`;

  return `<div class="ms-summary">
    <div class="ms-sum-head">
      <h3 class="ms-sum-title">${t("Resumen de novedades")}</h3> <span class="muted">· ${esc(title)}</span>
      <span class="ms-sum-meta muted">${meta}</span>
      <span class="ms-counter ms-sum-included">${t("{included} de {total} incluidas", { included: includedCount, total: visible.length })}</span>
      <button class="btn" id="ms-sum-regenerate" title="${t("Vuelve a llamar a la IA (gasta tokens)")}">${t("Regenerar")}</button>
    </div>
    ${filterBar}
    <div class="ms-sum-list">${rowsHtml}</div>
    <div class="ms-sum-preview-wrap">
      <div class="ms-sum-preview-head">
        <span class="muted">${t("Vista previa del correo")}</span>
        <span class="ms-sum-actions">
          <button class="btn" id="ms-sum-copy">${t("Copiar para el correo")}</button>
          <button class="btn btn-primary" id="ms-sum-publish" title="${t("Publica el resumen como snippet de GitLab y copia el enlace para el correo")}">${t("Publicar enlace en GitLab")}</button>
        </span>
      </div>
      <div class="ms-sum-preview collapsed" id="ms-sum-preview">${previewBody}</div>
      <button class="btn ghost ms-sum-readmore hidden" id="ms-sum-readmore">${t("Leer más")}</button>
    </div>
  </div>`;
}

// Llama al backend de IA con las tareas asignadas, marca include por defecto (relevancia ≠ low),
// persiste y re-renderiza. NO atómico ni reintentable: un fallo deja el estado anterior intacto.
async function generateMilestoneSummary(title) {
  const m = state.milestones;
  // Filtro pre-generación: los proyectos excluidos no se mandan a la IA (ni gastan tokens).
  const excluded = loadExcludedProjects(title);
  const assigned = m.issues.filter((iss) => iss.assignees.length && !excluded.has(iss.projectPath));
  if (!assigned.length) {
    toast(t("No hay tareas asignadas (de proyectos incluidos) que resumir"), "");
    return;
  }
  const payload = assigned.map((iss) => ({
    id: iss.id,
    projectId: iss.projectId,
    iid: iss.iid,
    issueType: iss.issueType,
    title: iss.title,
    webUrl: iss.webUrl,
    state: iss.state,
    descriptionHtml: iss.descriptionHtml,
    labels: iss.labels.map((l) => ({ name: l.name })),
  }));
  m.summaryLoading = true;
  renderMilestones();
  try {
    const { items, model } = await window.monstro.summarizeMilestone(title, payload);
    const stored = {
      generatedAt: new Date().toISOString(),
      model: model || "",
      // include por defecto: alta + media marcadas, baja desmarcada.
      items: (items || []).map((it) => ({
        kind: it.kind,
        title: it.title,
        url: it.url,
        projectPath: urlToProjectPath(it.url), // para el filtro por proyecto post-generación
        headline: it.headline,
        relevance: it.relevance,
        included: it.relevance !== "low",
      })),
    };
    saveSummary(title, stored);
  } catch (err) {
    toast(`${t("Error generando el resumen:")} ${String(err.message || err)}`, "err");
  } finally {
    m.summaryLoading = false;
    m.summaryPreviewExpanded = false;
    renderMilestones();
  }
}

// Engancha los controles de la sub-pestaña Resumen tras cada render.
function wireMilestoneSummary() {
  const m = state.milestones;
  const title = m.selectedTitle || "";

  $("#ms-sum-generate")?.addEventListener("click", () => generateMilestoneSummary(title));
  $("#ms-sum-regenerate")?.addEventListener("click", () => generateMilestoneSummary(title));

  // Si los iconos de proyecto aún no están cargados, los traemos y re-renderizamos (lazy).
  if (!m.projects) ensureProjects().then(() => renderMilestones());

  // Filtro por proyecto (pre y post generación): excluir/incluir y re-render.
  list.querySelectorAll(".ms-proj-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const path = chip.dataset.path;
      const ex = loadExcludedProjects(title);
      if (ex.has(path)) ex.delete(path);
      else ex.add(path);
      saveExcludedProjects(title, ex);
      renderMilestones();
    }),
  );

  // Toggle include/exclude: actualiza el item, re-persiste y re-renderiza (refresca preview + contador).
  list.querySelectorAll(".ms-sum-check").forEach((box) =>
    box.addEventListener("change", (event) => {
      const idx = Number(event.target.closest(".ms-sum-row").dataset.idx);
      const stored = loadSummary(title);
      if (!stored?.items?.[idx]) return;
      stored.items[idx].included = event.target.checked;
      saveSummary(title, stored);
      renderMilestones();
    }),
  );

  list.querySelectorAll(".ms-sum-open").forEach((btn) =>
    btn.addEventListener("click", () => window.monstro.openExternal(btn.dataset.url)),
  );

  // Editar el título: el lápiz cambia el headline por un input; Enter/blur persiste, Escape cancela.
  list.querySelectorAll(".ms-sum-edit").forEach((btn) =>
    btn.addEventListener("click", () => {
      const row = btn.closest(".ms-sum-row");
      const idx = Number(row.dataset.idx);
      const stored = loadSummary(title);
      if (!stored?.items?.[idx]) return;
      const headlineEl = row.querySelector(".ms-sum-headline");
      row.setAttribute("draggable", "false"); // no arrastrar mientras se edita
      const input = document.createElement("input");
      input.type = "text";
      input.className = "modal-input ms-sum-edit-input";
      input.value = stored.items[idx].headline;
      headlineEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (save) => {
        if (done) return;
        done = true;
        if (save) {
          const v = input.value.trim();
          const s = loadSummary(title);
          if (v && s?.items?.[idx]) {
            s.items[idx].headline = v;
            saveSummary(title, s);
          }
        }
        renderMilestones();
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(true); }
        else if (event.key === "Escape") { event.preventDefault(); commit(false); }
      });
      input.addEventListener("blur", () => commit(true));
    }),
  );

  // Reordenar por drag&drop: soltar una fila sobre otra la inserta en esa posición. Persiste el
  // nuevo orden de stored.items, del que cuelgan tanto la lista como la vista previa del correo.
  let dragIdx = null;
  list.querySelectorAll(".ms-sum-row").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      dragIdx = Number(row.dataset.idx);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(dragIdx));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      row.classList.remove("drag-over");
      const from = dragIdx ?? Number(event.dataTransfer.getData("text/plain"));
      const to = Number(row.dataset.idx);
      dragIdx = null;
      if (!Number.isInteger(from) || from === to) return;
      const stored = loadSummary(title);
      if (!stored?.items) return;
      const [moved] = stored.items.splice(from, 1);
      stored.items.splice(to, 0, moved);
      saveSummary(title, stored);
      renderMilestones();
    });
  });

  $("#ms-sum-copy")?.addEventListener("click", () => {
    const stored = loadSummary(title);
    const included = (stored?.items || []).filter((it) => it.included);
    if (!included.length) {
      toast(t("No hay novedades incluidas para copiar"), "");
      return;
    }
    const { richHtml, plain } = summaryEmailContent(title, included);
    copyRich(richHtml, plain);
  });

  // Publica el resumen como snippet de GitLab (lo renderiza bonito y con URL propia) y
  // copia el enlace al portapapeles: el correo pasa a ser una línea con el enlace.
  $("#ms-sum-publish")?.addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const stored = loadSummary(title);
    const included = (stored?.items || []).filter((it) => it.included);
    if (!included.length) {
      toast(t("No hay novedades incluidas para publicar"), "");
      return;
    }
    const markdown = summaryEmailMarkdown(title, included);
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = t("Publicando…");
    try {
      const { url } = await window.monstro.publishMilestoneSnippet(`${t("Novedades —")} ${title}`, markdown);
      copyText(url);
      toast(t("Snippet publicado · enlace copiado"), "ok");
      window.monstro.openExternal(url);
    } catch (err) {
      toast(`${t("Error publicando el snippet:")} ${String(err.message || err)}`, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  // "Leer más": solo si el preview se desborda de su altura acotada. Mantiene el estado expandido
  // entre re-renders (toggles de include) reaplicando la clase tras pintar.
  const preview = $("#ms-sum-preview");
  const readMore = $("#ms-sum-readmore");
  if (preview && readMore) {
    if (m.summaryPreviewExpanded) preview.classList.remove("collapsed");
    const overflows = preview.scrollHeight > preview.clientHeight;
    if (overflows || m.summaryPreviewExpanded) {
      readMore.classList.remove("hidden");
      readMore.textContent = m.summaryPreviewExpanded ? t("Leer menos") : t("Leer más");
      readMore.addEventListener("click", () => {
        m.summaryPreviewExpanded = !m.summaryPreviewExpanded;
        preview.classList.toggle("collapsed", !m.summaryPreviewExpanded);
        readMore.textContent = m.summaryPreviewExpanded ? t("Leer menos") : t("Leer más");
      });
    }
  }
}

function wireMilestoneDragDrop(list) {
  list.querySelectorAll(".ms-task").forEach((card) =>
    card.addEventListener("dragstart", (event) => {
      const key = card.dataset.key;
      const sel = state.milestones.selected;
      // Si arrastras una seleccionada, mueve toda la selección; si no, solo esa.
      const keys = sel.has(key) ? [...sel] : [key];
      const fromUserId = card.closest(".ms-drop")?.dataset.userid || "";
      event.dataTransfer.setData("text/plain", JSON.stringify({ keys, fromUserId }));
      event.dataTransfer.effectAllowed = "move";
    }),
  );

  const readPayload = (event) => {
    try {
      return JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch {
      return null;
    }
  };

  // Drop sobre una persona: reasignar (quita al de origen, añade al destino, conserva el resto).
  list.querySelectorAll(".ms-drop").forEach((col) => {
    col.addEventListener("dragover", (event) => {
      event.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (event) => {
      event.preventDefault();
      col.classList.remove("drag-over");
      const payload = readPayload(event);
      if (!payload) return;
      const fromId = Number(payload.fromUserId) || null;
      const targetId = col.dataset.userid ? Number(col.dataset.userid) : null;
      if (fromId && fromId === targetId) return; // misma columna, nada que hacer
      applyIssuePatch(payload.keys, (iss) => {
        let ids = iss.assignees.map((a) => a.id);
        if (fromId) ids = ids.filter((id) => id !== fromId);
        if (targetId && !ids.includes(targetId)) ids.push(targetId);
        return { assigneeIds: ids };
      });
    });
  });

  // Drop sobre un milestone del rail: mover el issue a ese milestone.
  list.querySelectorAll(".ms-drop-ms").forEach((item) => {
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("drag-over");
      const payload = readPayload(event);
      if (!payload) return;
      applyIssuePatch(payload.keys, { milestoneId: Number(item.dataset.msid) });
    });
  });
}

// Modal de etiquetas en bloque: chips tri-estado (neutro → añadir → quitar → neutro).
function openBulkLabelsModal() {
  const m = state.milestones;
  const keys = [...m.selected];
  if (!keys.length) return;
  const selectedIssues = m.issues.filter((i) => m.selected.has(issueKey(i)));
  // Estado inicial = labels que TODAS las seleccionadas ya tienen (badge relleno de partida).
  // Marcar = el label estará presente en todas; desmarcar = se quitará de todas.
  const initial = new Set(m.labels.filter((l) => selectedIssues.every((i) => i.labels.some((x) => x.name === l.name))).map((l) => l.name));
  const chosen = new Set(initial);
  const root = $("#modal-root");

  // Badge con el color real del label: relleno si está marcado, solo borde si no.
  const badge = (l) => {
    const on = chosen.has(l.name);
    const c = l.color || "var(--accent)";
    const style = on
      ? `background:${c};color:${l.textColor || "#fff"};border:1px solid ${c}`
      : `background:transparent;color:${c};border:1px solid ${c}`;
    return `<button class="ms-label-pick" data-name="${esc(l.name)}" style="${style}">${esc(l.name)}</button>`;
  };
  const renderChips = (filter = "") => {
    const f = filter.trim().toLowerCase();
    return m.labels.filter((l) => !f || l.name.toLowerCase().includes(f)).map(badge).join("");
  };

  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal-wide">
        <h3>${t(keys.length === 1 ? "Etiquetas · {n} seleccionada" : "Etiquetas · {n} seleccionadas", { n: keys.length })}</h3>
        <p class="muted">${t("Las rellenas se aplicarán a todas; las que quites se eliminarán de todas.")}</p>
        <input type="text" class="modal-input" id="ms-label-search" placeholder="${t("Buscar etiqueta…")}" />
        <div class="ms-label-pick-list" id="ms-label-list">${renderChips()}</div>
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">${t("Cancelar")}</button>
          <button class="btn btn-primary" id="modal-apply">${t("Aplicar")}</button>
        </div>
      </div>
    </div>`;

  const close = () => (root.innerHTML = "");
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#modal-cancel").addEventListener("click", close);
  $("#ms-label-search").addEventListener("input", (event) => {
    $("#ms-label-list").innerHTML = renderChips(event.target.value);
    wireRows();
  });
  const wireRows = () =>
    root.querySelectorAll(".ms-label-pick").forEach((row) =>
      row.addEventListener("click", () => {
        const name = row.dataset.name;
        if (chosen.has(name)) chosen.delete(name);
        else chosen.add(name);
        $("#ms-label-list").innerHTML = renderChips($("#ms-label-search").value);
        wireRows();
      }),
    );
  wireRows();
  $("#modal-apply").addEventListener("click", () => {
    const addLabels = [...chosen].filter((n) => !initial.has(n));
    const removeLabels = [...initial].filter((n) => !chosen.has(n));
    close();
    if (addLabels.length || removeLabels.length) applyIssuePatch(keys, { addLabels, removeLabels });
  });
}

// Modal para mover las seleccionadas a otro milestone (o quitarlo).
function openBulkMilestoneModal() {
  const m = state.milestones;
  const keys = [...m.selected];
  if (!keys.length) return;
  const root = $("#modal-root");
  const items = m.list
    .map((ms) => `<button class="ms-label-row" data-msid="${ms.id}"><span>${esc(ms.title)}</span>${ms.dueDate ? `<span class="muted">${esc(ms.dueDate)}</span>` : ""}</button>`)
    .join("");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h3>${t(keys.length === 1 ? "Mover a milestone · {n} seleccionada" : "Mover a milestone · {n} seleccionadas", { n: keys.length })}</h3>
        <div class="ms-label-list">
          ${items}
          <button class="ms-label-row off" data-msid="0"><span>${t("Sin milestone")}</span></button>
        </div>
        <div class="modal-actions"><button class="btn" id="modal-cancel">${t("Cancelar")}</button></div>
      </div>
    </div>`;
  const close = () => (root.innerHTML = "");
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") close();
  });
  $("#modal-cancel").addEventListener("click", close);
  root.querySelectorAll(".ms-label-row").forEach((row) =>
    row.addEventListener("click", () => {
      const msid = Number(row.dataset.msid);
      close();
      applyIssuePatch(keys, { milestoneId: msid || null });
    }),
  );
}

/* ============ vista releases (solo GitLab) ============ */
