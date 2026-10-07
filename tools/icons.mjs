// Renders public/icons/icon.svg to the PNG sizes the manifest references.
import sharp from 'sharp';

for (const size of [16, 32, 48, 128]) {
  await sharp('public/icons/icon.svg', { density: 384 }).resize(size, size).png().toFile(`public/icons/icon${size}.png`);
}
console.log('icons written');
