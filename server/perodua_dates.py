"""Separate same-date batches; reopening updates only the chosen entry."""
from datetime import date
import re
from uuid import uuid4
from perodua_ordering import order_documents, trip_summary
from perodua_rules import pido_family, saved_family
from excel_export import LAYOUT_VERSION
from perodua_storage import database_path
from perodua_business_date import delivery_business_date


def ensure_dates(ledger):
    if 'dates' not in ledger:
        groups = {}
        for export in ledger.get('exports', []):
            saved_date = export.get('save_date') or export['generated_date']
            key = export.get('collection_id') or saved_date
            entry = groups.setdefault(key, {'id': key, 'date': saved_date, 'status': 'open', 'document_keys': [],
                'serials': export.get('serials', ['', '', '']), 'revision': 1, 'updated_at': export['created_at'],
                'dirty': True, 'reopened_reason': 'ordering_update'})
            entry['document_keys'] = list(dict.fromkeys(entry['document_keys'] + export['document_keys']))
            entry['current_export_id'] = export['id']
        ledger['dates'] = list(groups.values())
    for entry in ledger['dates']:
        entry.setdefault('id', entry['date'])
        families = {pido_family(value['data']['PIDO']) for value in ledger['documents'] if value['key'] in entry['document_keys']}
        if families == {'PM', 'PK'}:
            entry['family'] = 'PM_PK'
        else:
            entry.setdefault('family', saved_family(families))
    return ledger['dates']


def resolve_entry(entries, key):
    exact = next((entry for entry in entries if entry['id'] == key), None)
    if exact:
        return exact
    matching = [entry for entry in entries if entry['date'] == key]
    if len(matching) > 1:
        raise ValueError('Several batches use this date. Choose the individual history entry.')
    return matching[0] if matching else None


def date_documents(ledger, entry):
    return order_documents([value for value in ledger['documents'] if value['key'] in set(entry['document_keys'])])


def entry_exports(ledger, entry):
    return [value for value in ledger.get('exports', []) if value.get('collection_id') == entry['id'] or
            not value.get('collection_id') and entry['id'] == entry['date'] and (value.get('save_date') or value['generated_date']) == entry['date']]


def public_date(ledger, entry):
    documents = date_documents(ledger, entry)
    export = next((value for value in ledger.get('exports', []) if value['id'] == entry.get('current_export_id')), None)
    result = {key: entry.get(key) for key in ['id', 'date', 'family', 'status', 'serials', 'revision', 'updated_at', 'completed_at', 'reopened_reason']}
    result.update(company='PERODUA', order_count=len(documents), **trip_summary(documents),
        document_keys=[value['key'] for value in documents], order_numbers=[value['data']['PIDO'] for value in documents],
        sources=list(dict.fromkeys(value['source_file'] for value in documents)),
        documents=[{'key': value['key'], 'pido': value['data']['PIDO'], 'source_file': value['source_file'],
                    'delivery_date': value['data']['delivery_date'], 'delivery_trip': value['data'].get('delivery_trip')}
                   for value in documents], export_id=export['id'] if export else None, filename=export['filename'] if export else None,
        versions=[{'id': value['id'], 'filename': value['filename'], 'created_at': value['created_at']}
                  for value in entry_exports(ledger, entry) if value.get('completed_at') or not value.get('save_date')])
    return result


