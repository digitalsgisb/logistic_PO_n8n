from datetime import date, datetime, timezone
from io import BytesIO
from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from excel_export import build_export_rows, document_key, get_model_no, PG_HEADERS, workbook_bytes
from perodua_ordering import order_documents
from perodua_cli import generate_saved
from perodua_storage import load_ledger, save_ledger
from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell


def item(back='GCI010', middle='BZN90', name='CARPET', number=1):
    return {'number': number, 'back_no': back, 'part_no': f'58510-{middle}-C0', 'part_name': name,
            'qty_per_box': 30, 'total_box': 2, 'total_qty': 60}


def document(pido, trip, items, day='2026-11-25'):
    data = {'PIDO': pido, 'delivery_date': day, 'delivery_time': '08:50', 'delivery_trip': trip, 'Item': items}
    return {'key': document_key(data), 'source_file': pido + '.pdf', 'data': data, 'rows': None}


class PgPmExportTest(unittest.TestCase):
    def test_all_rules_require_prefix_back_and_exact_middle_segment(self):
        rules = [('PG', 'GCI010', 'BZN90', 'D24L'), ('PG', 'GCI011', 'BZL90', 'D95B'),
                 ('PG', 'GCI013', 'BZU60', 'D55L FC'), ('PG', 'GCI012', 'BZ300', 'D55L BAD'),
                 ('PG', 'GCI014', 'BY330', 'D74A'), ('PG', 'GCI005', 'BZ020', 'C. STEP'),
                 ('PM', 'GC 501', 'BZU90', 'D27A'), ('PM', 'GC601', 'BY880', 'D66B'),
                 ('PM', 'GC201', 'BZF50', 'D38L'), ('PM', 'GC602', 'BZ060', 'GC602')]
        for prefix, back, middle, expected in rules:
            with self.subTest(prefix=prefix, back=back):
                self.assertEqual(get_model_no(back.lower(), f'64770-{middle.lower()}-C0', prefix.lower() + '123'), expected)
                self.assertEqual(get_model_no(back, f'64770-X{middle}-C0', prefix + '123'), 'no model')
                self.assertEqual(get_model_no(back, f'64770-{middle}-C0', ('PM' if prefix == 'PG' else 'PG') + '123'), 'no model')
                self.assertEqual(get_model_no('OTHER', f'64770-{middle}-C0', prefix + '123'), 'no model')
        self.assertEqual(get_model_no('GC 602', 'BZ060', 'PM1'), 'no model')

    def test_pg_layout_blanks_total_qty_and_numeric_trip_and_item_order(self):
        entries = [document('PG1', 12, [item()]), document('PG20', 2, [
            item('GCI005', 'BZ020', number=10), item('GCI011', 'BZL90', number=2), item(number=1)])]
        pm, pg, serials, _ = build_export_rows(entries, ['100', '200', 'PG300'], date(2026, 11, 25))
        self.assertEqual(pm, [])
        self.assertEqual(serials, ['', '', ''])
        self.assertEqual([row[4] for row in pg], ['PG20', 'PG20', 'PG20', 'PG1'])
        self.assertEqual([row[6] for row in pg], ['GCI010', 'GCI011', 'GCI005', 'GCI010'])
        self.assertEqual([row[7] for row in pg], ['D24L', 'D95B', 'C. STEP', 'D24L'])
        self.assertEqual([row[9] for row in pg], [2, 2, 2, 12])
        book = load_workbook(BytesIO(workbook_bytes(pm, pg_rows=pg)))
        try:
            sheet = book.active
            self.assertEqual([cell.value for cell in sheet[1]], PG_HEADERS)
            self.assertEqual(sheet.max_column, 10)
            for row in range(2, 6):
                self.assertEqual([sheet.cell(row, col).value for col in range(1, 5)], [None] * 4)
                self.assertEqual(sheet['F2'].value.date().isoformat(), '2026-11-25')
                self.assertEqual(sheet.cell(row, 9).value, 60)
                for col in range(1, 11):
                    cell = sheet.cell(row, col)
                    if isinstance(cell, MergedCell):
                        continue
                    self.assertEqual(cell.alignment.horizontal, 'center')
                    self.assertEqual(cell.alignment.vertical, 'center')
                    for side in ('top', 'bottom', 'left', 'right'):
                        self.assertEqual(getattr(cell.border, side).style, 'thin')
        finally:
            book.close()

    def test_pg_document_boxes_merge_per_pido_and_keep_every_model_row(self):
        # Different PIDO numbers sharing a trip must still get separate TRIP boxes.
        entries = [document('PG1', 1, [item('GCI010', 'BZN90', number=1),
                   item('GCI011', 'BZL90', number=2), item('GCI013', 'BZU60', number=3),
                   item('GCI014', 'BY330', number=4)]),
                   document('PG2', 1, [item(number=1), item('GCI005', 'BZ020', number=2)]),
                   document('PG3', 3, [item()])]
        pm, pg, _, _ = build_export_rows(entries, ['', '', ''], date(2026, 11, 25))
        book = load_workbook(BytesIO(workbook_bytes(pm, pg_rows=pg)))
        try:
            sheet = book.active
            self.assertEqual(sheet.max_row, 8)
            expected = {f'{column}2:{column}5' for column in 'ABCDEJ'} | {f'{column}6:{column}7' for column in 'ABCDEJ'}
            self.assertEqual({str(value) for value in sheet.merged_cells.ranges}, expected | {'F2:F8'})
            self.assertEqual([sheet[f'E{row}'].value for row in range(2, 9)], ['PG1', None, None, None, 'PG2', None, 'PG3'])
            self.assertEqual([sheet[f'G{row}'].value for row in range(2, 9)],
                             ['GCI010', 'GCI011', 'GCI013', 'GCI014', 'GCI010', 'GCI005', 'GCI010'])
            self.assertEqual([sheet[f'H{row}'].value for row in range(2, 9)],
                             ['D24L', 'D95B', 'D55L FC', 'D74A', 'D24L', 'C. STEP', 'D24L'])
            self.assertEqual([sheet[f'I{row}'].value for row in range(2, 9)], [60] * 7)
            self.assertEqual([sheet[f'J{row}'].value for row in range(2, 9)], [1, None, None, None, 1, None, 3])
            for column in 'ABCDEJ':
                self.assertEqual(sheet[f'{column}2'].alignment.horizontal, 'center')
                self.assertEqual(sheet[f'{column}2'].alignment.vertical, 'center')
                self.assertEqual(sheet[f'{column}2'].border.top.style, 'thin')
                self.assertEqual(sheet[f'{column}5'].border.bottom.style, 'thin')
                for row in range(2, 6):
                    self.assertEqual(sheet[f'{column}{row}'].border.left.style, 'thin')
                    self.assertEqual(sheet[f'{column}{row}'].border.right.style, 'thin')
            for row in range(2, 9):
                self.assertEqual([sheet.cell(row, col).value for col in range(1, 5)], [None] * 4)
            self.assertEqual([row[4] for row in pg], ['PG1'] * 4 + ['PG2'] * 2 + ['PG3'])
        finally:
            book.close()

    def test_pg_date_merges_across_pidolist_but_not_across_different_dates(self):
        entries = [document('PG1', 1, [item(), item('GCI005', 'BZ020', number=2)]),
                   document('PG2', 2, [item()]),
                   document('PG3', 1, [item(), item('GCI014', 'BY330', number=2)], day='2026-11-26')]
        pm, pg, _, _ = build_export_rows(entries, ['', '', ''], date(2026, 11, 25))
        book = load_workbook(BytesIO(workbook_bytes(pm, pg_rows=pg)))
        try:
            sheet = book.active
            merged_dates = {str(value) for value in sheet.merged_cells.ranges if value.min_col == 6}
            self.assertEqual(merged_dates, {'F2:F4', 'F5:F6'})
            self.assertEqual(sheet['F2'].value.date().isoformat(), '2026-11-25')
            self.assertEqual(sheet['F5'].value.date().isoformat(), '2026-11-26')
            self.assertEqual([sheet[f'E{row}'].value for row in range(2, 7)], ['PG1', None, 'PG2', 'PG3', None])
            self.assertEqual([sheet[f'I{row}'].value for row in range(2, 7)], [60] * 5)
            self.assertEqual(sheet['F2'].alignment.horizontal, 'center')
            self.assertEqual(sheet['F2'].alignment.vertical, 'center')
            self.assertEqual(sheet['F2'].border.top.style, 'thin')
            self.assertEqual(sheet['F4'].border.bottom.style, 'thin')
        finally:
            book.close()

    def test_pm_smallest_pido_seeds_back_no_group_before_remaining_trips(self):
        entries = [document('PM10', 1, [item('GC602', 'BZ060', 'COVER')]),
                   document('PM11', 2, [item('GC 501', 'BZU90', 'DIFFERENT PART NAME')]),
                   document('PM12', 1, [item('GC201', 'BZF50', 'CARPET')]),
                   document('PM13', 3, [item('GC602', 'BZ060', 'COVER')]),
                   document('PM2', 3, [item('GC501', 'BZU90', 'CARPET')])]
        ordered = order_documents(entries)
        self.assertEqual([row['data']['PIDO'] for row in ordered], ['PM2', 'PM11', 'PM10', 'PM13', 'PM12'])
        pm, pg, serials, _ = build_export_rows(entries, ['100', '200', 'PG300'], date(2026, 11, 25))
        self.assertEqual(pg, [])
        self.assertEqual([row[13] for row in pm], [3, 2, 1, 3, 1])
        self.assertEqual([row[6] for row in pm], ['PM2', 'PM11', 'PM10', 'PM13', 'PM12'])
        self.assertEqual([row[8] for row in pm], ['D27A', 'D27A', 'GC602', 'GC602', 'D38L'])
        self.assertEqual([row[0] for row in pm], [100, 101, 102, 103, 104])
        self.assertEqual([row[3] for row in pm], ['PG300', 'PG301', 'PG302', 'PG303', 'PG304'])
        self.assertEqual(serials, ['104', '204', 'PG304'])

    def test_mixed_workbook_has_one_pg_and_one_pm_sheet(self):
        entries = [document('PG1', 1, [item()]), document('PM1', 1, [item('GC501', 'BZU90')])]
        pm, pg, _, _ = build_export_rows(entries, ['100', '200', 'PG300'], date(2026, 11, 25))
        book = load_workbook(BytesIO(workbook_bytes(pm, pg_rows=pg)))
        try:
            self.assertEqual(book.sheetnames, ['PG', 'PM'])
            self.assertEqual(book['PG']['E2'].value, 'PG1')
            self.assertIsNone(book['PG']['A2'].value)
            self.assertEqual(book['PM']['G2'].value, 'PM1')
            self.assertEqual(book['PM']['A2'].value, 100)
            self.assertEqual(book['PM']['I2'].value, 'D27A')
            self.assertEqual(book['PM'].max_column, 14)
            self.assertEqual(book['PM']['N1'].value, 'TRIP')
            self.assertEqual(book['PM']['N2'].value, 1)
        finally:
            book.close()

    def test_old_layout_upgrades_on_complete_and_reopen_sorts_new_pg_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = document('PG1', 12, [item()])
            second = document('PG2', 1, [item('GCI005', 'BZ020')])
            (root / 'state.json').write_text(json.dumps({'documents': [first, second], 'last_used': None, 'models': {}}))
            options = {'now': datetime(2026, 11, 25, 1, tzinfo=timezone.utc), 'save_date': '2026-11-25'}
            settings = root / 'unused.json'
            saved = generate_saved(root, settings, [first['key']], date_action='save', **options)
            ledger = load_ledger(root)
            ledger['exports'][0]['layout_version'] = 4
            save_ledger(root, ledger)
            old_bytes = Path(saved['path']).read_bytes()
            complete = generate_saved(root, settings, date_action='complete', **options)
            self.assertNotEqual(complete['export_id'], saved['export_id'])
            self.assertEqual(Path(saved['path']).read_bytes(), old_bytes)
            generate_saved(root, settings, date_action='reopen', **options)
            updated = generate_saved(root, settings, [second['key']], date_action='save', save_id=saved['date']['id'], **options)
            self.assertEqual([doc['pido'] for doc in updated['date']['documents']], ['PG2', 'PG1'])
            book = load_workbook(updated['path'])
            try:
                self.assertEqual(book.active['E2'].value, 'PG2')
                self.assertEqual(book.active['H2'].value, 'C. STEP')
            finally:
                book.close()


if __name__ == '__main__':
    unittest.main()
