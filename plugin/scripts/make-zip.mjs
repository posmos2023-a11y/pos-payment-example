// dist/ 전체 -> ../release/payment-example-plugin-<version>.zip (zip 안 구조: dist/index.html, dist/iframe-manifest.json, dist/*.js·css)
// 외부 패키지 없이 Node 내장 zlib 으로 ZIP 을 직접 쓴다.
//  - 항목: dist/ 안의 모든 파일과 하위 폴더(zip 루트 기준 상대경로)
//  - 로컬 헤더 + 중앙 디렉터리 + EOCD, CRC32 직접 계산, UTF-8 파일명 플래그(0x0800)
// 쓴 뒤 파일을 다시 읽어 항목 목록/CRC/내용을 검증하고 출력한다.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const distDir = join(root, 'dist');
const releaseDir = resolve(root, '..', 'release');
const zipPath = join(releaseDir, `payment-example-plugin-${pkg.version}.zip`);

// ---- CRC32 (IEEE 802.3) ---------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- DOS 시각 -------------------------------------------------------------
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

// ---- ZIP 쓰기 -------------------------------------------------------------
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // Unix 호스트, 2.0

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data ?? Buffer.alloc(0);
    const crc = e.isDir ? 0 : crc32(raw);
    const method = e.isDir ? 0 : 8; // 디렉터리는 저장, 파일은 deflate
    const body = e.isDir ? Buffer.alloc(0) : zlib.deflateRawSync(raw, { level: 9 });
    const { time, date } = dosDateTime(e.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    const unixMode = e.isDir ? 0o040755 : 0o100644;
    const dosAttr = e.isDir ? 0x10 : 0;
    central.writeUInt32LE(((unixMode << 16) | dosAttr) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---- ZIP 읽기/검증 ---------------------------------------------------------
function readZip(buf) {
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error('EOCD 를 찾지 못했어요');
  const total = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (cdOffset + cdSize !== eocdPos) throw new Error('중앙 디렉터리 위치/크기가 맞지 않아요');

  const out = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('중앙 디렉터리 시그니처 오류');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;

    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`로컬 헤더 시그니처 오류: ${name}`);
    const lflags = buf.readUInt16LE(lho + 6);
    const lcrc = buf.readUInt32LE(lho + 14);
    const lnlen = buf.readUInt16LE(lho + 26);
    const lxlen = buf.readUInt16LE(lho + 28);
    const lname = buf.toString('utf8', lho + 30, lho + 30 + lnlen);
    if (lname !== name) throw new Error(`로컬/중앙 이름 불일치: ${lname} != ${name}`);
    if (lflags !== flags || lcrc !== crc) throw new Error(`로컬/중앙 헤더 불일치: ${name}`);
    const dataStart = lho + 30 + lnlen + lxlen;
    const body = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    if (data.length !== usize) throw new Error(`압축 해제 크기 불일치: ${name}`);
    out.push({ name, method, flags, crc, csize, usize, data });
  }
  return out;
}

// ---- 실행 -----------------------------------------------------------------
// dist/ 의 모든 파일·하위 폴더를 zip 루트에 넣는다(정렬해서 항상 같은 순서).
function collect(dir, prefix, out) {
  const names = readdirSync(dir).sort();
  for (const n of names) {
    const full = join(dir, n);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push({ name: `${prefix}${n}/`, isDir: true, mtime: st.mtime });
      collect(full, `${prefix}${n}/`, out);
    } else {
      out.push({ name: `${prefix}${n}`, data: readFileSync(full), mtime: st.mtime });
    }
  }
  return out;
}

// 토스 개발자센터는 POS 플러그인 zip 을 dist/ 폴더로 감싼 구조로 요구한다(루트에 흩뿌리면
// "main.js 또는 iframe-manifest.json이 포함되어야 합니다"로 거부). 업로드에 성공한 이전 프로젝트 구조와 같게
// dist/index.html, dist/iframe-manifest.json, dist/<js·css> (하위 폴더 없음, 구분자는 '/') 로 만든다.
// 토스 개발자센터가 이 구조(dist/ 폴더로 감싼 zip)를 요구한다.
const ZIP_DIR = 'dist/';
const entries = [{ name: ZIP_DIR, isDir: true, mtime: statSync(distDir).mtime }, ...collect(distDir, ZIP_DIR, [])];
const files = entries.filter((e) => !e.isDir);
const fileNames = files.map((e) => e.name);

