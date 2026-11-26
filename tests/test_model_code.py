from datetime import date
from io import BytesIO
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from excel_export import build_rows, get_model_no, workbook_bytes
from openpyxl import load_workbook


class ModelNoTest(unittest.TestCase):
    def test_pm_and_pk_export_the_product_as_one_total_qty_column(self):
        for pido in ['PM1', '00123']:
            for qty, boxes in [(30, 2), (15, 3), (30, 0)]:
                with self.subTest(pido=pido, qty=qty, boxes=boxes):
                    data = {'PIDO': pido, 'delivery_date': '2026-11-26', 'delivery_time': '08:50',
                            'delivery_trip': 3, 'Item': [{'back_no': 'GC G01', 'part_no': '64770-BZ460-C0',
                            'part_name': 'CARPET', 'qty_per_box': qty, 'total_box': boxes, 'total_qty': 999}]}
                    rows, _ = build_rows(data, {}, ['', '', ''])
                    book = load_workbook(BytesIO(workbook_bytes(rows)))
                    try:
                        sheet = book.active
                        headers = [cell.value for cell in sheet[1]]
                        self.assertNotIn('Qty per Box', headers)
                        self.assertNotIn('Total Box', headers)
                        self.assertEqual(headers[-3:], ['Total Qty', 'Delivery Time', 'TRIP'])
                        self.assertEqual(sheet['K2'].value, qty * boxes)
                        self.assertEqual(sheet['L2'].value.strftime('%H:%M'), '08:50')
                        self.assertEqual(sheet['M2'].value, 3)
                    finally:
                        book.close()

    def test_pk_middle_part_rule_and_excel_model(self):
        self.assertEqual(get_model_no('GC G01', '64770-BZ460-C0', '00123'), 'D66B BAD')
        self.assertEqual(get_model_no('gcg01', '64770-bz460-c0', '00123'), 'D66B BAD')
        for back, part, pido in [('GC G01', '64770-BZ060-C0', '00123'),
                                 ('GC G01', '64770-XBZ460-C0', '00123'),
                                 ('GC G01', 'BZ460', '00123'),
                                 ('GC G02', '64770-BZ460-C0', '00123'),
                                 ('GC G01', '64770-BZ460-C0', 'PM123'),
                                 ('GC G01', '64770-BZ460-C0', 'PG123')]:
            with self.subTest(back=back, part=part, pido=pido):
                self.assertEqual(get_model_no(back, part, pido), 'no model')
        data = {'PIDO': '00123', 'delivery_date': '2026-11-26', 'delivery_time': '08:50',
                'Item': [{'back_no': 'GC G01', 'part_no': '64770-BZ460-C0',
                          'part_name': 'CARPET', 'qty_per_box': 30, 'total_box': 1}]}
        rows, _ = build_rows(data, {}, ['', '', ''])
        book = load_workbook(BytesIO(workbook_bytes(rows)))
        try:
            self.assertEqual(book.active['E2'].value, 'GC G01')
            self.assertEqual(book.active['G2'].value, '00123')
            self.assertEqual(book.active['I2'].value, 'D66B BAD')
        finally:
            book.close()

    def test_default_model_no(self):
        for value in ['GCI005', 'GCI010', 'GCI501', None, '', '  ']:
            with self.subTest(back_no=value):
                self.assertEqual(get_model_no(value), 'no model')

    def test_extracted_back_no_and_layout(self):
        data = {'PIDO': 'PM1', 'delivery_date': '2026-11-18', 'delivery_time': '04:55', 'delivery_trip': 4,
                'Item': [{'back_no': 'GCI011', 'part_name': 'CARPET FLOOR', 'qty_per_box': 30, 'total_box': 2}]}
        # A saved manual mapping must never replace the PDF's extracted Back No.
        rows, _ = build_rows(data, {'GCI011': 'MD'}, ['', '', ''], 'SUGI/GC per row', today=date(2026, 11, 24))
        self.assertEqual(len(rows[0]), 13)
        book = load_workbook(BytesIO(workbook_bytes(rows)))
        try:
            sheet = book.active
            headers = [cell.value for cell in sheet[1]]
            self.assertEqual(headers.count('Back No'), 1)
            self.assertNotIn('Model', headers)
            self.assertNotIn('Model Code', headers)
            self.assertEqual(headers[4:], ['Back No', 'Destination', 'PIDO Number', 'Delivery Date',
                                          'Model No', 'Part Name', 'Total Qty', 'Delivery Time', 'TRIP'])
            self.assertEqual(sheet['E2'].value, 'GCI011')
            self.assertEqual(sheet['G2'].value, 'PM1')
            self.assertEqual(sheet['H2'].value.date().isoformat(), '2026-11-18')
            self.assertEqual(sheet['I2'].value, 'no model')
            self.assertEqual(sheet['J2'].value, 'CARPET FLOOR')
            self.assertEqual(sheet['K2'].value, 60)
            self.assertEqual(sheet['L2'].value.strftime('%H:%M'), '04:55')
            self.assertEqual(sheet['L2'].number_format, 'hh:mm')
            self.assertEqual(sheet['M1'].value, 'TRIP')
            self.assertEqual(sheet['M2'].value, 4)
            self.assertEqual(sheet['M2'].number_format, '0')
            self.assertEqual(sheet['K2'].number_format, '#,##0')
            self.assertEqual(sheet.auto_filter.ref, 'A1:M2')
            self.assertIn('$M$2', str(sheet.print_area))
            for row in sheet:
                for cell in row:
                    self.assertEqual(cell.alignment.horizontal, 'center')
                    self.assertEqual(cell.alignment.vertical, 'center')
                    for side in ['left', 'right', 'top', 'bottom']:
                        self.assertEqual(getattr(cell.border, side).style, 'thin')
        finally:
            book.close()
        # A future change to the marked function receives the extracted Back No.
        with patch('excel_export.get_model_no', side_effect=lambda back_no, part_no, pido: 'RULE FOR ' + back_no) as rule:
            changed, _ = build_rows(data, None, ['', '', ''])
            rule.assert_called_once_with('GCI011', None, 'PM1')
            self.assertEqual(changed[0][8], 'RULE FOR GCI011')


if __name__ == '__main__':
    unittest.main()
