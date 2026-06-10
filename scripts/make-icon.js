"use strict";

/**
 * Genera assets/icon-1024.png renderizando el SVG del pulpo con el propio
 * Electron (ventana offscreen transparente + capturePage). Después, el
 * empaquetado a .icns se hace con sips/iconutil (ver scripts/make-icon.sh).
 */
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6573ef"/>
      <stop offset="1" stop-color="#7f3df0"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="448" rx="200" fill="url(#shine)"/>
  <!-- tentáculos -->
  <g stroke="#ffffff" stroke-width="58" stroke-linecap="round" fill="none" opacity="0.96">
    <path d="M 330 600 C 320 730, 250 750, 215 700"/>
    <path d="M 430 640 C 430 780, 350 820, 305 775"/>
    <path d="M 512 650 C 512 800, 512 800, 512 800"/>
    <path d="M 594 640 C 594 780, 674 820, 719 775"/>
    <path d="M 694 600 C 704 730, 774 750, 809 700"/>
  </g>
  <!-- cabeza -->
  <ellipse cx="512" cy="440" rx="252" ry="232" fill="#ffffff"/>
  <!-- ojos -->
  <circle cx="430" cy="430" r="46" fill="#2b2f55"/>
  <circle cx="594" cy="430" r="46" fill="#2b2f55"/>
  <circle cx="444" cy="416" r="14" fill="#ffffff"/>
  <circle cx="608" cy="416" r="14" fill="#ffffff"/>
  <!-- sonrisa -->
  <path d="M 462 540 Q 512 580 562 540" stroke="#2b2f55" stroke-width="22" stroke-linecap="round" fill="none"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const outDir = path.join(__dirname, "..", "assets");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "icon-1024.png"), image.toPNG());
  console.log("icon-1024.png generado");
  app.quit();
});