// 빌드 산출물 점검: 필수 항목, 하위 폴더 없음, 상대경로
for (const must of ['index.html', 'iframe-manifest.json']) {
  if (!fileNames.includes(ZIP_DIR + must)) throw new Error(`dist 에 ${must} 가 없어요`);
}
const nested = entries.filter((e) => e.name !== ZIP_DIR && e.name.slice(ZIP_DIR.length).includes('/'));
if (nested.length > 0) throw new Error(`dist 안에 하위 폴더가 있어요(평평해야 함): ${nested.map((e) => e.name).join(', ')}`);
const indexHtml = files.find((e) => e.name === ZIP_DIR + 'index.html').data.toString('utf8');
const refs = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const bad = refs.filter((r) => r.startsWith('/') || /^https?:/i.test(r) || r.includes('/assets/'));
if (bad.length > 0) throw new Error(`index.html 참조 경로가 올바르지 않아요: ${bad.join(', ')}`);
for (const r of refs.filter((r) => /\.(js|css)$/.test(r))) {
  if (!fileNames.includes(ZIP_DIR + r.replace(/^\.\//, ''))) throw new Error(`index.html 이 참조하는 ${r} 가 dist 에 없어요`);
}
const manifest = JSON.parse(files.find((e) => e.name === ZIP_DIR + 'iframe-manifest.json').data.toString('utf8'));
if (manifest?.tab?.href !== 'index.html') throw new Error('iframe-manifest.json 의 tab.href 가 index.html 이 아니에요');

mkdirSync(releaseDir, { recursive: true });
const zipBuf = buildZip(entries);
writeFileSync(zipPath, zipBuf);

// 다시 읽어서 검증
const reread = readZip(readFileSync(zipPath));
const names = reread.map((e) => e.name);
if (JSON.stringify(names) !== JSON.stringify(entries.map((e) => e.name))) {
  throw new Error(`예상과 다른 항목 목록: ${names.join(', ')}`);
}
for (const e of reread) {
  if ((e.flags & FLAG_UTF8) === 0) throw new Error(`UTF-8 플래그 없음: ${e.name}`);
  if (crc32(e.data) !== e.crc) throw new Error(`CRC 불일치: ${e.name}`);
  if (typeof zlib.crc32 === 'function' && zlib.crc32(e.data) !== e.crc) {
    throw new Error(`zlib.crc32 와 CRC 불일치: ${e.name}`);
  }
}
for (const src of files) {
  const back = reread.find((e) => e.name === src.name);
  if (!back || !back.data.equals(src.data)) throw new Error(`zip 안의 ${src.name} 가 원본과 달라요`);
}
const roots = [...new Set(reread.map((e) => e.name.split('/')[0]))];
if (roots.length !== 1 || roots[0] !== 'dist') throw new Error(`zip 맨 위에는 dist/ 폴더 하나만 있어야 해요: ${roots.join(', ')}`);
if (reread.some((e) => e.name.includes('\\'))) throw new Error('zip 경로에 백슬래시가 있어요');

console.log(`zip: ${zipPath}`);
console.log(`zip: ${zipBuf.length.toLocaleString('en-US')} bytes, 항목 ${reread.length}개`);
for (const e of reread) {
  console.log(`  ${e.name.padEnd(36)} method=${e.method} size=${e.usize} compressed=${e.csize} crc32=${e.crc.toString(16).padStart(8, '0')}`);
}
console.log(`zip: index.html 참조 경로 ${refs.join(', ')}`);
console.log('zip: 검증 통과(dist/ 로 감쌈: dist/index.html, dist/iframe-manifest.json, js·css, 하위 폴더 없음)');
