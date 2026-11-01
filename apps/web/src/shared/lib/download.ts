/** Save an authenticated asset from a button, with errors handled by the caller. */
export async function downloadAsset(path: string, filename: string): Promise<void> {
  const response = await fetch(path);
  if (!response.ok) throw new Error('下载失败');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  const serverName = response.headers
    .get('Content-Disposition')
    ?.match(/filename="([^"/\\]+)"/u)?.[1];
  link.download = serverName ?? filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
