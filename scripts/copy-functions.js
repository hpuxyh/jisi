// 把 functions/ 复制到 dist/functions/，方便 wrangler pages deploy 一次部署
import { cpSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = resolve(root, 'functions');
const dst = resolve(root, 'dist', 'functions');

if (!existsSync(src)) {
  console.error('找不到 functions/ 目录');
  process.exit(1);
}

if (!existsSync(dirname(dst))) {
  mkdirSync(dirname(dst), { recursive: true });
}

cpSync(src, dst, { recursive: true });
console.log(`已复制 functions/ → dist/functions/`);
