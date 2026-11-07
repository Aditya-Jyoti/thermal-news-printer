/** Storage of rendered receipt PNGs under FileSystem.documentDirectory/prints/<id>.png. */
async function fs() {
  return import('expo-file-system/legacy');
}

export async function savePrintPng(printId: number, pngBase64: string): Promise<string | null> {
  const FileSystem = await fs();
  if (!FileSystem.documentDirectory) return null;
  const dir = `${FileSystem.documentDirectory}prints/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  const uri = `${dir}${printId}.png`;
  await FileSystem.writeAsStringAsync(uri, pngBase64, { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

/** URI of a saved print image, or null if it does not exist. */
export async function getPrintPngUri(printId: number): Promise<string | null> {
  const FileSystem = await fs();
  if (!FileSystem.documentDirectory) return null;
  const uri = `${FileSystem.documentDirectory}prints/${printId}.png`;
  const info = await FileSystem.getInfoAsync(uri).catch(() => null);
  return info?.exists ? uri : null;
}
