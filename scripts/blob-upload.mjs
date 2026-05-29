// Upload a local file to Vercel Blob and print the public URL.
// Usage: BLOB_READ_WRITE_TOKEN=... node scripts/blob-upload.mjs <path> [name]
import { put } from '@vercel/blob';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const file = process.argv[2];
const name = process.argv[3] || basename(file);
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!file || !token) {
  console.error('need <path> and BLOB_READ_WRITE_TOKEN');
  process.exit(1);
}
const data = readFileSync(file);
const res = await put(`qa/${Date.now()}-${name}`, data, {
  access: 'public',
  token,
  contentType: 'video/mp4',
  addRandomSuffix: true
});
console.log(res.url);
