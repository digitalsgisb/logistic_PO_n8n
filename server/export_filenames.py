"""Date-prefixed Excel names, with exclusive creation and numbered duplicates."""
from datetime import date
from pathlib import Path
import re


def dated_filename(prefix, saved_date, copy=0):
    if not re.fullmatch(r'(?:TOYOTA|PERODUA_(?:PG|PM|PK)(?:_(?:PG|PM|PK))*)', prefix):
        raise ValueError('Invalid export prefix.')
    if date.fromisoformat(saved_date).isoformat() != saved_date or not isinstance(copy, int) or copy < 0:
        raise ValueError('Invalid export date or copy number.')
    return date.fromisoformat(saved_date).strftime('%d-%m-%Y') + '_' + prefix + '_PO' + (f' ({copy})' if copy else '') + '.xlsx'


def save_unique_workbook(directory, prefix, saved_date, content):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    copy = 0
    while True:
        filename = dated_filename(prefix, saved_date, copy)
        target = directory / filename
        try:
            stream = target.open('xb')
        except FileExistsError:
            copy += 1
            continue
        try:
            with stream:
                stream.write(content)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return target
