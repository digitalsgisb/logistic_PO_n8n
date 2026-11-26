export type FileTypeNotice = { id: string; current_type: string; message: string };

/** Polling, React remounts and refreshes must not repeat the same popup. */
export function notifyFileTypeError(notice: FileTypeNotice | undefined,
  storage: Pick<Storage, 'getItem' | 'setItem'>, show: (message: string) => void) {
  if (!notice) return;
  const key = 'logistics_type_error:' + notice.id;
  if (storage.getItem(key)) return;
  storage.setItem(key, 'shown');
  show(notice.message);
}
