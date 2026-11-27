"""Local Perodua parsing and immutable, generation-dated batch exports."""
import argparse
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys
from uuid import uuid4

from functions_Perodua import extract_page_texts, parse_document
from excel_export import build_export_rows, document_key, normalize_serials, workbook_bytes, LAYOUT_VERSION
from perodua_ordering import order_documents, trip_summary
from perodua_dates import operate_date, ensure_dates
from export_filenames import save_unique_workbook
from perodua_rules import pido_family, saved_family
from perodua_business_date import delivery_business_date
from perodua_storage import load_ledger, save_ledger, configure_database, database_path

MALAYSIA = timezone(timedelta(hours=8))


def write_atomic(target, content):
    temporary = target.with_name(target.name + '.' + uuid4().hex + '.tmp')
    try:
        temporary.write_bytes(content)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def save_json(target, value):
    write_atomic(target, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8'))


def process_pdf(pdf, source_name, output_dir, state_dir, settings_path, extract_only=False, serials=None):
    data = parse_document(extract_page_texts(Path(pdf).read_bytes()))
    output_dir, state_dir = Path(output_dir), Path(state_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / 'extracted.json'
    save_json(json_path, data)
    key = document_key(data)
    ledger = load_ledger(state_dir)
    identity = lambda value: (str(value['PIDO']).casefold(), value['delivery_date'], value['delivery_time'])
    if any(entry['key'] != key and identity(entry['data']) == identity(data) for entry in ledger['documents']):
        raise ValueError(f"A different version of PIDO {data['PIDO']} is already saved. Review it before exporting.")
    if not any(entry['key'] == key for entry in ledger['documents']):
        ledger['documents'].append({'key': key, 'source_file': source_name, 'data': data, 'rows': None})
    else:
        existing = next(entry for entry in ledger['documents'] if entry['key'] == key)
        previous_trip, printed_trip = existing['data'].get('delivery_trip'), data.get('delivery_trip')
        if previous_trip and printed_trip and previous_trip != printed_trip:
            raise ValueError(f"A conflicting Delivery Trip is already saved for PIDO {data['PIDO']}.")
        if printed_trip is not None:
            existing['data']['delivery_trip'] = printed_trip
    save_ledger(state_dir, ledger)
    result = {'status': 'review', 'pido': data['PIDO'], 'document_key': key, 'json_path': str(json_path.resolve())}
    if extract_only:
        result['status'] = 'extracted'
        return result
    return export_saved(ledger, state_dir, settings_path, [key], result, serials=serials)


def generate_saved(state_dir, settings_path, document_keys=None, document_jsons=None, now=None, serials=None, save_date=None, date_action=None, save_id=None, batch_id=None):
    state_dir = Path(state_dir)
    ledger = load_ledger(state_dir)
    keys = list(document_keys or [])
    keys.extend(document_key(json.loads(Path(file).read_text(encoding='utf-8'))) for file in document_jsons or [])
    if not keys:  # Standalone CLI convenience; the web API requires an explicit selection.
        keys = [entry['key'] for entry in ledger['documents'] if entry.get('rows') is None]
    if date_action:
        now = (now or datetime.now(MALAYSIA)).astimezone(MALAYSIA)
        if date_action != 'save' or save_id:
            return operate_date(ledger, state_dir, settings_path, list(dict.fromkeys(keys)), serials, save_date,
                                date_action, now, export_saved, save_ledger, save_id=save_id)
        selected = [entry for entry in ledger['documents'] if entry['key'] in set(keys)]
        if len({entry['key'] for entry in selected}) != len(set(keys)):
            raise ValueError('A selected Perodua PO was not found.')
        families = sorted({pido_family(entry['data']['PIDO']) for entry in selected})
        if not families or any(family not in ('PG', 'PM', 'PK') for family in families):
            raise ValueError('Perodua PIDO must start with PG/PM or contain only digits for PK.')
        batch = batch_id or uuid4().hex
        saved = []
        days = sorted({delivery_business_date(entry['data']) for entry in selected})
        if save_date and any(day != save_date for day in days):
            raise ValueError('The selected date does not match the PDF delivery date/time under the 08:00 cutoff.')
        for day in days:
            daily = [entry for entry in selected if delivery_business_date(entry['data']) == day]
            daily_families = {pido_family(entry['data']['PIDO']) for entry in daily}
            groups = [('PG', {'PG'})] if 'PG' in daily_families else []
            compatible = daily_families & {'PM', 'PK'}
            if compatible:
                groups.append((saved_family(compatible), compatible))
            for family, members in groups:
                family_keys = [entry['key'] for entry in daily if pido_family(entry['data']['PIDO']) in members]
                identity = batch + '_' + day + '_' + family
                value = operate_date(ledger, state_dir, settings_path, family_keys, serials, day, 'save',
                                     now, export_saved, save_ledger, new_id=identity, family=family)
                if value['status'] != 'ready':
                    return value
                saved.append(value)
        return {**saved[0], 'dates': [value['date'] for value in saved], 'outputs': saved}
    result = {'status': 'review', 'pido': 'Combined', 'json_path': str(database_path(state_dir).resolve())}
    return export_saved(ledger, state_dir, settings_path, list(dict.fromkeys(keys)), result, now, serials)


def export_saved(ledger, state_dir, settings_path, keys, result, now=None, serials=None, save_date=None, on_export=None, collection_id=None, family=None):
    created_file = None
    try:
        if not keys:
            raise ValueError('Select at least one Perodua document for this export.')
        by_key = {entry['key']: entry for entry in ledger['documents']}
        if any(key not in by_key for key in keys):
            raise ValueError('A selected Perodua document was not found in the saved collection.')
        selected = order_documents([by_key[key] for key in keys])
        keys = [entry['key'] for entry in selected]
        created = (now or datetime.now(MALAYSIA)).astimezone(MALAYSIA)
        generated_date = created.date()
        # Legacy model mappings are not read or used. Back No is extracted data.
        if serials is None:
            serials = ['', '', '']
        if not isinstance(serials, list) or len(serials) != 3:
            raise ValueError('Provide SUGI No, GC No and Serial No. values, using blank text for omitted fields.')
        first = normalize_serials(serials, allow_blank=True)
        if any(value and int(value.removeprefix('PG')) < 1 for value in first):
            raise ValueError('Filled SUGI No, GC No and Serial No. values must be at least 1.')
        pm_rows, pg_rows, last_used, rows_by_key = build_export_rows(selected, first, generated_date)
        for entry in selected:
            if entry.get('rows') is None:
                entry['rows'] = [[value.isoformat() if hasattr(value, 'isoformat') else value for value in row]
                                 for row in rows_by_key[entry['key']]]
        rows = pg_rows + pm_rows
        content = workbook_bytes(pm_rows, pg_rows=pg_rows)
        directory = state_dir / 'exports'
        directory.mkdir(parents=True, exist_ok=True)
        families = sorted({pido_family(entry['data']['PIDO']) for entry in selected})
        export_family = saved_family(families)
        prefix = 'PERODUA_' + ('PM_PK' if export_family == 'PM_PK' else '_'.join(families))
        target = save_unique_workbook(directory, prefix, save_date or generated_date.isoformat(), content)
        created_file = target
        filename = target.name
        export = {
            'layout_version': LAYOUT_VERSION, 'collection_id': collection_id, 'family': family or ('PM_PK' if export_family == 'PM_PK' else '_'.join(families)),
            'save_date': save_date or generated_date.isoformat(),
            'id': uuid4().hex, 'generated_date': generated_date.isoformat(), 'created_at': created.isoformat(),
            'filename': filename, 'serials': first, 'last_serials': last_used, 'document_keys': keys, 'document_count': len(selected), 'item_count': len(rows),
            **trip_summary(selected),
            'documents': [{'key': entry['key'], 'pido': entry['data']['PIDO'], 'source_file': entry['source_file'],
                           'delivery_date': entry['data']['delivery_date'], 'delivery_trip': entry['data'].get('delivery_trip'), 'item_count': len(entry['data']['Item'])}
                          for entry in selected],
        }
        ledger.setdefault('exports', []).append(export)
        if on_export:
            on_export(export)
        ledger['last_used'] = last_used
        save_ledger(state_dir, ledger)
        result.update(status='ready', path=str(target.resolve()), filename=filename,
                      export_id=export['id'], generated_date=export['generated_date'], created_at=export['created_at'],
                      document_keys=keys, document_count=len(selected), item_count=len(rows))
    except (ValueError, OSError, TypeError) as error:
        if created_file is not None:
            created_file.unlink(missing_ok=True)
        result['error'] = str(error)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate-only', action='store_true')
    parser.add_argument('--extract-only', action='store_true')
    parser.add_argument('--date-action', choices=['save', 'complete', 'reopen'])
    parser.add_argument('--save-date')
    parser.add_argument('--save-id')
    parser.add_argument('--batch-id')
    parser.add_argument('--serial', action='append', default=None)
    parser.add_argument('--document-key', action='append', default=[])
    parser.add_argument('--document-json', action='append', default=[])
    for option in ['pdf', 'source-name', 'output-dir', 'state-dir', 'settings']:
        parser.add_argument('--' + option, required=option in ['state-dir', 'settings'])
    parser.add_argument('--database')
    args = parser.parse_args()
    configure_database(args.database)
    try:
        if args.generate_only:
            result = generate_saved(args.state_dir, args.settings, args.document_key, args.document_json, serials=args.serial,
                                    save_date=args.save_date, date_action=args.date_action, save_id=args.save_id, batch_id=args.batch_id)
        else:
            if not all([args.pdf, args.source_name, args.output_dir]):
                parser.error('--pdf, --source-name and --output-dir are required for extraction.')
            result = process_pdf(args.pdf, args.source_name, args.output_dir, args.state_dir, args.settings, args.extract_only, args.serial)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(f'Perodua extraction/export failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
