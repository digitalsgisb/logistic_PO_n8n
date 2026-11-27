from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from perodua_business_date import delivery_business_date
from perodua_cli import generate_saved
from perodua_storage import load_ledger, save_ledger
from excel_export import document_key
from openpyxl import load_workbook


def document(pido, day, time):
    pg = pido.startswith('PG')
    data = {'PIDO': pido, 'delivery_date': day, 'delivery_time': time, 'delivery_trip': 1,
            'Item': [{'number': 1, 'back_no': 'GCI010' if pg else 'GC501',
                      'part_no': '58510-BZN90-C0' if pg else '64770-BZU90-C0',
                      'part_name': 'CARPET', 'qty_per_box': 30, 'total_box': 2, 'total_qty': 60}]}
    return {'key': document_key(data), 'source_file': pido + '.pdf', 'data': data, 'rows': None}


class PeroduaCutoffTest(unittest.TestCase):
    def test_pdf_time_boundary_and_calendar_rollovers(self):
        for day, clock, expected in [('2026-11-24', '00:00', '2026-11-23'),
                                     ('2026-11-24', '07:59', '2026-11-23'),
                                     ('2026-11-24', '08:00', '2026-11-24'),
                                     ('2026-11-24', '23:59', '2026-11-24'),
                                     ('2026-12-01', '07:30', '2026-11-30'),
                                     ('2027-01-01', '07:30', '2026-12-31'),
                                     ('2028-03-01', '07:30', '2028-02-29')]:
            with self.subTest(day=day, clock=clock):
                self.assertEqual(delivery_business_date({'delivery_date': day, 'delivery_time': clock}), expected)
        with self.assertRaisesRegex(ValueError, 'delivery date/time'):
            delivery_business_date({'delivery_date': '2026-11-24'})

    def test_pg_pm_pk_split_by_pdf_cutoff_date_and_keep_original_excel_dates(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            entries = [document('PG1', '2026-11-23', '12:00'), document('PG2', '2026-11-24', '07:59'),
                       document('PG3', '2026-11-24', '08:00'), document('PM1', '2026-11-23', '12:00'),
                       document('001', '2026-11-24', '07:59'), document('PM2', '2026-11-24', '08:00'),
                       document('002', '2026-11-24', '10:00')]
            save_ledger(root, {'documents': entries, 'last_used': None, 'models': {}})
            saved = generate_saved(root, root / 'unused.json', [entry['key'] for entry in entries],
                                   date_action='save', batch_id='test', now=datetime(2035, 1, 1, tzinfo=timezone.utc))
            self.assertEqual(saved['status'], 'ready')
            counts = {(entry['date'], entry['family']): entry['order_count'] for entry in saved['dates']}
            self.assertEqual(counts, {('2026-11-23', 'PG'): 2, ('2026-11-23', 'PM_PK'): 2,
                                      ('2026-11-24', 'PG'): 1, ('2026-11-24', 'PM_PK'): 2})
            for output in saved['outputs']:
                stamp = output['date']['date'].split('-')
                self.assertTrue(output['filename'].startswith(f'{stamp[2]}-{stamp[1]}-{stamp[0]}_PERODUA_'))
                self.assertEqual(output['generated_date'], '2035-01-01')
            mixed = next(output for output in saved['outputs'] if output['date']['date'] == '2026-11-23' and output['date']['family'] == 'PM_PK')
            book = load_workbook(mixed['path'])
            try:
                self.assertEqual(book.active['H2'].value.date().isoformat(), '2026-11-23')
                self.assertEqual(book.active['H3'].value.date().isoformat(), '2026-11-24')
                self.assertEqual(book.active['L3'].value.strftime('%H:%M'), '07:59')
            finally:
                book.close()
            self.assertTrue(all(entry['date_basis'] == 'delivery_cutoff_08' for entry in load_ledger(root)['dates']))

    def test_append_respects_cutoff_entry_and_preserves_its_date_on_completion(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first, before, after = document('PM1', '2026-11-23', '12:00'), document('001', '2026-11-24', '07:59'), document('002', '2026-11-24', '08:00')
            save_ledger(root, {'documents': [first, before, after], 'last_used': None, 'models': {}})
            saved = generate_saved(root, root / 'unused.json', [first['key']], date_action='save')
            identity = saved['date']['id']
            appended = generate_saved(root, root / 'unused.json', [before['key']], date_action='save', save_id=identity)
            self.assertEqual(appended['date']['family'], 'PM_PK')
            self.assertEqual(appended['date']['date'], '2026-11-23')
            before_reject = load_ledger(root)
            with self.assertRaisesRegex(ValueError, 'another date'):
                generate_saved(root, root / 'unused.json', [after['key']], date_action='save', save_id=identity)
            self.assertEqual(load_ledger(root), before_reject)
            complete = generate_saved(root, root / 'unused.json', date_action='complete', save_id=identity,
                                      now=datetime(2035, 1, 1, tzinfo=timezone.utc))
            self.assertEqual(complete['date']['date'], '2026-11-23')
            self.assertTrue(complete['filename'].startswith('23-11-2026_PERODUA_PM_PK_PO'))


if __name__ == '__main__':
    unittest.main()
