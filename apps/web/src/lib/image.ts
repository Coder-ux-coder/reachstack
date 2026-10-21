/** Reads an image file and scales it down to fit `max` pixels, returning a PNG/JPEG data URL small enough to store inline. */
export async function imageToDataUrl(file: File, max = 256): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file (PNG, JPG, GIF or WebP)");
  if (file.size > 5 * 1024 * 1024) throw new Error("Images must be 5 MB or smaller");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("This image couldn't be read"));
      el.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}
