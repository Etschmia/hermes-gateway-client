// Browser-side attachment handling for the chat input.
//
// Two kinds of attachment reach the Hermes gateway differently:
//   • image → an OpenAI-style `image_url` data-URL part (the gateway decodes it
//     and the agent actually sees it; confirmed min 8px/side and ≥512px total).
//   • file  → text-like files are inlined into the message text (the agent reads
//     them as text). Binary types we can't usefully send are rejected.
//
// Images are downscaled in the browser before encoding: a phone screenshot is
// multiple MB raw, which would blow the localStorage cache and bloat every
// request (the whole history is re-sent each turn). 1280px JPEG keeps each one
// to ~100–300 KB while staying well above the gateway's minimum size.

export const MAX_IMAGE_DIM = 1280;
export const MAX_TEXT_BYTES = 100 * 1024; // inline cap for text files

export interface ImageAttachment {
  id: string;
  kind: 'image';
  name: string;
  dataUrl: string; // data:image/jpeg;base64,…
  w: number;
  h: number;
}

export interface FileAttachment {
  id: string;
  kind: 'file';
  name: string;
  text: string;
  truncated?: boolean;
}

export type Attachment = ImageAttachment | FileAttachment;

const rid = () => Math.random().toString(36).slice(2, 10);

// Extensions we treat as text even when the browser reports no/odd MIME type.
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|sh|bash|zsh|sql|toml|ini|conf|cfg|log|env|gitignore|dockerfile)$/i;

export function isTextLike(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (
    [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/x-yaml',
      'application/x-sh',
    ].includes(file.type)
  )
    return true;
  return TEXT_EXT.test(file.name);
}

async function imageToAttachment(file: Blob, name: string): Promise<ImageAttachment> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode failed'));
      i.src = url;
    });

    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    // White matte so transparent PNGs don't flatten to black under JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const baseName = (name || 'Bild').replace(/\.[^.]+$/, '');
    return {
      id: rid(),
      kind: 'image',
      name: `${baseName}.jpg`,
      dataUrl: canvas.toDataURL('image/jpeg', 0.85),
      w,
      h,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function textToAttachment(file: File): Promise<FileAttachment> {
  const raw = await file.text();
  const truncated = raw.length > MAX_TEXT_BYTES;
  return {
    id: rid(),
    kind: 'file',
    name: file.name || 'Datei.txt',
    text: truncated ? raw.slice(0, MAX_TEXT_BYTES) : raw,
    truncated,
  };
}

export interface AttachResult {
  att?: Attachment;
  error?: string;
}

// Turn one picked/pasted file into an attachment, or an error message to show.
export async function fileToAttachment(file: File): Promise<AttachResult> {
  if (file.type.startsWith('image/')) {
    try {
      return { att: await imageToAttachment(file, file.name) };
    } catch {
      return { error: `${file.name || 'Bild'}: konnte nicht verarbeitet werden` };
    }
  }
  if (isTextLike(file)) {
    try {
      return { att: await textToAttachment(file) };
    } catch {
      return { error: `${file.name}: konnte nicht gelesen werden` };
    }
  }
  return {
    att: undefined,
    error: `${file.name || 'Datei'}: Typ nicht unterstützt (nur Bilder & Textdateien)`,
  };
}

// Build the per-message `content` the chat API expects: a plain string when
// there are no images, otherwise the OpenAI multimodal parts array. File
// attachments are folded into the text either way.
type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export function toApiContent(content: string, attachments?: Attachment[]): string | ContentPart[] {
  const atts = attachments ?? [];
  const images = atts.filter((a): a is ImageAttachment => a.kind === 'image');
  const files = atts.filter((a): a is FileAttachment => a.kind === 'file');

  let text = content || '';
  for (const f of files) {
    text += `${text ? '\n\n' : ''}--- Datei: ${f.name}${f.truncated ? ' (gekürzt)' : ''} ---\n${f.text}`;
  }

  if (images.length === 0) return text;

  const parts: ContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const im of images) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  return parts;
}
