import { destination, headers } from './mapping.ts';
import type { Order } from './types.ts';

export function tagsPerRack(place: string, code: string) {
  return (place === 'BUKIT RAJA' && code === '614') ||
    (place === 'SHAH ALAM' && ['HU83', '238X', 'HU82'].includes(code))
    ? 1
    : 2;
}

/** Each small printed tag represents one rack, including repeated item codes. */
export function analyseTagging(texts: string[], orders: Order[] = []) {
  return texts
    .map((text, index) => {
      const large = /SKID\s+NO/i.test(text) && /ORDER\s+NUMBER/i.test(text);
      const items = [...text.matchAll(/\b([A-Z0-9]{3,4})\s+STORE\s+ADDRESS\b/g)].map((m) => m[1]);
      let place = '';
      try {
        place = destination(text);
      } catch {
        /* Explicit review required below. */
      }
      const sequences = [
        ...new Set([...text.matchAll(/\b(20\d{2})\s*(\d{4})\s*(\d{2})\b/g)].map((m) => m[1] + m[2] + m[3])),
      ];
      return {
        page: index + 1,
        kind: large ? 'rack' : items.length ? 'small' : 'unknown',
        place,
        sequence: sequences.length === 1 ? sequences[0] : '',
        items,
        copies: large ? 0 : 1,
        lines: [] as { code: string; racks: number; tagRacks?: number; multiplier: number; copies: number }[],
        notes: [] as string[],
        matchedOrders: [] as string[],
      };
    })
    .map((page, _, pages) => {
      if (page.kind === 'unknown')
        page.notes.push('Page type not recognised. Select its type and verify copies.');
      if (!page.sequence || !page.place)
        page.notes.push('Date/trip or destination could not be read. Review the source page.');
      if (page.kind !== 'rack') return page;
      const racks = pages.filter(
        (p) => p.kind === 'rack' && p.sequence === page.sequence && p.place === page.place,
      );
      if (racks.length !== 1 || !page.sequence || !page.place) {
        page.notes.push('Cannot uniquely match this rack page. Enter the verified copy count.');
        return page;
      }
      const small = pages.filter(
        (p) => p.kind === 'small' && p.sequence === page.sequence && p.place === page.place,
      );
      const counts = new Map<string, number>();
      for (const code of small.flatMap((p) => p.items)) counts.set(code, (counts.get(code) ?? 0) + 1);
      for (const [code, count] of counts) {
        if (headers[code]?.destination !== page.place)
          page.notes.push(`Unknown or conflicting part code ${code}. Verify before printing.`);
        const multiplier = tagsPerRack(page.place, code);
        page.lines.push({ code, racks: count, multiplier, copies: count * multiplier });
      }
      page.copies = page.lines.reduce((sum, line) => sum + line.copies, 0);
      if (!counts.size) page.notes.push('No matching small tags found. Enter copies after checking the PO.');
      const matching = orders.filter(
        (o) => o.delivery_sequence === page.sequence && o.destination === page.place,
      );
      page.matchedOrders = matching.map((o) => o.kb_number);
      if (matching.length) {
        const expected = new Map<string, number>();
        for (const item of matching.flatMap((o) => o.items))
          expected.set(item.item_code, (expected.get(item.item_code) ?? 0) + item.kanban_count);
        // The validated PO's ORDER (KANBANS) is authoritative when available.
        page.lines = [...new Set([...expected.keys(), ...counts.keys()])].map((code) => {
          const count = expected.get(code) ?? 0;
          const multiplier = tagsPerRack(page.place, code);
          return {
            code,
            racks: count,
            tagRacks: counts.get(code) ?? 0,
            multiplier,
            copies: count * multiplier,
          };
        });
        page.copies = page.lines.reduce((sum, line) => sum + line.copies, 0);
        if (
          [...new Set([...counts.keys(), ...expected.keys()])].some(
            (code) => counts.get(code) !== expected.get(code),
          )
        )
          page.notes.push(
            'Tag rack counts differ from the matching PO. Copies use PO rack counts; check missing/extra tags before confirming.',
          );
      } else
        page.notes.push(
          'No matching validated PO in this batch. Counts are from the small tags; verify against your PO.',
        );
      return page;
    });
}
