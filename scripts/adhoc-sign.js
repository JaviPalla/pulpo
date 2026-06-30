"use strict";

/**
 * Hook afterPack de electron-builder: firma el .app en ad-hoc (codesign -s -).
 * electron-builder 25 no hace ad-hoc por config (mac.identity "-" solo busca en
 * el llavero y, al no encontrarla, omite la firma), así que lo hacemos a mano.
 * Sin esto, en Apple Silicon el .app descargado sale como "está dañado".
 */
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  console.log(`ad-hoc signed ${app}`);
};
