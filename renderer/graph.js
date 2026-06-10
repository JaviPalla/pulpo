"use strict";

/**
 * PulpoGraph — layout y render del grafo de commits (estilo gitk/GitKraken).
 *
 * computeLayout(commits, branches):
 *   - ordena por fecha (con ajuste topológico: un padre nunca antes que su hijo)
 *   - asigna carriles (lanes) recorriendo el DAG hacia abajo
 * renderSVG(layout): SVG con líneas/curvas por carril y nodo por commit.
 */
(function () {
  const LANE_W = 16;
  const ROW_H = 38;
  const NODE_R = 4.5;
  const PALETTE = [
    "#4493f8", "#3fb950", "#ab7df8", "#d29922", "#f85149",
    "#39c5cf", "#f778ba", "#9ece6a", "#ff9e64", "#7aa2f7",
  ];

  function laneColor(i) {
    return PALETTE[i % PALETTE.length];
  }

  function topoAdjust(commits) {
    // Fechas iguales pueden colar un padre antes que su hijo; lo corregimos.
    const index = new Map(commits.map((c, i) => [c.oid, i]));
    let moved = true;
    let guard = 0;
    while (moved && guard++ < 5) {
      moved = false;
      for (let i = 0; i < commits.length; i++) {
        for (const parent of commits[i].parents.nodes) {
          const pi = index.get(parent.oid);
          if (pi !== undefined && pi < i) {
            const [p] = commits.splice(pi, 1);
            commits.splice(i, 0, p);
            commits.forEach((c, k) => index.set(c.oid, k));
            moved = true;
            break;
          }
        }
        if (moved) break;
      }
    }
    return commits;
  }

  function computeLayout(commits, branches) {
    const sorted = topoAdjust(
      [...commits].sort((a, b) => new Date(b.committedDate) - new Date(a.committedDate)),
    );
    const branchesByOid = new Map();
    for (const b of branches) {
      if (!branchesByOid.has(b.headOid)) branchesByOid.set(b.headOid, []);
      branchesByOid.get(b.headOid).push(b.name);
    }

    const lanes = []; // oid que espera cada carril (null = libre)
    const rows = [];
    let maxLanes = 1;

    for (const commit of sorted) {
      const matches = [];
      lanes.forEach((oid, i) => {
        if (oid === commit.oid) matches.push(i);
      });

      let lane;
      if (matches.length === 0) {
        lane = lanes.indexOf(null);
        if (lane === -1) {
          lanes.push(null);
          lane = lanes.length - 1;
        }
      } else {
        lane = Math.min(...matches);
      }
      const closing = matches.filter((i) => i !== lane);
      const lanesBefore = [...lanes];

      closing.forEach((i) => (lanes[i] = null));
      const parents = commit.parents.nodes.map((p) => p.oid);
      lanes[lane] = parents[0] ?? null;

      const opened = [];
      for (const parentOid of parents.slice(1)) {
        const existing = lanes.findIndex((oid) => oid === parentOid);
        if (existing !== -1) {
          opened.push(existing); // ya hay un carril esperándolo: dibujamos la unión
          continue;
        }
        let free = lanes.indexOf(null);
        if (free === -1) {
          lanes.push(null);
          free = lanes.length - 1;
        }
        lanes[free] = parentOid;
        opened.push(free);
      }

      maxLanes = Math.max(maxLanes, lanes.length);
      rows.push({
        commit,
        lane,
        closing,
        opened,
        lanesBefore,
        lanesAfter: [...lanes],
        refs: branchesByOid.get(commit.oid) || [],
        isMerge: parents.length > 1,
      });
    }
    return { rows, maxLanes, laneWidth: LANE_W, rowHeight: ROW_H };
  }

  function laneX(i) {
    return 12 + i * LANE_W;
  }

  function renderSVG(layout) {
    const { rows, maxLanes } = layout;
    const width = 12 + maxLanes * LANE_W + 8;
    const height = rows.length * ROW_H;
    const parts = [];

    rows.forEach((row, i) => {
      const yTop = i * ROW_H;
      const yMid = yTop + ROW_H / 2;
      const yBot = yTop + ROW_H;
      const cx = laneX(row.lane);

      // continuidad vertical de carriles
      row.lanesBefore.forEach((oid, j) => {
        if (oid !== null && j !== row.lane && !row.closing.includes(j)) {
          parts.push(`<line x1="${laneX(j)}" y1="${yTop}" x2="${laneX(j)}" y2="${yBot}" stroke="${laneColor(j)}" stroke-width="2"/>`);
        }
      });
      // el carril del commit: entra si alguien lo esperaba, sale si tiene padre
      if (row.lanesBefore[row.lane] !== null) {
        parts.push(`<line x1="${cx}" y1="${yTop}" x2="${cx}" y2="${yMid}" stroke="${laneColor(row.lane)}" stroke-width="2"/>`);
      }
      if (row.lanesAfter[row.lane] !== null) {
        parts.push(`<line x1="${cx}" y1="${yMid}" x2="${cx}" y2="${yBot}" stroke="${laneColor(row.lane)}" stroke-width="2"/>`);
      }
      // ramas que convergen en este commit (cierran su carril)
      row.closing.forEach((j) => {
        parts.push(`<path d="M ${laneX(j)} ${yTop} C ${laneX(j)} ${yMid}, ${cx} ${yTop + 4}, ${cx} ${yMid}" fill="none" stroke="${laneColor(j)}" stroke-width="2"/>`);
      });
      // segundos padres (merge): el carril se abre/conecta hacia abajo
      row.opened.forEach((j) => {
        parts.push(`<path d="M ${cx} ${yMid} C ${cx} ${yBot}, ${laneX(j)} ${yMid + 4}, ${laneX(j)} ${yBot}" fill="none" stroke="${laneColor(j)}" stroke-width="2"/>`);
      });
      // nodo
      if (row.isMerge) {
        parts.push(`<circle cx="${cx}" cy="${yMid}" r="${NODE_R}" fill="var(--bg-raised)" stroke="${laneColor(row.lane)}" stroke-width="2.5"/>`);
      } else {
        parts.push(`<circle cx="${cx}" cy="${yMid}" r="${NODE_R}" fill="${laneColor(row.lane)}"/>`);
      }
    });

    return {
      svg: `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`,
      width,
    };
  }

  window.PulpoGraph = { computeLayout, renderSVG, laneColor };
})();
