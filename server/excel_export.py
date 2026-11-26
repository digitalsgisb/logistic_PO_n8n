"""Excel formatting and persistent serial numbers for the PDF extractor."""

from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
from uuid import uuid4
from perodua_rules import model_no, pido_family, item_number
from perodua_ordering import ordered_items


HEADERS = [
    "SUGI No", "GC No", "Current Date", "Serial No.", "Back No", "Destination",
    "PIDO Number", "Delivery Date", "Model No", "Part Name", "Total Qty",
    "Delivery Time", "TRIP",
]
WIDTHS = [13, 13, 16, 17, 15, 19, 21, 16, 20, 48, 16, 17, 12]
PG_HEADERS = ["SO.NO", "DO GC ERP", "DO SG ERP", "SERIAL NO", "PDIO NO", "DATE", "MODEL", "DESCRIPTION", "QTY", "TRIP"]
PG_WIDTHS = [14, 17, 17, 17, 21, 16, 16, 24, 15, 12]
LAYOUT_VERSION = 12


def malaysia_today():
    return datetime.now(timezone(timedelta(hours=8))).date()


def normalize_serials(values, allow_blank=False):
    serials = [str(value).strip().upper() for value in values]
    if len(serials) != 3 or not all((allow_blank and value == "") or re.fullmatch(r"[0-9]+", value) for value in serials[:2]):
        raise ValueError("SUGI No and GC No must be whole numbers, such as 123.")
    if not ((allow_blank and serials[2] == "") or re.fullmatch(r"(?:PG)?[0-9]+", serials[2])):
        raise ValueError("Serial No. must be a number or PG followed by a number, such as PG123.")
    return serials


def advance_serial(value, offset):
    if value == "":
        return ""
    match = re.fullmatch(r"(PG)?([0-9]+)", str(value).upper())
    if not match:
        raise ValueError(f"Invalid serial: {value}")
    prefix, digits = match.groups()
    return (prefix or "") + str(int(digits) + offset).zfill(len(digits))