def operate_date(ledger, state_dir, settings_path, keys, serials, save_date, action, now, write_export, save_ledger,
                 save_id=None, new_id=None, family=None):
    entries = ensure_dates(ledger)
    save_date = save_date or now.date().isoformat()
    if date.fromisoformat(save_date).isoformat() != save_date:
        raise ValueError('Invalid saved date.')
    entry = resolve_entry(entries, save_id) if save_id else next((value for value in entries if value['id'] == new_id), None)
    if not save_id and action != 'save':
        entry = resolve_entry(entries, save_date)
    if action == 'save':
        if not keys:
            raise ValueError('Select at least one Perodua PO.')
        by_key = {value['key']: value for value in ledger['documents']}
        if any(key not in by_key for key in keys):
            raise ValueError('A selected Perodua PO was not found.')
        if save_id and not entry:
            raise ValueError('Saved Perodua batch not found.')
        if entry is None:
            identity = new_id or uuid4().hex
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identity):
                raise ValueError('Invalid batch identity.')
            families = {pido_family(by_key[key]['data']['PIDO']) for key in keys}
            entry = {'id': identity, 'date': save_date, 'family': family or saved_family(families),
                     'status': 'open', 'document_keys': [], 'serials': serials or ['', '', ''], 'revision': 0,
                     'date_basis': 'delivery_cutoff_08',
                     'updated_at': now.isoformat(), 'dirty': True}
            entries.append(entry)
        incoming = {pido_family(by_key[key]['data']['PIDO']) for key in keys}
        allowed = {'PM', 'PK'} if entry['family'] in ('PM', 'PK', 'PM_PK') else {entry['family']}
        if entry['family'] != 'MIXED' and not incoming <= allowed:
            raise ValueError('Add only ' + entry['family'] + ' POs to this entry. Use New batch for another prefix.')
        if entry.get('date_basis') == 'delivery_cutoff_08' and any(delivery_business_date(by_key[key]['data']) != entry['date'] for key in keys):
            raise ValueError('These POs belong to another date under the 08:00 delivery cutoff. Choose that date or start a new batch.')
        new_keys = list(dict.fromkeys(entry['document_keys'] + keys))
        combined = {pido_family(by_key[key]['data']['PIDO']) for key in new_keys}
        if combined == {'PM', 'PK'}:
            entry['family'] = 'PM_PK'
        if entry['status'] == 'complete' and set(new_keys) != set(entry['document_keys']):
            entry['reopened_reason'] = 'new_po'
        entry['document_keys'] = new_keys
        if serials is not None:
            entry['serials'] = serials
        entry.update(status='open', dirty=True)
        entry.pop('completed_at', None)
    elif entry is None:
        raise ValueError('Saved Perodua batch not found.')
    if action == 'reopen':
        entry.update(status='open', dirty=True, reopened_reason='manual', updated_at=now.isoformat())
        entry.pop('completed_at', None)
        save_ledger(state_dir, ledger)
        return {'status': 'ready', 'pido': 'Combined', 'json_path': str(database_path(state_dir).resolve()), 'date': public_date(ledger, entry)}
    current = next((value for value in ledger.get('exports', []) if value['id'] == entry.get('current_export_id')), None)
    if action == 'complete' and current and not entry.get('dirty', True) and current.get('layout_version') == LAYOUT_VERSION:
        entry.update(status='complete', completed_at=now.isoformat(), updated_at=now.isoformat())
        current['completed_at'] = now.isoformat()
        save_ledger(state_dir, ledger)
        return {'status': 'ready', 'pido': 'Combined', 'json_path': str(database_path(state_dir).resolve()),
                'path': str((state_dir / 'exports' / current['filename']).resolve()), **current, 'export_id': current['id'], 'date': public_date(ledger, entry)}

    def update_record(export):
        entry.update(current_export_id=export['id'], document_keys=export['document_keys'], serials=export['serials'],
                     revision=entry.get('revision', 0) + 1, updated_at=now.isoformat(), dirty=False,
                     status='complete' if action == 'complete' else 'open')
        if action == 'complete':
            entry['completed_at'] = now.isoformat()
            export['completed_at'] = now.isoformat()
    result = write_export(ledger, state_dir, settings_path, entry['document_keys'],
        {'status': 'review', 'pido': 'Combined', 'json_path': str(database_path(state_dir).resolve())},
        now=now, serials=entry['serials'], save_date=entry['date'], on_export=update_record,
        collection_id=entry['id'], family=entry['family'])
    if result['status'] == 'ready':
        result['date'] = public_date(ledger, entry)
    return result
