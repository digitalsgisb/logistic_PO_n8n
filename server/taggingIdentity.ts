export type TaggingIdentity = { supplier?: string; dock?: string; lane?: string };

/** Read printed routing identifiers, independently of AI extraction. */
export function taggingIdentity(text: string): TaggingIdentity {
  const unique = (values: string[]) => {
    const all = [...new Set(values)];
    return all.length === 1 ? all[0] : undefined;
  };
  const large = text.match(/RECEIVING DOCK CODE[^\n]*\n\s*(\d[A-Z])\s+(\d{2})/i);
  return {
    supplier: unique(text.match(/\bSGIS-\d+(?:-[A-Z0-9]+)*\b/g) ?? []),
    dock:
      large?.[1] ??
      unique([
        ...[...text.matchAll(/DOCK CODE\s+ASSB[^\n]*\n(?:[^\n]*\n)?(\d[A-Z])\b/g)].map((m) => m[1]),
        ...[...text.matchAll(/\b20\d{8}\s+\d+\/\d+\s+(\d[A-Z])\b/g)].map((m) => m[1]),
      ]),
    lane:
      large?.[2] ??
      unique([
        ...[...text.matchAll(/MROSNo\.\(P\/LANE\)[\s\S]*?\n(\d{2})\n/g)].map((m) => m[1]),
        ...[...text.matchAll(/^(\d{2})\s+W[SM]02-\d{2}\b/gm)].map((m) => m[1]),
      ]),
  };
}

export function compatibleIdentity(a: TaggingIdentity, b: TaggingIdentity) {
  return (['supplier', 'dock', 'lane'] as const).every((key) => !a[key] || !b[key] || a[key] === b[key]);
}
