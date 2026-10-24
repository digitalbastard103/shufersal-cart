import { describe, expect, it } from 'vitest';

import { normalizeStart, parseSlots, toSlot } from '../src/shufersal/types.js';

// Shape copied from the captured getHomeDeliverySlots response (2026-10).
const slot = (code: string, start: string, fromHour: number, selectable = true) => ({
  fromHour,
  toHour: fromHour + 2 * 3600_000,
  dayType: 'REGULAR',
  sourceOfSupply: 'DIRECT',
  price: { currencyIso: 'ILS', value: 35.9, formattedValue: '35.90 ₪' },
  deliveryCostCode: 'DLV3_1',
  code,
  selectable,
  fromHourString: start,
  deliveryZone: { code: 'area_x' },
});

describe('delivery slots', () => {
  it('flattens the per-day map earliest first, with Israel-time end hours', () => {
    const body = {
      '20261102': [slot('B', '2026/11/02 14:00', 1793620800000)],
      '20261101': [slot('A', '2026/11/01 10:00', 1793520000000), slot('C', '2026/11/01 18:00', 1793548800000, false)],
    };
    expect(parseSlots(body).map((s) => [s.code, s.start, s.endTime, s.selectable])).toEqual([
      ['A', '2026-11-01 10:00', '12:00', true],
      ['C', '2026-11-01 18:00', '20:00', false],
      ['B', '2026-11-02 14:00', '16:00', true],
    ]);
  });

  it('keeps the raw slot object so it can be posted back unchanged', () => {
    const raw = slot('A', '2026/11/01 10:00', 1793520000000);
    expect(toSlot(raw)!.raw).toBe(raw);
  });

  it('reads "nothing chosen" as null', () => {
    expect(toSlot({ code: null, fromHourString: null, selectable: false })).toBeNull();
  });

  it('ignores anything that is not the expected map', () => {
    expect(parseSlots(null)).toEqual([]);
    expect(parseSlots([1, 2])).toEqual([]);
    expect(parseSlots({ x: 'not a list' })).toEqual([]);
  });

  it('normalizes the --pick time', () => {
    expect(normalizeStart('2026-11-02 14:00')).toBe('2026-11-02 14:00');
    expect(normalizeStart('2026/11/02 9:00')).toBe('2026-11-02 09:00');
    expect(normalizeStart('2026-11-02T14:00')).toBe('2026-11-02 14:00');
    expect(normalizeStart('tomorrow')).toBeNull();
  });
});
