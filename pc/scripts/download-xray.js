'use strict';

/**
 * Downloads xray.exe into pc/resources/ before electron-builder runs.
 * Uses os.tmpdir() for all external tool calls to avoid Cyrillic path issues.
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const XRAY_VERSION  = 'v26.3.27';
const XRAY_ZIP_URL  = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-windows-64.zip`;
const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const XRAY_EXE      = path.join(RESOURCES_DIR, 'xray.exe');

if (fs.existsSync(XRAY_EXE)) {
  console.log('xray.exe already present, skipping download.');
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log('Not Windows — skipping xray download (GitHub Actions handles it).');
  process.exit(0);
}

fs.mkdirSync(RESOURCES_DIR, { recursive: true });

// Keep all external tool paths in os.tmpdir() (always ASCII on Windows)
const zipPath     = path.join(os.tmpdir(), 'prox-xray.zip');
const extractPath = path.join(os.tmpdir(), 'prox-xray-extract');

console.log('Downloading xray', XRAY_VERSION, '...');
execSync(
  `powershell -NoProfile -Command "(New-Object System.Net.WebClient).DownloadFile('${XRAY_ZIP_URL}','${zipPath}')"`,
  { stdio: 'inherit' }
);

console.log('Extracting...');
if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });
fs.mkdirSync(extractPath, { recursive: true });
execSync(
  `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractPath}' -Force"`,
  { stdio: 'inherit' }
);

// Node.js fs handles Unicode paths fine
fs.copyFileSync(path.join(extractPath, 'xray.exe'), XRAY_EXE);

try { fs.unlinkSync(zipPath); } catch (_) {}
try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch (_) {}

console.log('xray.exe ready →', XRAY_EXE);
