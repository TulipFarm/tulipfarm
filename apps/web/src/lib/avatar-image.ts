import { avatarImageSchema } from '@tulipfarm/workspaces/contracts';

const accepted = ['image/png', 'image/jpeg', 'image/webp'];
const maxPickBytes = 2 * 1024 * 1024;
const edge = 128;

export class AvatarImageError extends Error {}

// Crops to a centered square, shrinks to 128px, and saves as WebP so the stored value stays under the API limit.
export async function shrinkAvatar(file: File): Promise<string> {
  if (!accepted.includes(file.type)) throw new AvatarImageError('Choose a PNG, JPEG, or WebP image.');
  if (file.size > maxPickBytes) throw new AvatarImageError('Choose an image smaller than 2 MB.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarImageError('This image could not be read. Choose another one.');
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = edge;
    canvas.height = edge;
    const context = canvas.getContext('2d');
    if (!context) throw new AvatarImageError('This browser cannot resize images.');
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, edge, edge);
    for (const quality of [0.85, 0.7, 0.5]) {
      const url = canvas.toDataURL('image/webp', quality);
      if (avatarImageSchema.safeParse(url).success) return url;
    }
    throw new AvatarImageError('This image is too detailed. Choose a simpler one.');
  } finally {
    bitmap.close();
  }
}