def document_key(data):
    # Trip metadata was added later. Keep existing PO identities stable so a
    # re-upload enriches the same document instead of duplicating its quantity.
    identity_data = {key: value for key, value in data.items() if key != "delivery_trip"}
    return sha256(json.dumps(identity_data, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def get_model_no(back_no, part_no=None, pido=None):
    """PG/PM + normalized Back No + exact middle part-number segment."""
    return model_no(back_no, part_no, pido)


def build_rows(data, models, last_used, increment_mode="Once per PDF", today=None):
    if increment_mode not in {"Every item row", "Once per PDF", "SUGI/GC per row"}:
        raise ValueError("Choose how serial numbers should increase.")
    last_used = normalize_serials(last_used, allow_blank=True)
    if not data.get("Item"):
        raise ValueError("There are no items to export.")
    # The legacy models argument is ignored: Back No comes directly from the PDF.
    pido = str(data["PIDO"]).strip()
    if not pido:
        raise ValueError("PIDO is missing.")
    destination = "1045(SDY)" if pido[0].isalpha() else "1047(PK)"
    current_date = today or malaysia_today()
    delivery_date = datetime.strptime(data["delivery_date"], "%Y-%m-%d").date()
    delivery_time = datetime.strptime(data["delivery_time"], "%H:%M").time()
    rows = []
    for position, item in enumerate(data["Item"], start=1):
        back_no = str(item.get("back_no") or "").strip()
        row_offset = position if increment_mode in {"Every item row", "SUGI/GC per row"} else 1
        serial_offset = position if increment_mode == "Every item row" else 1
        rows.append([
            int(advance_serial(last_used[0], row_offset)) if last_used[0] else None,
            int(advance_serial(last_used[1], row_offset)) if last_used[1] else None,
            current_date, advance_serial(last_used[2], serial_offset) or None, back_no,
            destination, pido, delivery_date, get_model_no(back_no, item.get("part_no"), pido), item["part_name"],
            item["qty_per_box"] * item["total_box"], delivery_time, data.get("delivery_trip"),
        ])
    row_steps = len(rows) if increment_mode in {"Every item row", "SUGI/GC per row"} else 1
    serial_steps = len(rows) if increment_mode == "Every item row" else 1
    next_last = [advance_serial(last_used[0], row_steps), advance_serial(last_used[1], row_steps),
                 advance_serial(last_used[2], serial_steps)]
    return rows, next_last


def build_pg_row(data, item):
    total = item.get('total_qty')
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        raise ValueError(f"PIDO {data['PIDO']}: Total QTY is missing or invalid.")
    return [None, None, None, None, str(data['PIDO']).strip(),
            datetime.strptime(data['delivery_date'], '%Y-%m-%d').date(),
            str(item.get('back_no') or '').strip(),
            get_model_no(item.get('back_no'), item.get('part_no'), data['PIDO']),
            total, data.get('delivery_trip')]


def build_export_rows(documents, serials, today):
    """Allocate numbers only to PM/legacy rows, after applying the final row order."""
    pg_rows, pm_rows, rows_by_key = [], [], {entry['key']: [] for entry in documents}
    last_used = [advance_serial(value, -1) for value in serials]
    serial_for_po = {}
    for entry, item in ordered_items(documents):
        data, key = entry['data'], entry['key']
        if pido_family(data['PIDO']) == 'PG':
            row = build_pg_row(data, item)
            pg_rows.append(row)
        else:
            # build_rows is also retained for callers of the old PM writer.
            row = build_rows({**data, 'Item': [item]}, {}, ['', '', ''], 'SUGI/GC per row', today=today)[0][0]
            for column in (0, 1):
                last_used[column] = advance_serial(last_used[column], 1)
                row[column] = int(last_used[column]) if last_used[column] else None
            if key not in serial_for_po:
                last_used[2] = advance_serial(last_used[2], 1)
                serial_for_po[key] = last_used[2] or None
            row[3] = serial_for_po[key]
            pm_rows.append(row)
        rows_by_key[key].append(row)
    return pm_rows, pg_rows, last_used if pm_rows else ['', '', ''], rows_by_key


def workbook_bytes(rows, pg_rows=None):
    try:
        from openpyxl import Workbook
    except ImportError as error:
        raise ValueError("Install Excel support first: py -m pip install openpyxl") from error
    wb = Workbook()
    wb.remove(wb.active)
    if pg_rows:
        _write_sheet(wb, 'PG' if rows else 'Delivery', pg_rows, pg=True)
    if rows or not pg_rows:
        _write_sheet(wb, 'PM' if pg_rows else 'Delivery', rows, pg=False)
    stream = BytesIO()
    wb.save(stream)
    return stream.getvalue()


def _write_sheet(wb, title, rows, pg=False):
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    headers, widths = (PG_HEADERS, PG_WIDTHS) if pg else (HEADERS, WIDTHS)
    sheet = wb.create_sheet(title)
    sheet.sheet_view.showGridLines = False
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    for cell in sheet[1]:
        cell.font = Font(name='Arial', size=10, bold=True, color='FFFFFF')
        cell.fill = PatternFill('solid', fgColor='17365D')
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    sheet.row_dimensions[1].height = 32
    for column, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(column)].width = width
    for row in sheet.iter_rows(min_row=2):
        sheet.row_dimensions[row[0].row].height = 35
        for cell in row:
            cell.font = Font(name='Arial', size=10)
            cell.alignment = Alignment(vertical='center', horizontal='center')
            if isinstance(cell.value, str):
                cell.data_type = 's'
            if cell.row % 2 == 0:
                cell.fill = PatternFill('solid', fgColor='EDF3F8')
        if pg:
            row[4].number_format = '@'
            row[5].number_format = 'dd/mm/yyyy'
            row[7].alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
            row[8].number_format = '#,##0'
            row[9].number_format = '0'
        else:
            for index in (0, 1, 10):
                row[index].number_format = '0' if index in (0, 1) else '#,##0'
            for index in (2, 7):
                row[index].number_format = 'dd/mm/yyyy'
            row[3].number_format = '@'
            row[6].number_format = '@'
            row[9].alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
            row[11].number_format = 'hh:mm'
            row[12].number_format = '0'
    edge = Side(style='thin', color='000000')
    grid = Border(left=edge, right=edge, top=edge, bottom=edge)
    for row in sheet.iter_rows():
        for cell in row:
            cell.border = grid
    sheet.freeze_panes = 'A2' if pg else 'C2'
    last_column = get_column_letter(len(headers))
    sheet.auto_filter.ref = f'A1:{last_column}{sheet.max_row}'
    # Each PG PO shares one vertically merged box per document-level column.
    # Empty A:D cells are grouped by PIDO, never by their shared blank value.
    if pg:
        start = 2
        while start <= sheet.max_row:
            group = tuple(sheet.cell(start, column).value for column in (5, 6, 10))
            end = start
            while end < sheet.max_row and tuple(sheet.cell(end + 1, column).value for column in (5, 6, 10)) == group:
                end += 1
            if group[0] is not None and end > start:
                for column in (1, 2, 3, 4, 5, 10):
                    sheet.merge_cells(start_row=start, start_column=column, end_row=end, end_column=column)
                    for row_number in range(start, end + 1):
                        sheet.cell(row_number, column).fill = PatternFill('solid', fgColor='FFFFFF')
                    sheet.cell(start, column).alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
            start = end + 1
    # PG dates merge across POs sharing a delivery date; PM keeps its existing layout.
    for column in ((6,) if pg else (3, 6, 8)):
        start = 2
        while start <= sheet.max_row:
            value = sheet.cell(start, column).value
            end = start
            while end < sheet.max_row and sheet.cell(end + 1, column).value == value:
                end += 1
            if value is not None and end > start:
                sheet.merge_cells(start_row=start, start_column=column, end_row=end, end_column=column)
                for row_number in range(start, end + 1):
                    sheet.cell(row_number, column).fill = PatternFill('solid', fgColor='FFFFFF')
            sheet.cell(start, column).alignment = Alignment(horizontal='center', vertical='center')
            start = end + 1
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = 'landscape'
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.print_title_rows = '1:1'
    sheet.print_area = f'A1:{last_column}{sheet.max_row}'
