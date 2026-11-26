"""Ordering and trip summaries shared by first exports and reopened dates."""
from perodua_rules import pido_family, pido_key, item_number, pm_group


def delivery_trip(data):
    value = data.get('delivery_trip')
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def trip_key(data):
    return delivery_trip(data) if delivery_trip(data) is not None else float('inf')


def ordered_items(documents):
    """Dates ascend; PG uses trips/No; PM seeds each Back No with its smallest PIDO."""
    result = []
    for day in sorted({entry['data']['delivery_date'] for entry in documents}):
        today = [entry for entry in documents if entry['data']['delivery_date'] == day]
        pg = [entry for entry in today if pido_family(entry['data']['PIDO']) == 'PG']
        pg.sort(key=lambda entry: (trip_key(entry['data']), pido_key(entry['data']['PIDO']),
                                   entry['data'].get('delivery_time', ''), entry['key']))
        for entry in pg:
            result.extend((entry, item) for item in sorted(entry['data'].get('Item', []), key=item_number))
        groups = {}
        for entry in today:
            if pido_family(entry['data']['PIDO']) != 'PM':
                continue
            for item in entry['data'].get('Item', []):
                groups.setdefault(pm_group(entry['data'], item), []).append((entry, item))
        anchors = lambda group: (min(pido_key(entry['data']['PIDO']) for entry, _ in groups[group]), group)
        for group in sorted(groups, key=anchors):
            seed = min(pido_key(entry['data']['PIDO']) for entry, _ in groups[group])
            result.extend(sorted(groups[group], key=lambda pair: (
                0 if pido_key(pair[0]['data']['PIDO']) == seed else 1,
                trip_key(pair[0]['data']), pido_key(pair[0]['data']['PIDO']), pair[0]['key'])))
        other = [entry for entry in today if pido_family(entry['data']['PIDO']) not in ('PG', 'PM')]
        other.sort(key=lambda entry: (trip_key(entry['data']), entry['data'].get('delivery_time', ''),
                                      pido_key(entry['data']['PIDO']), entry['key']))
        for entry in other:
            result.extend((entry, item) for item in sorted(entry['data'].get('Item', []), key=item_number))
    return result


def order_documents(documents):
    # Documents with no items are retained for metadata/legacy unit callers.
    expanded = [dict(entry, data={**entry['data'], 'Item': entry['data'].get('Item') or [{}]}) for entry in documents]
    by_key = {entry['key']: entry for entry in documents}
    result, seen = [], set()
    for entry, _ in ordered_items(expanded):
        if entry['key'] not in seen:
            result.append(by_key[entry['key']])
            seen.add(entry['key'])
    return result


def trip_summary(documents):
    trips = {(entry['data']['delivery_date'], delivery_trip(entry['data']))
             for entry in documents if delivery_trip(entry['data']) is not None}
    return {'trip_count': len(trips),
            'missing_trip_count': sum(delivery_trip(entry['data']) is None for entry in documents),
            'trips': [{'delivery_date': date, 'trip': trip} for date, trip in sorted(trips)]}
