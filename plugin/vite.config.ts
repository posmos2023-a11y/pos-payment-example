import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// 토스 POS 탭 화면에서 검증된 빌드 형태: <script src="./bundle.js"> 로 읽는 IIFE.
// ES 모듈(type="module" + crossorigin)은 웹뷰가 파일을 여는 방식에 따라 막힐 수 있어 쓰지 않는다.
//  - 결과: dist/index.html, dist/bundle.js(IIFE 한 파일), dist/style.css, dist/iframe-manifest.json (하위 폴더 없음)
//  - zip 은 scripts/make-zip.mjs 가 dist/ 로 감싸서 만든다(개발자센터 업로드 요구 구조).
function classicScript(): Plugin {
  return {
    name: 'classic-script',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin src=/g, '<script defer src=')
        .replace(/<script type="module" src=/g, '<script defer src=')
        .replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), classicScript()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: '',
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'bundle.js',
        assetFileNames: (info) => (info.names?.some((n) => n.endsWith('.css')) ? 'style.css' : '[name][extname]'),
      },
    },
  },
});
